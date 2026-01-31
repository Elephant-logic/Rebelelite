// REBEL MESSENGER / STREAM HOST APP
// =================================
// Host-side logic for room + role management, stream mixing, calling,
// viewer broadcast, chat, arcade file push, and HTML overlay engine.

// ======================================================
// SIGNALING MAP (Current Behavior - No Changes)
// ======================================================
// [HOST]  -> (join-room)        -> [SERVER]
// [VIEWER]-> (join-room)        -> [SERVER]
// [HOST]  -> (webrtc-offer)     -> [SERVER] -> [VIEWER]
// [VIEWER]-> (webrtc-answer)    -> [SERVER] -> [HOST]
// [HOST]  -> (ice-candidate)    -> [SERVER] -> [VIEWER]
// [VIEWER]-> (ice-candidate)    -> [SERVER] -> [HOST]
// (Call mode uses call-offer/call-answer/call-ice in the same relay pattern.)

// ======================================================
// WEBRTC HANDSHAKE FLOW (Host Broadcast - Existing Order)
// ======================================================
// 1) Host joins room (join-room) and becomes owner.
// 2) Host starts local cam/mic and mixer canvas.
// 3) Viewer joins room (join-room).
// 4) Server relays host offer -> viewer.
// 5) Viewer returns answer -> host.
// 6) ICE candidates are exchanged both directions.
// 7) PeerConnection becomes connected.
// 8) Viewer displays mixed canvas stream.

// ======================================================
// 1. ARCADE ENGINE (P2P File Transfer)
// ======================================================
const CHUNK_SIZE = 16 * 1024; // 16KB chunks (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Buffer limit to prevent crashes

async function pushFileToPeer(pc, file, onProgress) {
  if (!pc) return;

  const channel = pc.createDataChannel('side-load-pipe');

  channel.onopen = async () => {
    console.log(`[Arcade] Starting transfer of: ${file.name}`);

    const metadata = JSON.stringify({
      type: 'meta',
      name: file.name,
      size: file.size,
      mime: file.type
    });
    channel.send(metadata);

    const buffer = await file.arrayBuffer();
    let offset = 0;

    const sendLoop = () => {
      if (channel.bufferedAmount > MAX_BUFFER) {
        setTimeout(sendLoop, 10);
        return;
      }

      if (channel.readyState !== 'open') {
        return;
      }

      const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
      channel.send(chunk);
      offset += CHUNK_SIZE;

      if (onProgress) {
        const percent = Math.min(100, Math.round((offset / file.size) * 100));
        onProgress(percent);
      }

      if (offset < buffer.byteLength) {
        setTimeout(sendLoop, 0);
      } else {
        console.log('[Arcade] Transfer Complete.');
        setTimeout(() => {
          channel.close();
        }, 1000);
      }
    };

    sendLoop();
  };
}

// ======================================================
// 2. MAIN APP SETUP & VARIABLES
// ======================================================
console.log('Rebel Stream Host App Loaded');

const socket = io({ autoConnect: false });
const $ = (id) => document.getElementById(id);

const state = {
  currentRoom: null,
  userName: 'User',
  myId: null,
  iAmHost: false,
  wasHost: false,
  joined: false,
  latestUserList: [],
  currentOwnerId: null,
  isPrivateMode: false,
  allowedGuests: [],
  mutedUsers: new Set(),
  localStream: null,
  screenStream: null,
  isScreenSharing: false,
  isStreaming: false,
  activeToolboxFile: null,
  audioContext: null,
  audioDestination: null,
  audioAnalysers: {},
  mixerLayout: 'SOLO',
  activeGuestId: null,
  overlayActive: false,
  overlayImage: new Image(),
  currentRawHTML: '',
  overlayFields: [],
  overlayFieldValues: {},
  overlayObjectUrls: {},
  overlayContainer: null,
  overlayVideoElements: [],
  overlayRenderCount: 0,
  vipUsers: [],
  vipCodes: [],
  vipRequired: false,
  turnConfig: {
    enabled: false,
    host: '',
    port: '',
    tlsPort: '',
    username: '',
    password: ''
  }
};

const viewerPeers = {};
const callPeers = {};

function getRtcConfig() {
  return { iceServers: getIceServers(state.turnConfig) };
}

function logSelectedCandidate(label, report) {
  if (!report) return;
  const candidateType = report.candidateType || report.type;
  const transport = report.protocol || report.transport;
  if (!candidateType || !transport) return;
  console.log(`[WebRTC] ${label} selected candidate: ${candidateType} (${transport})`);
}

function attachCandidateDiagnostics(pc, label) {
  let logged = false;
  const attemptLog = async () => {
    if (logged) return;
    if (!['connected', 'completed'].includes(pc.iceConnectionState)) return;
    const stats = await pc.getStats();
    let selectedPair = null;
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.selected) {
        selectedPair = report;
      }
    });
    if (!selectedPair) {
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          stats.forEach((pair) => {
            if (pair.id === report.selectedCandidatePairId) {
              selectedPair = pair;
            }
          });
        }
      });
    }
    if (!selectedPair) return;
    let localCandidate = null;
    stats.forEach((report) => {
      if (report.id === selectedPair.localCandidateId) {
        localCandidate = report;
      }
    });
    if (localCandidate) {
      logSelectedCandidate(label, localCandidate);
      logged = true;
    }
  };
  pc.addEventListener('iceconnectionstatechange', attemptLog);
  pc.addEventListener('connectionstatechange', attemptLog);
}

const dom = {
  previewModal: $('streamPreviewModal'),
  previewVideo: $('streamPreviewVideo'),
  previewBtn: $('previewStreamBtn'),
  closePreviewBtn: $('closePreviewBtn'),
  tabStream: $('tabStreamChat'),
  tabRoom: $('tabRoomChat'),
  tabFiles: $('tabFiles'),
  tabUsers: $('tabUsers'),
  contentStream: $('contentStreamChat'),
  contentRoom: $('contentRoomChat'),
  contentFiles: $('contentFiles'),
  contentUsers: $('contentUsers'),
  settingsPanel: $('settingsPanel'),
  audioSource: $('audioSource'),
  audioSource2: $('audioSource2'),
  videoSource: $('videoSource'),
  videoQuality: $('videoQuality'),
  shareScreenBtn: $('shareScreenBtn'),
  startStreamBtn: $('startStreamBtn'),
  hangupBtn: $('hangupBtn'),
  joinBtn: $('joinBtn'),
  leaveBtn: $('leaveBtn'),
  streamTitleInput: $('streamTitleInput'),
  updateTitleBtn: $('updateTitleBtn'),
  updateSlugBtn: $('updateSlugBtn'),
  slugInput: $('slugInput'),
  publicRoomToggle: $('publicRoomToggle'),
  togglePrivateBtn: $('togglePrivateBtn'),
  addGuestBtn: $('addGuestBtn'),
  guestNameInput: $('guestNameInput'),
  guestListPanel: $('guestListPanel'),
  guestListDisplay: $('guestListDisplay'),
  vipUserInput: $('vipUserInput'),
  addVipUserBtn: $('addVipUserBtn'),
  vipUserList: $('vipUserList'),
  generateVipCodeBtn: $('generateVipCodeBtn'),
  vipCodeUses: $('vipCodeUses'),
  vipCodeList: $('vipCodeList'),
  vipStatus: $('vipStatus'),
  paymentEnableToggle: $('paymentEnableToggle'),
  paymentLabelInput: $('paymentLabelInput'),
  paymentUrlInput: $('paymentUrlInput'),
  paymentSaveBtn: $('paymentSaveBtn'),
  paymentStatus: $('paymentStatus'),
  turnEnableToggle: $('turnEnableToggle'),
  turnAdvanced: $('turnAdvanced'),
  turnHostInput: $('turnHostInput'),
  turnPortInput: $('turnPortInput'),
  turnTlsPortInput: $('turnTlsPortInput'),
  turnUsernameInput: $('turnUsernameInput'),
  turnPasswordInput: $('turnPasswordInput'),
  turnSaveBtn: $('turnSaveBtn'),
  turnStatus: $('turnStatus'),
  btnSendPublic: $('btnSendPublic'),
  inputPublic: $('inputPublic'),
  btnSendPrivate: $('btnSendPrivate'),
  inputPrivate: $('inputPrivate'),
  emojiStripPublic: $('emojiStripPublic'),
  emojiStripPrivate: $('emojiStripPrivate'),
  fileInput: $('fileInput'),
  fileNameLabel: $('fileNameLabel'),
  sendFileBtn: $('sendFileBtn'),
  fileLog: $('fileLog'),
  chatLogPublic: $('chatLogPublic'),
  chatLogPrivate: $('chatLogPrivate'),
  userList: $('userList'),
  roomInput: $('roomInput'),
  nameInput: $('nameInput'),
  localVideo: $('localVideo'),
  headerTitle: $('headerTitle'),
  toggleCamBtn: $('toggleCamBtn'),
  toggleMicBtn: $('toggleMicBtn'),
  signalStatus: $('signalStatus'),
  roomInfo: $('roomInfo'),
  settingsBtn: $('settingsBtn'),
  closeSettingsBtn: $('closeSettingsBtn'),
  hostControls: $('hostControls'),
  vipRequiredToggle: $('vipRequiredToggle'),
  streamLinkInput: $('streamLinkInput'),
  openStreamBtn: $('openStreamBtn'),
  htmlOverlayInput: $('htmlOverlayInput'),
  overlayFields: $('overlayFields'),
  overlayStatus: $('overlayStatus'),
  arcadeInput: $('arcadeInput'),
  arcadeStatus: $('arcadeStatus')
};

// ======================================================
// 3. HELPER: AUTO-SCROLL CHAT TO BOTTOM
// ======================================================
function scrollChatToBottom(chatLogElement) {
  if (!chatLogElement) return;
  // Smooth scroll to bottom
  chatLogElement.scrollTop = chatLogElement.scrollHeight;
}

// ======================================================
// 4. HELPER: DISPLAY CHAT MESSAGE
// ======================================================
function displayChatMessage(logEl, userName, message) {
  if (!logEl) return;
  const line = document.createElement('div');
  line.className = 'chat-line';

  const strong = document.createElement('strong');
  strong.textContent = userName + ': ';
  line.appendChild(strong);

  const span = document.createElement('span');
  span.textContent = message;
  line.appendChild(span);

  logEl.appendChild(line);
  
  // Auto-scroll after adding message
  scrollChatToBottom(logEl);
}

// ======================================================
// 5. SOCKET CONNECTION & SIGNALING
// ======================================================
socket.on('connect', () => {
  console.log('[Socket] Connected:', socket.id);
  state.myId = socket.id;
  if (dom.signalStatus) {
    dom.signalStatus.textContent = 'Connected';
    dom.signalStatus.className = 'status-dot status-connected';
  }
});

socket.on('disconnect', () => {
  console.log('[Socket] Disconnected');
  if (dom.signalStatus) {
    dom.signalStatus.textContent = 'Disconnected';
    dom.signalStatus.className = 'status-dot status-disconnected';
  }
  state.joined = false;
  state.iAmHost = false;
  if (dom.leaveBtn) dom.leaveBtn.disabled = true;
  if (dom.joinBtn) dom.joinBtn.disabled = false;
});

socket.on('error-message', (msg) => {
  console.error('[Server Error]', msg);
  alert(msg);
});

socket.on('join-ack', (data) => {
  console.log('[join-ack]', data);
  state.joined = true;
  state.currentRoom = data.room;
  state.currentOwnerId = data.ownerId;
  state.iAmHost = data.ownerId === state.myId;
  state.isPrivateMode = !!data.isPrivate;
  state.allowedGuests = data.allowedGuests || [];
  state.vipUsers = data.vipUsers || [];
  state.vipCodes = data.vipCodes || [];
  state.vipRequired = !!data.vipRequired;

  if (dom.roomInfo) {
    dom.roomInfo.textContent = `Room: ${state.currentRoom} (${state.iAmHost ? 'Host' : 'Guest'})`;
  }

  if (state.iAmHost) {
    state.wasHost = true;
    if (dom.hostControls) dom.hostControls.style.display = 'block';
    if (data.streamTitle && dom.streamTitleInput) {
      dom.streamTitleInput.value = data.streamTitle;
    }
    if (data.slug && dom.slugInput) {
      dom.slugInput.value = data.slug;
    }
    if (dom.publicRoomToggle) {
      dom.publicRoomToggle.checked = data.isPublic !== false;
    }
    updatePrivacyControlAvailability();
    updateVipDisplay();
    displayPaymentSettings(data.payment);
    displayTurnSettings(data.turn);
  }

  if (dom.joinBtn) dom.joinBtn.disabled = true;
  if (dom.leaveBtn) dom.leaveBtn.disabled = false;

  if (!state.localStream) startLocalMedia();

  const encodedRoom = encodeURIComponent(state.currentRoom);
  let link = `${window.location.origin}/view.html?room=${encodedRoom}`;
  if (data.slug) {
    link = `${window.location.origin}/view.html?room=${encodeURIComponent(data.slug)}`;
  }
  if (dom.streamLinkInput) {
    dom.streamLinkInput.value = link;
    generateQRCode(link);
  }
});

function generateQRCode(url) {
  const qrContainer = $('qrcode');
  if (!qrContainer) return;
  qrContainer.innerHTML = '';
  try {
    new QRCode(qrContainer, {
      text: url,
      width: 100,
      height: 100,
      colorDark: '#000',
      colorLight: '#fff'
    });
  } catch (e) {
    console.error('[QRCode] Error:', e);
  }
}

socket.on('room-update', (data) => {
  console.log('[room-update]', data);
  state.latestUserList = data.users || [];
  state.currentOwnerId = data.ownerId;
  state.iAmHost = data.ownerId === state.myId;
  state.isPrivateMode = !!data.isPrivate;
  state.allowedGuests = data.allowedGuests || [];
  state.vipUsers = data.vipUsers || [];
  state.vipCodes = data.vipCodes || [];
  state.vipRequired = !!data.vipRequired;

  if (state.iAmHost && !state.wasHost) {
    state.wasHost = true;
    if (dom.hostControls) dom.hostControls.style.display = 'block';
    if (data.streamTitle && dom.streamTitleInput) {
      dom.streamTitleInput.value = data.streamTitle;
    }
    if (data.slug && dom.slugInput) {
      dom.slugInput.value = data.slug;
    }
    if (dom.publicRoomToggle) {
      dom.publicRoomToggle.checked = data.isPublic !== false;
    }
    updatePrivacyControlAvailability();
    updateVipDisplay();
    displayPaymentSettings(data.payment);
    displayTurnSettings(data.turn);
  }

  if (dom.roomInfo) {
    dom.roomInfo.textContent = `Room: ${state.currentRoom} (${state.iAmHost ? 'Host' : 'Guest'})`;
  }

  renderUserList();
  maybeAutoStartBroadcast();
  updateUserStats();
});

// ======================================================
// 6. CHAT HANDLERS (FIXED WITH AUTO-SCROLL)
// ======================================================
socket.on('chat-public', (data) => {
  displayChatMessage(dom.chatLogPublic, data.user, data.message);
  
  // Show notification if not on stream tab
  if (dom.tabStream && !dom.tabStream.classList.contains('active')) {
    dom.tabStream.classList.add('has-new');
  }
});

socket.on('chat-private', (data) => {
  displayChatMessage(dom.chatLogPrivate, data.user, data.message);
  
  // Show notification if not on room tab
  if (dom.tabRoom && !dom.tabRoom.classList.contains('active')) {
    dom.tabRoom.classList.add('has-new');
  }
});

// Send Public Chat
if (dom.btnSendPublic) {
  const sendPublic = () => {
    const msg = dom.inputPublic.value.trim();
    if (!msg) return;
    socket.emit('chat-public', msg);
    dom.inputPublic.value = ''; // Clear input after sending
    displayChatMessage(dom.chatLogPublic, state.userName, msg);
  };

  dom.btnSendPublic.onclick = sendPublic;
  dom.inputPublic.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendPublic();
  });
}

// Send Private Chat
if (dom.btnSendPrivate) {
  const sendPrivate = () => {
    const msg = dom.inputPrivate.value.trim();
    if (!msg) return;
    socket.emit('chat-private', msg);
    dom.inputPrivate.value = ''; // Clear input after sending
    displayChatMessage(dom.chatLogPrivate, state.userName, msg);
  };

  dom.btnSendPrivate.onclick = sendPrivate;
  dom.inputPrivate.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendPrivate();
  });
}

// Emoji Strips (FIXED: Now scrolls after adding emoji)
if (dom.emojiStripPublic) {
  dom.emojiStripPublic.querySelectorAll('.emoji').forEach((emojiEl) => {
    emojiEl.onclick = () => {
      if (!dom.inputPublic) return;
      dom.inputPublic.value += emojiEl.textContent;
      dom.inputPublic.focus();
    };
  });
}

if (dom.emojiStripPrivate) {
  dom.emojiStripPrivate.querySelectorAll('.emoji').forEach((emojiEl) => {
    emojiEl.onclick = () => {
      if (!dom.inputPrivate) return;
      dom.inputPrivate.value += emojiEl.textContent;
      dom.inputPrivate.focus();
    };
  });
}

// ======================================================
// 7. TAB SWITCHING
// ======================================================
function switchTab(tabName) {
  const tabs = { tabStreamChat: 'contentStreamChat', tabRoomChat: 'contentRoomChat', tabFiles: 'contentFiles', tabUsers: 'contentUsers' };
  
  Object.keys(tabs).forEach((tabId) => {
    const btn = $(tabId);
    const content = $(tabs[tabId]);
    if (btn && content) {
      if (tabId === tabName) {
        btn.classList.add('active');
        btn.classList.remove('has-new'); // Remove notification badge
        content.classList.add('active');
      } else {
        btn.classList.remove('active');
        content.classList.remove('active');
      }
    }
  });
}

if (dom.tabStream) dom.tabStream.onclick = () => switchTab('tabStreamChat');
if (dom.tabRoom) dom.tabRoom.onclick = () => switchTab('tabRoomChat');
if (dom.tabFiles) dom.tabFiles.onclick = () => switchTab('tabFiles');
if (dom.tabUsers) dom.tabUsers.onclick = () => switchTab('tabUsers');

// ======================================================
// 8. JOIN & LEAVE
// ======================================================
if (dom.joinBtn) {
  dom.joinBtn.onclick = () => {
    const roomName = dom.roomInput.value.trim();
    const userName = dom.nameInput.value.trim();
    if (!roomName || !userName) {
      alert('Room and Name required.');
      return;
    }

    state.userName = userName;
    state.currentRoom = roomName;

    const params = new URLSearchParams(window.location.search);
    const role = params.get('role') || 'guest';
    const authed = params.get('authed');

    const passwordKey = `hostPassword:${roomName}`;
    let password = '';

    if (role === 'host') {
      password = sessionStorage.getItem(passwordKey) || '';
      if (!password && !authed) {
        const promptPw = prompt('Enter room host password (or leave blank if not set):');
        if (promptPw !== null) {
          password = promptPw.trim();
        }
      }
    }

    socket.connect();
    socket.emit('join-room', { room: roomName, name: userName, role, password });
  };
}

if (dom.leaveBtn) {
  dom.leaveBtn.onclick = () => {
    if (!state.joined) return;
    socket.emit('leave-room');
    socket.disconnect();
    state.joined = false;
    state.iAmHost = false;
    if (dom.leaveBtn) dom.leaveBtn.disabled = true;
    if (dom.joinBtn) dom.joinBtn.disabled = false;
    if (dom.hostControls) dom.hostControls.style.display = 'none';
  };
}

// ======================================================
// 9. MEDIA SETUP
// ======================================================
async function startLocalMedia() {
  try {
    const constraints = getStreamConstraints();
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (dom.localVideo) dom.localVideo.srcObject = state.localStream;
    populateDeviceSelectors();
  } catch (err) {
    console.error('[Media Error]', err);
    alert('Could not access camera/mic. Please allow access and reload.');
  }
}

function getStreamConstraints() {
  const qualityPresets = {
    ideal: { width: { ideal: 1280 }, height: { ideal: 720 } },
    max: { width: { ideal: 1920 }, height: { ideal: 1080 } },
    low: { width: { ideal: 640 }, height: { ideal: 360 } }
  };

  const quality = dom.videoQuality ? dom.videoQuality.value : 'ideal';
  const videoRes = qualityPresets[quality] || qualityPresets.ideal;

  const constraints = {
    video: { ...videoRes },
    audio: { echoCancellation: true, noiseSuppression: true }
  };

  if (dom.videoSource && dom.videoSource.value) {
    constraints.video.deviceId = { exact: dom.videoSource.value };
  }
  if (dom.audioSource && dom.audioSource.value) {
    constraints.audio.deviceId = { exact: dom.audioSource.value };
  }

  return constraints;
}

async function populateDeviceSelectors() {
  const devices = await navigator.mediaDevices.enumerateDevices();

  if (dom.videoSource) {
    dom.videoSource.innerHTML = '';
    devices.filter(d => d.kind === 'videoinput').forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${dom.videoSource.options.length + 1}`;
      dom.videoSource.appendChild(opt);
    });
  }

  if (dom.audioSource) {
    dom.audioSource.innerHTML = '';
    devices.filter(d => d.kind === 'audioinput').forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mic ${dom.audioSource.options.length + 1}`;
      dom.audioSource.appendChild(opt);
    });
  }

  if (dom.audioSource2) {
    const hasOptions = dom.audioSource2.querySelector('option[value=""]');
    if (!hasOptions) {
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '-- None --';
      dom.audioSource2.appendChild(noneOpt);
    }

    devices.filter(d => d.kind === 'audioinput').forEach(d => {
      const existing = Array.from(dom.audioSource2.options).find(opt => opt.value === d.deviceId);
      if (!existing) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Mic ${dom.audioSource2.options.length}`;
        dom.audioSource2.appendChild(opt);
      }
    });
  }
}

if (dom.settingsBtn) {
  dom.settingsBtn.onclick = () => {
    if (dom.settingsPanel) {
      dom.settingsPanel.style.display = dom.settingsPanel.style.display === 'none' ? 'block' : 'none';
    }
  };
}

if (dom.closeSettingsBtn) {
  dom.closeSettingsBtn.onclick = () => {
    if (dom.settingsPanel) dom.settingsPanel.style.display = 'none';
  };
}

if (dom.videoQuality) {
  dom.videoQuality.onchange = async () => {
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
    }
    await startLocalMedia();
  };
}

if (dom.videoSource) {
  dom.videoSource.onchange = async () => {
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
    }
    await startLocalMedia();
  };
}

if (dom.audioSource) {
  dom.audioSource.onchange = async () => {
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
    }
    await startLocalMedia();
  };
}

if (dom.toggleCamBtn) {
  dom.toggleCamBtn.onclick = () => {
    if (!state.localStream) return;
    const videoTrack = state.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      dom.toggleCamBtn.textContent = videoTrack.enabled ? 'Camera Off' : 'Camera On';
    }
  };
}

if (dom.toggleMicBtn) {
  dom.toggleMicBtn.onclick = () => {
    if (!state.localStream) return;
    const audioTrack = state.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      dom.toggleMicBtn.textContent = audioTrack.enabled ? 'Mute' : 'Unmute';
    }
  };
}

// ======================================================
// 10. SCREEN SHARE
// ======================================================
if (dom.shareScreenBtn) {
  dom.shareScreenBtn.onclick = async () => {
    if (state.isScreenSharing) {
      if (state.screenStream) {
        state.screenStream.getTracks().forEach(t => t.stop());
        state.screenStream = null;
      }
      state.isScreenSharing = false;
      dom.shareScreenBtn.textContent = 'Share Screen';
      return;
    }

    try {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      state.screenStream.getVideoTracks()[0].onended = () => {
        state.screenStream = null;
        state.isScreenSharing = false;
        dom.shareScreenBtn.textContent = 'Share Screen';
      };
      state.isScreenSharing = true;
      dom.shareScreenBtn.textContent = 'Stop Sharing';
    } catch (err) {
      console.error('[ScreenShare Error]', err);
    }
  };
}

// ======================================================
// 11. STREAM BROADCAST (TO VIEWERS)
// ======================================================
if (dom.startStreamBtn) {
  dom.startStreamBtn.onclick = async () => {
    if (state.isStreaming) {
      stopAllViewerBroadcasts();
      state.isStreaming = false;
      dom.startStreamBtn.textContent = 'Start Stream';
      return;
    }

    if (!state.localStream) {
      alert('No local stream. Please allow camera/mic first.');
      return;
    }

    await startCanvasMixerLoop();
    state.isStreaming = true;
    dom.startStreamBtn.textContent = 'Stop Stream';
    dom.startStreamBtn.classList.remove('primary');
    dom.startStreamBtn.classList.add('danger');
  };
}

function stopAllViewerBroadcasts() {
  Object.keys(viewerPeers).forEach(id => {
    const p = viewerPeers[id];
    if (p) p.close();
    delete viewerPeers[id];
  });
  if (dom.startStreamBtn) {
    dom.startStreamBtn.classList.remove('danger');
    dom.startStreamBtn.classList.add('primary');
  }
}

// ======================================================
// 12. WEBRTC BROADCAST (OFFER -> VIEWER)
// ======================================================
socket.on('viewer-join', async (data) => {
  console.log('[viewer-join]', data.socketId);
  if (!state.isStreaming) return;
  await createViewerPeer(data.socketId);
});

async function createViewerPeer(viewerId) {
  const pc = new RTCPeerConnection(getRtcConfig());
  viewerPeers[viewerId] = pc;

  attachCandidateDiagnostics(pc, `Viewer ${viewerId}`);

  if (state.mixerCanvasStream) {
    state.mixerCanvasStream.getTracks().forEach(t => pc.addTrack(t, state.mixerCanvasStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { to: viewerId, candidate: e.candidate });
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { to: viewerId, offer: pc.localDescription });
    } catch (err) {
      console.error('[WebRTC] Offer error:', err);
    }
  };

  socket.on('webrtc-answer', async (data) => {
    if (data.from !== viewerId) return;
    try {
      await pc.setRemoteDescription(data.answer);
    } catch (err) {
      console.error('[WebRTC] Answer error:', err);
    }
  });

  socket.on('ice-candidate', (data) => {
    if (data.from !== viewerId) return;
    if (data.candidate) {
      pc.addIceCandidate(data.candidate).catch(e => console.error('[ICE Error]', e));
    }
  });
}

socket.on('viewer-left', (data) => {
  console.log('[viewer-left]', data.socketId);
  const pc = viewerPeers[data.socketId];
  if (pc) {
    pc.close();
    delete viewerPeers[data.socketId];
  }
});

// ======================================================
// 13. CALL MODE (PEER-TO-PEER WITH GUESTS)
// ======================================================
socket.on('call-offer', async (data) => {
  console.log('[call-offer] from', data.from);
  const pc = new RTCPeerConnection(getRtcConfig());
  callPeers[data.from] = pc;

  attachCandidateDiagnostics(pc, `Call ${data.from}`);

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  }

  pc.ontrack = (e) => {
    console.log('[call] ontrack', e.streams[0]);
    callPeers[data.from].stream = e.streams[0];
    callPeers[data.from].name = state.latestUserList.find(u => u.id === data.from)?.name || 'Guest';
    addRemoteVideo(data.from, e.streams[0]);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('call-ice', { to: data.from, candidate: e.candidate });
    }
  };

  try {
    await pc.setRemoteDescription(data.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call-answer', { to: data.from, answer: pc.localDescription });
  } catch (err) {
    console.error('[Call] Error handling offer:', err);
  }

  socket.on('call-ice', (iceData) => {
    if (iceData.from === data.from && iceData.candidate) {
      pc.addIceCandidate(iceData.candidate).catch(e => console.error('[Call ICE Error]', e));
    }
  });
});

socket.on('call-answer', async (data) => {
  console.log('[call-answer] from', data.from);
  const pc = callPeers[data.from];
  if (!pc) return;
  try {
    await pc.setRemoteDescription(data.answer);
  } catch (err) {
    console.error('[Call] Error setting answer:', err);
  }
});

socket.on('call-ice', (data) => {
  const pc = callPeers[data.from];
  if (pc && data.candidate) {
    pc.addIceCandidate(data.candidate).catch(e => console.error('[Call ICE Error]', e));
  }
});

socket.on('ring-you', async (data) => {
  console.log('[ring-you]', data.from);
  const confirmCall = confirm(`${data.fromName} is calling you. Accept?`);
  if (!confirmCall) return;

  const pc = new RTCPeerConnection(getRtcConfig());
  callPeers[data.from] = pc;

  attachCandidateDiagnostics(pc, `Call ${data.from}`);

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
  }

  pc.ontrack = (e) => {
    console.log('[call] ontrack', e.streams[0]);
    callPeers[data.from].stream = e.streams[0];
    callPeers[data.from].name = data.fromName;
    addRemoteVideo(data.from, e.streams[0]);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('call-ice', { to: data.from, candidate: e.candidate });
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call-offer', { to: data.from, offer: pc.localDescription });
  } catch (err) {
    console.error('[Call] Error creating offer:', err);
  }

  socket.on('call-ice', (iceData) => {
    if (iceData.from === data.from && iceData.candidate) {
      pc.addIceCandidate(iceData.candidate).catch(e => console.error('[Call ICE Error]', e));
    }
  });
});

socket.on('end-call', (data) => {
  console.log('[end-call] from', data.from);
  endPeerCall(data.from);
});

function endPeerCall(peerId) {
  const pc = callPeers[peerId];
  if (!pc) return;
  pc.close();
  delete callPeers[peerId];
  removeRemoteVideo(peerId);
  socket.emit('end-call', { to: peerId });
  renderUserList();
}

if (dom.hangupBtn) {
  dom.hangupBtn.onclick = () => {
    Object.keys(callPeers).forEach(id => endPeerCall(id));
  };
}

// ======================================================
// 14. CANVAS MIXER (LAYOUTS: SOLO, GUEST, PIP, SPLIT, etc.)
// ======================================================
let mixerCanvas = null;
let mixerCanvasStream = null;
let mixerInterval = null;

async function startCanvasMixerLoop() {
  if (!mixerCanvas) {
    mixerCanvas = document.createElement('canvas');
    mixerCanvas.width = 1280;
    mixerCanvas.height = 720;
  }

  const ctx = mixerCanvas.getContext('2d');

  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    state.audioDestination = state.audioContext.createMediaStreamDestination();
  }

  mixerCanvasStream = mixerCanvas.captureStream(30);

  if (state.localStream) {
    const localAudio = state.localStream.getAudioTracks()[0];
    if (localAudio) {
      const source = state.audioContext.createMediaStreamSource(new MediaStream([localAudio]));
      source.connect(state.audioDestination);
    }
  }

  if (dom.audioSource2 && dom.audioSource2.value) {
    try {
      const secondaryStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: dom.audioSource2.value } }
      });
      const secondaryAudio = secondaryStream.getAudioTracks()[0];
      if (secondaryAudio) {
        const source = state.audioContext.createMediaStreamSource(new MediaStream([secondaryAudio]));
        source.connect(state.audioDestination);
      }
    } catch (err) {
      console.error('[Secondary Audio] Error:', err);
    }
  }

  const mergedAudioTracks = state.audioDestination.stream.getAudioTracks();
  mergedAudioTracks.forEach(t => mixerCanvasStream.addTrack(t));

  state.mixerCanvasStream = mixerCanvasStream;

  if (!mixerInterval) {
    mixerInterval = setInterval(() => {
      renderMixerFrame(ctx);
    }, 1000 / 30);
  }

  maybeAutoStartBroadcast();
}

function renderMixerFrame(ctx) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, mixerCanvas.width, mixerCanvas.height);

  const localVid = dom.localVideo;
  const guestId = state.activeGuestId;
  const guestPeer = guestId ? callPeers[guestId] : null;
  const guestStream = guestPeer ? guestPeer.stream : null;

  let guestVid = null;
  if (guestId && guestStream) {
    const guestEl = document.getElementById(`vid-${guestId}`);
    if (guestEl) {
      guestVid = guestEl.querySelector('video');
    }
  }

  const screenVid = state.isScreenSharing && state.screenStream ? createVideoElement(state.screenStream) : null;

  const layout = state.mixerLayout;

  if (layout === 'SOLO') {
    if (screenVid && screenVid.readyState >= 2) {
      ctx.drawImage(screenVid, 0, 0, mixerCanvas.width, mixerCanvas.height);
    } else if (localVid && localVid.readyState >= 2) {
      ctx.drawImage(localVid, 0, 0, mixerCanvas.width, mixerCanvas.height);
    }
  } else if (layout === 'GUEST') {
    if (guestVid && guestVid.readyState >= 2) {
      ctx.drawImage(guestVid, 0, 0, mixerCanvas.width, mixerCanvas.height);
    } else if (localVid && localVid.readyState >= 2) {
      ctx.drawImage(localVid, 0, 0, mixerCanvas.width, mixerCanvas.height);
    }
  } else if (layout === 'PIP') {
    if (screenVid && screenVid.readyState >= 2) {
      ctx.drawImage(screenVid, 0, 0, mixerCanvas.width, mixerCanvas.height);
    } else if (localVid && localVid.readyState >= 2) {
      ctx.drawImage(localVid, 0, 0, mixerCanvas.width, mixerCanvas.height);
    }
    if (guestVid && guestVid.readyState >= 2) {
      const pipW = mixerCanvas.width * 0.25;
      const pipH = mixerCanvas.height * 0.25;
      const pipX = mixerCanvas.width - pipW - 20;
      const pipY = mixerCanvas.height - pipH - 20;
      ctx.drawImage(guestVid, pipX, pipY, pipW, pipH);
    }
  } else if (layout === 'PIP_INVERTED') {
    if (guestVid && guestVid.readyState >= 2) {
      ctx.drawImage(guestVid, 0, 0, mixerCanvas.width, mixerCanvas.height);
    } else if (localVid && localVid.readyState >= 2) {
      ctx.drawImage(localVid, 0, 0, mixerCanvas.width, mixerCanvas.height);
    }
    if (localVid && localVid.readyState >= 2) {
      const pipW = mixerCanvas.width * 0.25;
      const pipH = mixerCanvas.height * 0.25;
      const pipX = mixerCanvas.width - pipW - 20;
      const pipY = mixerCanvas.height - pipH - 20;
      ctx.drawImage(localVid, pipX, pipY, pipW, pipH);
    }
  } else if (layout === 'SPLIT') {
    const halfW = mixerCanvas.width / 2;
    if (localVid && localVid.readyState >= 2) {
      ctx.drawImage(localVid, 0, 0, halfW, mixerCanvas.height);
    }
    if (guestVid && guestVid.readyState >= 2) {
      ctx.drawImage(guestVid, halfW, 0, halfW, mixerCanvas.height);
    } else if (screenVid && screenVid.readyState >= 2) {
      ctx.drawImage(screenVid, halfW, 0, halfW, mixerCanvas.height);
    }
  }

  if (state.overlayActive) {
    renderOverlayOnCanvas(ctx);
  }

  state.overlayRenderCount++;
}

function createVideoElement(stream) {
  let vid = document.createElement('video');
  vid.srcObject = stream;
  vid.autoplay = true;
  vid.muted = true;
  vid.playsInline = true;
  return vid;
}

window.setMixerLayout = (layout) => {
  state.mixerLayout = layout;
  document.querySelectorAll('.mixer-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
};

window.setActiveGuest = (guestId) => {
  state.activeGuestId = guestId;
};

function maybeAutoStartBroadcast() {
  if (!state.isStreaming || !state.mixerCanvasStream) return;

  state.latestUserList.filter(u => u.isViewer).forEach(u => {
    if (!viewerPeers[u.id]) {
      createViewerPeer(u.id);
    }
  });
}

// ======================================================
// 15. HTML OVERLAY ENGINE (Dynamic Fields + Rendering)
// ======================================================
function buildOverlayFieldsFromHTML(htmlString) {
  state.currentRawHTML = htmlString;
  state.overlayFields = [];
  state.overlayFieldValues = {};

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  doc.querySelectorAll('[data-field-type]').forEach((el) => {
    const fieldType = el.getAttribute('data-field-type');
    const fieldName = el.getAttribute('data-field-name') || el.id || 'unnamed';
    state.overlayFields.push({ name: fieldName, type: fieldType, element: el });
  });

  if (dom.overlayFields) {
    dom.overlayFields.innerHTML = '';

    state.overlayFields.forEach((field) => {
      const fieldDiv = document.createElement('div');
      fieldDiv.className = 'overlay-field';

      const label = document.createElement('label');
      label.textContent = field.name;

      if (field.type === 'text') {
        const textarea = document.createElement('textarea');
        textarea.placeholder = `Text for ${field.name}`;
        textarea.oninput = (e) => updateOverlayFieldValue(field.name, e.target.value);
        fieldDiv.appendChild(label);
        fieldDiv.appendChild(textarea);
      } else if (field.type === 'image' || field.type === 'video') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = field.type === 'image' ? 'image/*' : 'video/*';
        input.onchange = (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const url = URL.createObjectURL(file);
          state.overlayObjectUrls[field.name] = url;
          updateOverlayFieldValue(field.name, url);
        };
        fieldDiv.appendChild(label);
        fieldDiv.appendChild(input);
      }

      dom.overlayFields.appendChild(fieldDiv);
    });
  }
}

function renderHTMLLayout(htmlString) {
  if (state.overlayContainer) {
    state.overlayContainer.remove();
    state.overlayVideoElements.forEach((vid) => vid.pause());
    state.overlayVideoElements = [];
  }

  state.overlayContainer = document.createElement('div');
  state.overlayContainer.style.cssText = 'position:fixed; left:-9999px; top:-9999px; width:1280px; height:720px; overflow:hidden;';
  state.overlayContainer.innerHTML = htmlString;

  state.overlayContainer.querySelectorAll('[data-field-type="video"]').forEach((videoEl) => {
    videoEl.autoplay = true;
    videoEl.loop = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    state.overlayVideoElements.push(videoEl);
  });

  document.body.appendChild(state.overlayContainer);

  state.overlayActive = true;
}

function findOverlayElement(field) {
  if (!state.overlayContainer) return null;
  return state.overlayContainer.querySelector(`[data-field-name="${field.name}"]`) || state.overlayContainer.querySelector(`#${field.name}`);
}

function updateOverlayFieldValue(fieldName, value) {
  state.overlayFieldValues[fieldName] = value;

  const field = state.overlayFields.find((f) => f.name === fieldName);
  if (!field) return;

  const el = findOverlayElement(field);
  if (!el) return;

  if (field.type === 'text') {
    el.textContent = value;
  } else if (field.type === 'image' || field.type === 'video') {
    el.src = value;
    if (field.type === 'video') {
      el.load();
      el.play().catch((e) => console.warn('[Overlay Video] Autoplay blocked:', e));
    }
  }
}

function renderOverlayOnCanvas(ctx) {
  if (!state.overlayContainer) return;

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = 1280;
  overlayCanvas.height = 720;

  const overlayCtx = overlayCanvas.getContext('2d');

  const drawNode = (node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const rect = node.getBoundingClientRect();
      const x = rect.left;
      const y = rect.top;
      const w = rect.width;
      const h = rect.height;

      const computedStyle = window.getComputedStyle(node);

      overlayCtx.fillStyle = computedStyle.backgroundColor || 'transparent';
      overlayCtx.fillRect(x, y, w, h);

      if (node.tagName === 'IMG' && node.complete) {
        overlayCtx.drawImage(node, x, y, w, h);
      } else if (node.tagName === 'VIDEO' && node.readyState >= 2) {
        overlayCtx.drawImage(node, x, y, w, h);
      } else {
        overlayCtx.font = computedStyle.font || '16px sans-serif';
        overlayCtx.fillStyle = computedStyle.color || '#fff';
        overlayCtx.textBaseline = 'top';
        overlayCtx.fillText(node.textContent || '', x, y);
      }

      Array.from(node.children).forEach(drawNode);
    }
  };

  Array.from(state.overlayContainer.children).forEach(drawNode);

  ctx.drawImage(overlayCanvas, 0, 0);
}

// ======================================================
// 16. FILE HANDLERS (ARCADE & HTML OVERLAY)
// ======================================================
if (dom.arcadeInput) {
  dom.arcadeInput.onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;

    state.activeToolboxFile = f;

    if (dom.arcadeStatus) {
      dom.arcadeStatus.textContent = `Active: ${f.name}`;
    }

    Object.values(viewerPeers).forEach((pc) => {
      pushFileToPeer(pc, f);
    });
  };
}

if (dom.htmlOverlayInput) {
  dom.htmlOverlayInput.onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;

    const r = new FileReader();
    r.onload = (ev) => {
      const htmlString = ev.target.result;
      buildOverlayFieldsFromHTML(htmlString);
      renderHTMLLayout(htmlString);
      if (dom.overlayStatus) dom.overlayStatus.textContent = '[Loaded]';
    };
    r.readAsText(f);
  };
}

window.clearOverlay = () => {
  state.overlayActive = false;
  state.overlayImage = new Image();
  state.currentRawHTML = '';
  state.overlayFields = [];
  state.overlayFieldValues = {};
  state.overlayVideoElements = [];
  Object.values(state.overlayObjectUrls).forEach((url) => URL.revokeObjectURL(url));
  state.overlayObjectUrls = {};
  if (dom.overlayFields) dom.overlayFields.innerHTML = '';
  if (dom.overlayStatus) dom.overlayStatus.textContent = '[Empty]';
};

window.__overlayTest = {
  loadHTML(htmlString) {
    buildOverlayFieldsFromHTML(htmlString);
    renderHTMLLayout(htmlString);
  },
  getFields() {
    return state.overlayFields.map((field) => ({ name: field.name, type: field.type }));
  },
  updateField(name, value) {
    updateOverlayFieldValue(name, value);
  },
  getFieldValue(name) {
    const field = state.overlayFields.find((item) => item.name === name);
    if (!field) return null;
    const el = findOverlayElement(field);
    if (!el) return null;
    if (field.type === 'text') return el.textContent || '';
    return el.getAttribute('src') || '';
  },
  getRenderCount() {
    return state.overlayRenderCount;
  }
};

// ======================================================
// 17. USER LIST & MIXER SELECTION (UPDATED: Stats Support)
// ======================================================
function renderUserList() {
  if (!dom.userList) return;

  dom.userList.innerHTML = '';

  const guests = state.latestUserList.filter((u) => !u.isViewer);
  const viewers = state.latestUserList.filter((u) => u.isViewer);

  const renderGroup = (label, users) => {
    if (users.length === 0) return;
    const h = document.createElement('h4');
    h.style.cssText =
      'font-size:0.7rem; color:var(--muted); margin:10px 0 5px; text-transform:uppercase; border-bottom:1px solid var(--border); padding-bottom:4px;';
    h.textContent = label;
    dom.userList.appendChild(h);

    users.forEach((u) => {
      if (u.id === state.myId) return;

      const div = document.createElement('div');
      div.className = 'user-item';

      const nameSpan = document.createElement('span');
      if (u.id === state.currentOwnerId) {
        nameSpan.textContent = '👑 ';
      }
      nameSpan.textContent += u.name;

      if (u.requestingCall) {
        nameSpan.innerHTML +=
          ' <span title="Requesting to Join Stream">✋</span>';
      }

      if (u.isVip) {
        const vipBadge = document.createElement('span');
        vipBadge.textContent = ' VIP';
        vipBadge.style.cssText =
          'margin-left:6px; font-size:0.6rem; color:#000; background:var(--accent); padding:2px 5px; border-radius:4px;';
        nameSpan.appendChild(vipBadge);
      }

      const statsBadge = document.createElement('small');
      statsBadge.id = `stats-${u.id}`;
      statsBadge.style.cssText = 'margin-left:8px; font-size:0.6rem; opacity:0.7;';
      nameSpan.appendChild(statsBadge);

      const actions = document.createElement('div');
      actions.className = 'user-actions';

      const isCalling = !!callPeers[u.id];

      if (state.iAmHost) {
        const mBtn = document.createElement('button');
        mBtn.className = 'action-btn';
        mBtn.textContent = state.mutedUsers.has(u.name) ? 'Unmute' : 'Mute';
        mBtn.onclick = () => {
          if (state.mutedUsers.has(u.name)) {
            state.mutedUsers.delete(u.name);
          } else {
            state.mutedUsers.add(u.name);
          }
          renderUserList();
        };
        actions.appendChild(mBtn);
      }

      const callBtn = document.createElement('button');
      callBtn.className = 'action-btn';

      if (isCalling) {
        callBtn.textContent = 'End';
        callBtn.style.color = 'var(--danger)';
        callBtn.onclick = () => endPeerCall(u.id);
      } else {
        if (u.requestingCall) {
          callBtn.textContent = u.isVip ? 'Accept & Call VIP' : 'Accept & Call';
        } else {
          callBtn.textContent = u.isVip ? 'Call VIP' : 'Call';
        }
        if (u.requestingCall) callBtn.style.borderColor = 'var(--accent)';
        callBtn.onclick = () => window.ringUser(u.id);
      }
      actions.appendChild(callBtn);

      if (isCalling && state.iAmHost) {
        const selBtn = document.createElement('button');
        selBtn.className = 'action-btn';
        selBtn.textContent = state.activeGuestId === u.id ? 'Selected' : 'Mix';
        selBtn.onclick = () => {
          state.activeGuestId = u.id;
          renderUserList();
          window.setActiveGuest(u.id);
        };
        actions.appendChild(selBtn);
      }

      if (state.iAmHost) {
        const pBtn = document.createElement('button');
        pBtn.className = 'action-btn';
        pBtn.textContent = '👑 Promote';
        pBtn.onclick = () => {
          if (confirm(`Hand over Host to ${u.name}?`)) {
            socket.emit('promote-to-host', { targetId: u.id });
          }
        };
        actions.appendChild(pBtn);

        const kBtn = document.createElement('button');
        kBtn.className = 'action-btn kick';
        kBtn.textContent = 'Kick';
        kBtn.onclick = () => window.kickUser(u.id);
        actions.appendChild(kBtn);
      }

      div.appendChild(nameSpan);
      div.appendChild(actions);
      dom.userList.appendChild(div);
    });
  };

  renderGroup('In-Room Guests', guests);
  renderGroup('Stream Viewers', viewers);
}

function addRemoteVideo(id, stream) {
  let d = document.getElementById(`vid-${id}`);
  if (!d) {
    d = document.createElement('div');
    d.className = 'video-container';
    d.id = `vid-${id}`;

    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    d.appendChild(v);

    const h2 = document.createElement('h2');
    h2.textContent = callPeers[id] ? callPeers[id].name : 'Guest';
    d.appendChild(h2);

    const videoGrid = $('videoGrid');
    if (videoGrid) videoGrid.appendChild(d);
  }

  const v = d.querySelector('video');
  if (v && v.srcObject !== stream) {
    v.srcObject = stream;
    setupAudioAnalysis(id, stream);
  }
}

function removeRemoteVideo(id) {
  const el = document.getElementById(`vid-${id}`);
  if (el) el.remove();
  if (state.audioAnalysers[id]) delete state.audioAnalysers[id];
}

window.ringUser = (id) => socket.emit('ring-user', id);
window.endPeerCall = endPeerCall;
window.kickUser = (id) => socket.emit('kick-user', id);

if (dom.openStreamBtn) {
  dom.openStreamBtn.onclick = () => {
    const u = $('streamLinkInput') && $('streamLinkInput').value;
    if (u) window.open(u, '_blank');
  };
}

// ======================================================
// 18. AUDIO ANALYSIS & STATS
// ======================================================
function setupAudioAnalysis(id, stream) {
  if (!state.audioContext) return;
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return;

  const source = state.audioContext.createMediaStreamSource(stream);
  const analyser = state.audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  state.audioAnalysers[id] = { analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) };
}

function updateUserStats() {
  Object.keys(state.audioAnalysers).forEach((id) => {
    const { analyser, dataArray } = state.audioAnalysers[id];
    analyser.getByteFrequencyData(dataArray);

    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const badge = document.getElementById(`stats-${id}`);
    if (badge) {
      const level = Math.round(average);
      badge.textContent = `🔊 ${level}`;
    }
  });
}

setInterval(updateUserStats, 500);

// ======================================================
// 19. PRIVACY & VIP CONTROLS
// ======================================================
if (dom.togglePrivateBtn) {
  dom.togglePrivateBtn.onclick = () => {
    state.isPrivateMode = !state.isPrivateMode;
    socket.emit('set-privacy', { isPrivate: state.isPrivateMode });
    updatePrivacyControlAvailability();
  };
}

if (dom.addGuestBtn && dom.guestNameInput) {
  dom.addGuestBtn.onclick = () => {
    const name = dom.guestNameInput.value.trim();
    if (!name) return;
    state.allowedGuests.push(name);
    dom.guestNameInput.value = '';
    socket.emit('set-privacy', { isPrivate: state.isPrivateMode, allowedGuests: state.allowedGuests });
    updatePrivacyControlAvailability();
  };
}

function updatePrivacyControlAvailability() {
  if (!dom.togglePrivateBtn) return;
  dom.togglePrivateBtn.textContent = state.isPrivateMode ? 'ON' : 'OFF';
  dom.togglePrivateBtn.style.background = state.isPrivateMode ? 'var(--accent)' : '';
  dom.togglePrivateBtn.style.color = state.isPrivateMode ? '#000' : '';

  if (dom.guestListPanel) {
    dom.guestListPanel.style.display = state.isPrivateMode ? 'block' : 'none';
  }

  if (dom.guestListDisplay) {
    dom.guestListDisplay.innerHTML = '';
    state.allowedGuests.forEach((name) => {
      const chip = document.createElement('span');
      chip.style.cssText = 'background:var(--panel-soft); padding:4px 8px; border-radius:4px; font-size:0.75rem; display:inline-flex; align-items:center; gap:5px;';
      chip.textContent = name;
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = 'background:none; border:none; color:var(--danger); cursor:pointer; font-size:1rem;';
      removeBtn.onclick = () => {
        state.allowedGuests = state.allowedGuests.filter((n) => n !== name);
        socket.emit('set-privacy', { isPrivate: state.isPrivateMode, allowedGuests: state.allowedGuests });
        updatePrivacyControlAvailability();
      };
      chip.appendChild(removeBtn);
      dom.guestListDisplay.appendChild(chip);
    });
  }
}

if (dom.vipRequiredToggle) {
  dom.vipRequiredToggle.onclick = () => {
    state.vipRequired = !state.vipRequired;
    socket.emit('set-vip-required', { vipRequired: state.vipRequired });
    updateVipDisplay();
  };
}

if (dom.addVipUserBtn && dom.vipUserInput) {
  dom.addVipUserBtn.onclick = () => {
    const name = dom.vipUserInput.value.trim();
    if (!name) return;
    socket.emit('add-vip-user', { userName: name }, (response) => {
      if (response && response.ok) {
        dom.vipUserInput.value = '';
        if (dom.vipStatus) dom.vipStatus.textContent = `Added ${name} as VIP.`;
      } else {
        if (dom.vipStatus) dom.vipStatus.textContent = response?.error || 'Failed to add VIP user.';
      }
    });
  };
}

if (dom.generateVipCodeBtn && dom.vipCodeUses) {
  dom.generateVipCodeBtn.onclick = () => {
    const uses = parseInt(dom.vipCodeUses.value, 10);
    socket.emit('generate-vip-code', { uses }, (response) => {
      if (response && response.ok) {
        if (dom.vipStatus) dom.vipStatus.textContent = `Generated code: ${response.code}`;
      } else {
        if (dom.vipStatus) dom.vipStatus.textContent = response?.error || 'Failed to generate VIP code.';
      }
    });
  };
}

function updateVipDisplay() {
  if (dom.vipRequiredToggle) {
    dom.vipRequiredToggle.textContent = state.vipRequired ? 'ON' : 'OFF';
    dom.vipRequiredToggle.style.background = state.vipRequired ? 'var(--accent)' : '';
    dom.vipRequiredToggle.style.color = state.vipRequired ? '#000' : '';
  }

  if (dom.vipUserList) {
    dom.vipUserList.innerHTML = '';
    state.vipUsers.forEach((name) => {
      const chip = document.createElement('span');
      chip.style.cssText = 'background:var(--accent); color:#000; padding:4px 8px; border-radius:4px; font-size:0.75rem; display:inline-flex; align-items:center; gap:5px;';
      chip.textContent = name;
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = 'background:none; border:none; color:#000; cursor:pointer; font-size:1rem;';
      removeBtn.onclick = () => {
        socket.emit('remove-vip-user', { userName: name });
      };
      chip.appendChild(removeBtn);
      dom.vipUserList.appendChild(chip);
    });
  }

  if (dom.vipCodeList) {
    dom.vipCodeList.innerHTML = '';
    state.vipCodes.forEach((codeObj) => {
      const chip = document.createElement('span');
      chip.style.cssText = 'background:var(--panel-soft); padding:4px 8px; border-radius:4px; font-size:0.75rem; display:inline-flex; align-items:center; gap:5px;';
      chip.textContent = `${codeObj.code} (${codeObj.uses} left)`;
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = 'background:none; border:none; color:var(--danger); cursor:pointer; font-size:1rem;';
      removeBtn.onclick = () => {
        socket.emit('remove-vip-code', { code: codeObj.code });
      };
      chip.appendChild(removeBtn);
      dom.vipCodeList.appendChild(chip);
    });
  }
}

// ======================================================
// 20. PAYMENT SETTINGS
// ======================================================
function displayPaymentSettings(payment) {
  if (!payment) return;
  if (dom.paymentEnableToggle) dom.paymentEnableToggle.checked = payment.enabled || false;
  if (dom.paymentLabelInput) dom.paymentLabelInput.value = payment.label || '';
  if (dom.paymentUrlInput) dom.paymentUrlInput.value = payment.url || '';
}

if (dom.paymentSaveBtn) {
  dom.paymentSaveBtn.onclick = () => {
    const enabled = dom.paymentEnableToggle ? dom.paymentEnableToggle.checked : false;
    const label = dom.paymentLabelInput ? dom.paymentLabelInput.value.trim() : '';
    const url = dom.paymentUrlInput ? dom.paymentUrlInput.value.trim() : '';

    socket.emit('set-payment', { enabled, label, url }, (response) => {
      if (response && response.ok) {
        if (dom.paymentStatus) dom.paymentStatus.textContent = 'Payment settings saved.';
      } else {
        if (dom.paymentStatus) dom.paymentStatus.textContent = response?.error || 'Failed to save payment settings.';
      }
    });
  };
}

// ======================================================
// 21. TURN SETTINGS
// ======================================================
function displayTurnSettings(turn) {
  if (!turn) return;
  state.turnConfig = turn;
  if (dom.turnEnableToggle) dom.turnEnableToggle.checked = turn.enabled || false;
  if (dom.turnHostInput) dom.turnHostInput.value = turn.host || '';
  if (dom.turnPortInput) dom.turnPortInput.value = turn.port || '';
  if (dom.turnTlsPortInput) dom.turnTlsPortInput.value = turn.tlsPort || '';
  if (dom.turnUsernameInput) dom.turnUsernameInput.value = turn.username || '';
  if (dom.turnPasswordInput) dom.turnPasswordInput.value = turn.password || '';
}

if (dom.turnSaveBtn) {
  dom.turnSaveBtn.onclick = () => {
    const enabled = dom.turnEnableToggle ? dom.turnEnableToggle.checked : false;
    const host = dom.turnHostInput ? dom.turnHostInput.value.trim() : '';
    const port = dom.turnPortInput ? dom.turnPortInput.value.trim() : '';
    const tlsPort = dom.turnTlsPortInput ? dom.turnTlsPortInput.value.trim() : '';
    const username = dom.turnUsernameInput ? dom.turnUsernameInput.value.trim() : '';
    const password = dom.turnPasswordInput ? dom.turnPasswordInput.value.trim() : '';

    socket.emit('set-turn', { enabled, host, port, tlsPort, username, password }, (response) => {
      if (response && response.ok) {
        state.turnConfig = { enabled, host, port, tlsPort, username, password };
        if (dom.turnStatus) dom.turnStatus.textContent = 'TURN settings saved.';
      } else {
        if (dom.turnStatus) dom.turnStatus.textContent = response?.error || 'Failed to save TURN settings.';
      }
    });
  };
}

// ======================================================
// 22. STREAM TITLE & SLUG
// ======================================================
if (dom.updateTitleBtn && dom.streamTitleInput) {
  dom.updateTitleBtn.onclick = () => {
    const title = dom.streamTitleInput.value.trim();
    socket.emit('set-stream-title', { title }, (response) => {
      if (response && response.ok) {
        console.log('[Stream Title] Updated');
      } else {
        console.error('[Stream Title] Failed:', response?.error);
      }
    });
  };
}

if (dom.updateSlugBtn && dom.slugInput) {
  dom.updateSlugBtn.onclick = () => {
    const slug = dom.slugInput.value.trim();
    socket.emit('set-slug', { slug }, (response) => {
      if (response && response.ok) {
        console.log('[Slug] Updated');
        const encodedSlug = encodeURIComponent(slug);
        const link = `${window.location.origin}/view.html?room=${encodedSlug}`;
        if (dom.streamLinkInput) {
          dom.streamLinkInput.value = link;
          generateQRCode(link);
        }
      } else {
        console.error('[Slug] Failed:', response?.error);
      }
    });
  };
}

if (dom.publicRoomToggle) {
  dom.publicRoomToggle.onchange = () => {
    const isPublic = dom.publicRoomToggle.checked;
    socket.emit('set-public-room', { isPublic }, (response) => {
      if (response && response.ok) {
        console.log('[Public Room] Updated');
      } else {
        console.error('[Public Room] Failed:', response?.error);
      }
    });
  };
}

// ======================================================
// 23. FILE SENDING (P2P SIGNALING)
// ======================================================
if (dom.fileInput && dom.fileNameLabel && dom.sendFileBtn) {
  dom.fileInput.onchange = () => {
    const file = dom.fileInput.files[0];
    if (file) {
      dom.fileNameLabel.textContent = file.name;
      dom.sendFileBtn.disabled = false;
    } else {
      dom.fileNameLabel.textContent = 'No file selected';
      dom.sendFileBtn.disabled = true;
    }
  };

  dom.sendFileBtn.onclick = () => {
    const file = dom.fileInput.files[0];
    if (!file) return;

    const targetUser = prompt('Enter username to send file to:');
    if (!targetUser) return;

    const targetId = state.latestUserList.find((u) => u.name === targetUser)?.id;
    if (!targetId) {
      alert('User not found.');
      return;
    }

    socket.emit('send-file-signal', { to: targetId, fileName: file.name, fileSize: file.size });

    const pc = callPeers[targetId];
    if (!pc) {
      alert('No active call with this user.');
      return;
    }

    pushFileToPeer(pc, file, (percent) => {
      if (dom.fileLog) {
        dom.fileLog.textContent = `Sending ${file.name}: ${percent}%`;
      }
    });
  };
}

socket.on('file-signal', (data) => {
  if (dom.fileLog) {
    const line = document.createElement('div');
    line.textContent = `${data.from} is sending: ${data.fileName} (${(data.fileSize / 1024).toFixed(2)} KB)`;
    dom.fileLog.appendChild(line);
  }
});

// ======================================================
// 24. STREAM PREVIEW MODAL
// ======================================================
if (dom.previewBtn && dom.previewModal && dom.previewVideo && dom.closePreviewBtn) {
  dom.previewBtn.onclick = () => {
    if (state.mixerCanvasStream) {
      dom.previewVideo.srcObject = state.mixerCanvasStream;
      dom.previewModal.classList.add('active');
    } else {
      alert('No stream available to preview. Start streaming first.');
    }
  };

  dom.closePreviewBtn.onclick = () => {
    dom.previewModal.classList.remove('active');
    dom.previewVideo.srcObject = null;
  };
}

updatePrivacyControlAvailability();

// ======================================================
// HELPER / GUIDE (Developer Notes)
// ======================================================
// - Signaling system:
//   * Host & viewers join a socket.io room (join-room).
//   * Host creates offers for broadcast or calls and sends them to the server.
//   * The server relays offers/answers/ICE to the target socket id.
// - Mixer + WebRTC:
//   * The canvas mixer renders local + guest video into a single canvas.
//   * The canvas is captured as a stream and sent to viewers.
//   * Host audio is added as a track on the same PeerConnection.
// - Extending overlays in the future:
//   * Render new overlay layers into the canvas before drawImage().
//   * Keep the canvas size/aspect consistent to avoid layout shifts.
//   * If adding new stats/graphics, re-render when room-update or chat updates.
