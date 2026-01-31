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
  arcadeInput: $('arcadeInput'),
  arcadeStatus: $('arcadeStatus'),
  htmlOverlayInput: $('htmlOverlayInput'),
  overlayStatus: $('overlayStatus'),
  overlayFields: $('overlayFields'),
  userList: $('userList'),
  openStreamBtn: $('openStreamBtn'),
  vipRequiredToggle: $('vipRequiredToggle')
};

function applyRoomQueryDefaults() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  const roleParam = params.get('role');
  const roomValue = roomParam ? roomParam.trim() : '';

  if (roomValue) {
    const roomInput = $('roomInput');
    if (roomInput) roomInput.value = roomValue;
    state.currentRoom = roomValue;
  }

  if (roleParam === 'host') {
    state.iAmHost = true;
    state.wasHost = true;
  }

  return { roomValue, roleParam };
}

function maybeAutoJoinHost() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  const roleParam = params.get('role');
  if (!roomParam || roleParam !== 'host') return;
  if (dom.joinBtn && !dom.joinBtn.disabled) {
    dom.joinBtn.click();
  }
}

window.addEventListener('load', maybeAutoJoinHost);

// ======================================================
// CANVAS MIXER MODULE (CAMERA -> CANVAS -> CAPTURESTREAM)
// ======================================================
let canvas = document.createElement('canvas');
canvas.width = 1920;
canvas.height = 1080;
let ctx = canvas.getContext('2d');
let canvasStream = null;

let lastDrawTime = 0;
const fpsInterval = 1000 / 30; // Target 30 FPS Lock

function drawMixer(timestamp) {
  requestAnimationFrame(drawMixer);

  const elapsed = timestamp - lastDrawTime;
  if (elapsed < fpsInterval) return;
  lastDrawTime = timestamp - (elapsed % fpsInterval);

  if (!ctx) return;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const myVideo = $('localVideo');
  let guestVideo = null;
  if (state.activeGuestId) {
    const el = document.getElementById(`vid-${state.activeGuestId}`);
    if (el) guestVideo = el.querySelector('video');
  }

  if (state.mixerLayout === 'SOLO') {
    if (myVideo && myVideo.readyState === 4) {
      ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
    }
  } else if (state.mixerLayout === 'GUEST') {
    if (guestVideo && guestVideo.readyState === 4) {
      ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = '60px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for Guest Signal...', canvas.width / 2, canvas.height / 2);
    }
  } else if (state.mixerLayout === 'SPLIT') {
    const participants = [];
    if (myVideo && myVideo.readyState === 4) {
      participants.push(myVideo);
    }

    Object.keys(callPeers).forEach((id) => {
      const el = document.getElementById(`vid-${id}`);
      const vid = el && el.querySelector('video');
      if (vid && vid.readyState === 4) {
        participants.push(vid);
      }
    });

    const count = participants.length || 1;
    const slotW = canvas.width / count;
    const aspect = 16 / 9;
    const vidH = slotW / aspect;
    const yOffset = (canvas.height - vidH) / 2;

    participants.forEach((vid, i) => {
      ctx.drawImage(vid, i * slotW, yOffset, slotW, vidH);
      if (i > 0) {
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(i * slotW, 0);
        ctx.lineTo(i * slotW, canvas.height);
        ctx.stroke();
      }
    });
  } else if (state.mixerLayout === 'PIP') {
    if (myVideo && myVideo.readyState === 4) {
      ctx.drawImage(myVideo, 0, 0, canvas.width, canvas.height);
    }
    if (guestVideo && guestVideo.readyState === 4) {
      const pipW = 480;
      const pipH = 270;
      const padding = 30;
      const x = canvas.width - pipW - padding;
      const y = canvas.height - pipH - padding;
      ctx.strokeStyle = '#4af3a3';
      ctx.lineWidth = 5;
      ctx.strokeRect(x, y, pipW, pipH);
      ctx.drawImage(guestVideo, x, y, pipW, pipH);
    }
  } else if (state.mixerLayout === 'PIP_INVERTED') {
    if (guestVideo && guestVideo.readyState === 4) {
      ctx.drawImage(guestVideo, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (myVideo && myVideo.readyState === 4) {
      const pipW = 480;
      const pipH = 270;
      const padding = 30;
      const x = canvas.width - pipW - padding;
      const y = canvas.height - pipH - padding;
      ctx.strokeStyle = '#4af3a3';
      ctx.lineWidth = 5;
      ctx.strokeRect(x, y, pipW, pipH);
      ctx.drawImage(myVideo, x, y, pipW, pipH);
    }
  }

  if (state.overlayActive && state.overlayImage.complete) {
    ctx.drawImage(state.overlayImage, 0, 0, canvas.width, canvas.height);
    drawOverlayVideos(ctx);
  }
}

// ======================================================
// AUDIO ANALYSIS HELPERS (NEW PATCH)
// ======================================================
function setupAudioAnalysis(id, stream) {
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  try {
    const source = state.audioContext.createMediaStreamSource(stream);
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    state.audioAnalysers[id] = {
      analyser,
      data: new Uint8Array(analyser.frequencyBinCount),
      vol: 0
    };
  } catch (e) {
    console.warn('Audio analysis init failed', e);
  }
}

// ======================================================
// BITRATE & STATS HELPERS (NEW PATCH)
// ======================================================
async function applyBitrateConstraints(pc) {
  const senders = pc.getSenders();
  const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
  if (!videoSender) return;

  try {
    const parameters = videoSender.getParameters();
    if (!parameters.encodings) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = 2500 * 1000; // 2.5 Mbps cap
    await videoSender.setParameters(parameters);
  } catch (e) {
    console.error('Bitrate cap failed', e);
  }
}

setInterval(async () => {
  for (const id in viewerPeers) {
    const pc = viewerPeers[id];
    if (pc.connectionState !== 'connected') continue;
    const stats = await pc.getStats();
    stats.forEach((report) => {
      if (report.type === 'remote-inbound-rtp') {
        const badge = document.getElementById(`stats-${id}`);
        if (badge) {
          const rtt = report.roundTripTime ? Math.round(report.roundTripTime * 1000) : 0;
          const loss = report.fractionLost ? (report.fractionLost * 100).toFixed(1) : 0;
          badge.innerHTML = `⏱️ ${rtt}ms | 📉 ${loss}%`;
        }
      }
    });
  }
}, 2000);

canvasStream = canvas.captureStream(30);
requestAnimationFrame(drawMixer);

// ======================================================
// STREAM PREVIEW POPUP (HOST MONITOR)
// ======================================================
function openStreamPreview() {
  if (!canvasStream) {
    alert('Stream engine not initialized.');
    return;
  }
  if (dom.previewVideo) {
    dom.previewVideo.srcObject = canvasStream;
    dom.previewVideo.muted = true;
    dom.previewVideo.play().catch(() => {});
  }
  if (dom.previewModal) {
    dom.previewModal.classList.add('active');
  }
}

function closeStreamPreview() {
  if (dom.previewModal) {
    dom.previewModal.classList.remove('active');
  }
  if (dom.previewVideo) {
    dom.previewVideo.srcObject = null;
  }
}

if (dom.previewBtn) dom.previewBtn.addEventListener('click', openStreamPreview);
if (dom.closePreviewBtn) dom.closePreviewBtn.addEventListener('click', closeStreamPreview);
if (dom.previewModal) {
  dom.previewModal.addEventListener('click', (e) => {
    if (e.target === dom.previewModal) closeStreamPreview();
  });
}

// ======================================================
// HTML LAYOUT ENGINE WITH DYNAMIC STATS & CHAT
// ======================================================
function buildChatHTMLFromLogs(maxLines = 12) {
  const log = $('chatLogPublic');
  if (!log) return '';

  const nodes = Array.from(log.querySelectorAll('.chat-line'));
  const last = nodes.slice(-maxLines);

  return last
    .map((line) => {
      const nameEl = line.querySelector('strong');
      const timeEl = line.querySelector('small');
      let textNode = null;
      for (const n of line.childNodes) {
        if (n.nodeType === Node.TEXT_NODE && n.textContent.includes(':')) {
          textNode = n;
          break;
        }
      }

      const name = nameEl ? nameEl.textContent.trim() : '';
      const time = timeEl ? timeEl.textContent.trim() : '';
      const text = textNode
        ? textNode.textContent.replace(/^:\s*/, '').trim()
        : line.textContent.replace(name, '').trim();

      return `
            <div class="ov-chat-line">
               <span class="ov-chat-name">${name}</span>
               <span class="ov-chat-time">${time}</span>
               <span class="ov-chat-text">${text}</span>
            </div>
        `;
    })
    .join('');
}

const TEXT_LIKE_TAGS = new Set([
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'small',
  'strong',
  'em',
  'b',
  'i',
  'label'
]);

function getOverlayFieldName(el) {
  if (!el || !el.getAttribute) return '';
  const dataName = el.getAttribute('data-overlay-field');
  if (dataName && dataName.trim()) return dataName.trim();
  const id = el.getAttribute('id');
  if (id && id.trim()) return id.trim();
  return '';
}

function getOverlayFieldType(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') return 'image';
  if (tag === 'video') return 'video';
  if (tag === 'source' && el.parentElement?.tagName?.toLowerCase() === 'video') {
    return 'video';
  }
  if (TEXT_LIKE_TAGS.has(tag)) return 'text';
  return 'text';
}

function ensureOverlayContainer() {
  if (state.overlayContainer) return state.overlayContainer;
  const container = document.createElement('div');
  container.id = 'overlaySandbox';
  container.style.cssText =
    'position:fixed; left:-9999px; top:-9999px; width:1920px; height:1080px; opacity:0; pointer-events:none;';
  document.body.appendChild(container);
  state.overlayContainer = container;
  return container;
}

function resolveOverlaySelector(el, fieldName) {
  if (el.hasAttribute && el.hasAttribute('data-overlay-field')) {
    return `[data-overlay-field="${CSS.escape(fieldName)}"]`;
  }
  return `#${CSS.escape(fieldName)}`;
}

function buildOverlayFieldsFromHTML(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');
  const fields = [];
  const used = new Set();

  doc.querySelectorAll('*').forEach((el) => {
    const name = getOverlayFieldName(el);
    if (!name || used.has(name)) return;
    used.add(name);
    const type = getOverlayFieldType(el);
    const selector = resolveOverlaySelector(el, name);
    const initialValue =
      type === 'text'
        ? (el.textContent || '').trim()
        : (el.getAttribute('src') || '').trim();
    fields.push({ name, type, selector, initialValue });
  });

  state.overlayFields = fields;
  state.overlayFieldValues = {};
  fields.forEach((field) => {
    state.overlayFieldValues[field.name] = field.initialValue;
  });
  renderOverlayFieldControls();
}

function findOverlayElement(field) {
  const container = ensureOverlayContainer();
  if (!field?.selector) return null;
  return container.querySelector(field.selector);
}

function prepareOverlayVideo(videoEl) {
  if (!videoEl) return;
  videoEl.muted = true;
  videoEl.loop = true;
  videoEl.playsInline = true;
  videoEl.autoplay = true;
  videoEl.controls = false;
  const playPromise = videoEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {});
  }
}

function applyOverlayFieldValues(container) {
  state.overlayFields.forEach((field) => {
    const el = container.querySelector(field.selector);
    if (!el) return;
    const value = state.overlayFieldValues[field.name] ?? '';

    if (field.type === 'text') {
      el.textContent = value;
      return;
    }

    if (field.type === 'image') {
      el.setAttribute('src', value);
      return;
    }

    if (field.type === 'video') {
      if (el.tagName.toLowerCase() === 'source') {
        el.setAttribute('src', value);
        const video = el.parentElement;
        if (video && video.tagName.toLowerCase() === 'video') {
          video.load();
          prepareOverlayVideo(video);
        }
      } else {
        el.setAttribute('src', value);
        el.load?.();
        prepareOverlayVideo(el);
      }
    }
  });
}

function drawOverlayVideos(ctx) {
  if (!state.overlayContainer || !state.overlayVideoElements.length) return;
  const containerRect = state.overlayContainer.getBoundingClientRect();
  if (!containerRect.width || !containerRect.height) return;

  const scaleX = canvas.width / containerRect.width;
  const scaleY = canvas.height / containerRect.height;

  state.overlayVideoElements.forEach((video) => {
    if (!video || video.readyState < 2) return;
    const rect = video.getBoundingClientRect();
    const x = (rect.left - containerRect.left) * scaleX;
    const y = (rect.top - containerRect.top) * scaleY;
    const w = rect.width * scaleX;
    const h = rect.height * scaleY;
    if (w > 0 && h > 0) {
      ctx.drawImage(video, x, y, w, h);
    }
  });
}

function updateOverlayFieldValue(name, value) {
  if (!name) return;
  state.overlayFieldValues[name] = value;
  if (state.overlayActive && state.currentRawHTML) {
    renderHTMLLayout(state.currentRawHTML);
  }
}

function renderOverlayFieldControls() {
  if (!dom.overlayFields) return;
  dom.overlayFields.innerHTML = '';
  if (!state.overlayFields.length) return;

  state.overlayFields.forEach((field) => {
    const row = document.createElement('div');
    row.className = 'overlay-field';

    const label = document.createElement('label');
    label.textContent = field.name;
    row.appendChild(label);

    const value = state.overlayFieldValues[field.name] ?? '';

    if (field.type === 'text') {
      const isLong = value.length > 60 || value.includes('\n');
      const input = document.createElement(isLong ? 'textarea' : 'input');
      input.value = value;
      input.oninput = () => updateOverlayFieldValue(field.name, input.value);
      row.appendChild(input);
    } else if (field.type === 'image' || field.type === 'video') {
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.placeholder = field.type === 'image' ? 'Image URL' : 'Video URL';
      urlInput.value = value;
      urlInput.onchange = () => updateOverlayFieldValue(field.name, urlInput.value.trim());
      row.appendChild(urlInput);

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = field.type === 'image' ? 'image/*' : 'video/*';
      fileInput.onchange = () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const previousUrl = state.overlayObjectUrls[field.name];
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        const objectUrl = URL.createObjectURL(file);
        state.overlayObjectUrls[field.name] = objectUrl;
        updateOverlayFieldValue(field.name, objectUrl);
      };
      row.appendChild(fileInput);
    }

    dom.overlayFields.appendChild(row);
  });
}

function renderHTMLLayout(htmlString) {
  if (!htmlString) return;
  state.currentRawHTML = htmlString;

  const viewerCount = state.latestUserList.filter((u) => u.isViewer).length;
  const guestCount = state.latestUserList.filter((u) => !u.isViewer).length;
  const streamTitle = dom.streamTitleInput ? dom.streamTitleInput.value : 'Rebel Stream';

  const chatHTML = buildChatHTMLFromLogs(14);

  const processedHTML = htmlString
    .replace(/{{viewers}}/g, viewerCount)
    .replace(/{{guests}}/g, guestCount)
    .replace(/{{title}}/g, streamTitle)
    .replace(/{{chat}}/g, chatHTML);

  const container = ensureOverlayContainer();
  container.innerHTML = `
    <div class="layout-${state.mixerLayout}" style="width:100%; height:100%; margin:0; padding:0;">
      ${processedHTML}
    </div>
  `;
  applyOverlayFieldValues(container);
  state.overlayVideoElements = Array.from(container.querySelectorAll('video'));
  state.overlayVideoElements.forEach((video) => prepareOverlayVideo(video));

  const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
            <foreignObject width="100%" height="100%">
                <div xmlns="http://www.w3.org/1999/xhtml" style="width:100%; height:100%; margin:0; padding:0;">
                    ${container.innerHTML}
                </div>
            </foreignObject>
        </svg>`;

  try {
    state.overlayImage.src =
      'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    state.overlayActive = true;
    state.overlayRenderCount += 1;
    if (window.__overlayTestHooks?.onRender) {
      window.__overlayTestHooks.onRender(state.overlayRenderCount);
    }
  } catch (e) {
    console.error('[Overlay] Failed to encode SVG', e);
  }
}

window.setMixerLayout = (mode) => {
  state.mixerLayout = mode;
  document.querySelectorAll('.mixer-btn').forEach((b) => {
    b.classList.remove('active');
    if (b.getAttribute('onclick') && b.getAttribute('onclick').includes(`'${mode}'`)) {
      b.classList.add('active');
    }
  });
  if (state.overlayActive) renderHTMLLayout(state.currentRawHTML);
};

window.setActiveGuest = (id) => {
  state.activeGuestId = id;
};

// ======================================================
// 4. TAB NAVIGATION INTERFACE
// ======================================================
const tabs = {
  stream: dom.tabStream,
  room: dom.tabRoom,
  files: dom.tabFiles,
  users: dom.tabUsers
};

const contents = {
  stream: dom.contentStream,
  room: dom.contentRoom,
  files: dom.contentFiles,
  users: dom.contentUsers
};

function switchTab(name) {
  if (!tabs[name]) return;
  Object.values(tabs).forEach((t) => t.classList.remove('active'));
  Object.values(contents).forEach((c) => c.classList.remove('active'));
  tabs[name].classList.add('active');
  contents[name].classList.add('active');
  tabs[name].classList.remove('has-new');
}

if (tabs.stream) tabs.stream.onclick = () => switchTab('stream');
if (tabs.room) tabs.room.onclick = () => switchTab('room');
if (tabs.files) tabs.files.onclick = () => switchTab('files');
if (tabs.users) tabs.users.onclick = () => switchTab('users');

// ======================================================
// 5. DEVICE SETTINGS
// ======================================================
if ($('settingsBtn')) {
  $('settingsBtn').addEventListener('click', () => {
    const isHidden = dom.settingsPanel.style.display === 'none' || dom.settingsPanel.style.display === '';
    dom.settingsPanel.style.display = isHidden ? 'block' : 'none';
    if (isHidden) getDevices();
  });
}

if ($('closeSettingsBtn')) {
  $('closeSettingsBtn').addEventListener('click', () => {
    dom.settingsPanel.style.display = 'none';
  });
}

async function getDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (dom.audioSource) dom.audioSource.innerHTML = '';
    if (dom.videoSource) dom.videoSource.innerHTML = '';
    if (dom.audioSource2) dom.audioSource2.innerHTML = '<option value="">-- None --</option>';

    devices.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `${d.kind} - ${d.deviceId.slice(0, 5)}`;
      if (d.kind === 'audioinput') {
        if (dom.audioSource) dom.audioSource.appendChild(opt);
        if (dom.audioSource2) dom.audioSource2.appendChild(opt.cloneNode(true));
      }
      if (d.kind === 'videoinput' && dom.videoSource) dom.videoSource.appendChild(opt);
    });

    if (state.localStream) {
      const at = state.localStream.getAudioTracks()[0];
      const vt = state.localStream.getVideoTracks()[0];
      if (at && at.getSettings().deviceId && dom.audioSource) {
        dom.audioSource.value = at.getSettings().deviceId;
      }
      if (vt && vt.getSettings().deviceId && dom.videoSource) {
        dom.videoSource.value = vt.getSettings().deviceId;
      }
    }
  } catch (e) {
    console.error(e);
  }
}

if (dom.audioSource) dom.audioSource.onchange = startLocalMedia;
if (dom.audioSource2) dom.audioSource2.onchange = startLocalMedia;
if (dom.videoSource) dom.videoSource.onchange = startLocalMedia;
if (dom.videoQuality) dom.videoQuality.onchange = startLocalMedia;

// ======================================================
// 6. MEDIA CONTROLS (UPDATED: High-Stability Constraints)
// ======================================================
async function startLocalMedia() {
  if (state.isScreenSharing) return;

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
  }

  try {
    const quality = dom.videoQuality ? dom.videoQuality.value : 'ideal';
    let widthConstraint;
    let heightConstraint;

    if (quality === 'max') {
      widthConstraint = { ideal: 1920 };
      heightConstraint = { ideal: 1080 };
    } else if (quality === 'low') {
      widthConstraint = { ideal: 640 };
      heightConstraint = { ideal: 360 };
    } else {
      widthConstraint = { ideal: 1280 };
      heightConstraint = { ideal: 720 };
    }

    const constraints = {
      audio: {
        deviceId: dom.audioSource && dom.audioSource.value ? { exact: dom.audioSource.value } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: {
        deviceId: dom.videoSource && dom.videoSource.value ? { exact: dom.videoSource.value } : undefined,
        width: widthConstraint,
        height: heightConstraint,
        frameRate: { max: 30 }
      }
    };

    const mainStream = await navigator.mediaDevices.getUserMedia(constraints);
    setupAudioAnalysis('local', mainStream);

    let finalAudioTrack = mainStream.getAudioTracks()[0];

    const secondaryId = dom.audioSource2 ? dom.audioSource2.value : null;
    if (secondaryId) {
      const secStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: secondaryId } }
      });
      if (!state.audioContext) state.audioContext = new AudioContext();
      state.audioDestination = state.audioContext.createMediaStreamDestination();

      const src1 = state.audioContext.createMediaStreamSource(mainStream);
      const src2 = state.audioContext.createMediaStreamSource(secStream);
      src1.connect(state.audioDestination);
      src2.connect(state.audioDestination);

      finalAudioTrack = state.audioDestination.stream.getAudioTracks()[0];
    }

    state.localStream = new MediaStream([
      mainStream.getVideoTracks()[0],
      finalAudioTrack
    ]);

    const localVideo = $('localVideo');
    if (localVideo) {
      localVideo.srcObject = state.localStream;
      localVideo.muted = true;
    }

    const mixedVideoTrack = canvasStream.getVideoTracks()[0];

    const updateViewerPC = (pc) => {
      if (!pc) return;
      const senders = pc.getSenders();
      const vSender = senders.find((s) => s.track && s.track.kind === 'video');
      const aSender = senders.find((s) => s.track && s.track.kind === 'audio');

      if (vSender && mixedVideoTrack) {
        vSender.replaceTrack(mixedVideoTrack);
      }

      if (aSender && finalAudioTrack) {
        aSender.replaceTrack(finalAudioTrack);
      }
    };

    Object.values(viewerPeers).forEach(updateViewerPC);

    Object.values(callPeers).forEach((p) => {
      const senders = p.pc.getSenders();
      const vSender = senders.find((s) => s.track && s.track.kind === 'video');
      const aSender = senders.find((s) => s.track && s.track.kind === 'audio');

      if (vSender && mainStream.getVideoTracks()[0]) {
        vSender.replaceTrack(mainStream.getVideoTracks()[0]);
      }
      if (aSender && finalAudioTrack) {
        aSender.replaceTrack(finalAudioTrack);
      }
    });

    if (dom.hangupBtn) dom.hangupBtn.disabled = false;

    updateMediaButtons();
  } catch (e) {
    console.error(e);
    alert('Camera/Mic access failed. Check permissions.');
  }
}

function updateMediaButtons() {
  if (!state.localStream) return;

  const vTrack = state.localStream.getVideoTracks()[0];
  const aTrack = state.localStream.getAudioTracks()[0];

  const camBtn = $('toggleCamBtn');
  const micBtn = $('toggleMicBtn');

  if (camBtn && vTrack) {
    const isCamOn = vTrack.enabled;
    camBtn.textContent = isCamOn ? 'Camera On' : 'Camera Off';
    camBtn.classList.toggle('danger', !isCamOn);
  }

  if (micBtn && aTrack) {
    const isMicOn = aTrack.enabled;
    micBtn.textContent = isMicOn ? 'Mute' : 'Unmute';
    micBtn.classList.toggle('danger', !isMicOn);
  }
}

const toggleMicBtn = $('toggleMicBtn');
if (toggleMicBtn) {
  toggleMicBtn.onclick = () => {
    if (!state.localStream) return;
    const t = state.localStream.getAudioTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      updateMediaButtons();
    }
  };
}

const toggleCamBtn = $('toggleCamBtn');
if (toggleCamBtn) {
  toggleCamBtn.onclick = () => {
    if (!state.localStream) return;
    const t = state.localStream.getVideoTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      updateMediaButtons();
    }
  };
}

// ======================================================
// 7. SCREEN SHARING
// ======================================================
if (dom.shareScreenBtn) {
  dom.shareScreenBtn.onclick = async () => {
    if (state.isScreenSharing) {
      stopScreenShare();
    } else {
      try {
        state.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
        state.isScreenSharing = true;
        dom.shareScreenBtn.textContent = 'Stop Screen';
        dom.shareScreenBtn.classList.add('danger');

        const localVideo = $('localVideo');
        if (localVideo) {
          localVideo.srcObject = state.screenStream;
        }

        const st = state.screenStream.getVideoTracks()[0];
        const sa = state.screenStream.getAudioTracks()[0];

        Object.values(callPeers).forEach((p) => {
          p.pc.getSenders().forEach((s) => {
            if (s.track && s.track.kind === 'video' && st) {
              s.replaceTrack(st);
            }
            if (sa && s.track && s.track.kind === 'audio') {
              s.replaceTrack(sa);
            }
          });
        });

        st.onended = stopScreenShare;
      } catch (e) {
        console.error(e);
      }
    }
  };
}

function stopScreenShare() {
  if (!state.isScreenSharing) return;
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
  }
  state.screenStream = null;
  state.isScreenSharing = false;

  if (dom.shareScreenBtn) {
    dom.shareScreenBtn.textContent = 'Share Screen';
    dom.shareScreenBtn.classList.remove('danger');
  }

  startLocalMedia();
}

// ======================================================
// 8. BROADCAST STREAMING
// ======================================================

/**
 * Update the host UI button label/state for broadcast control.
 * Called when the host toggles streaming. No signaling occurs here.
 */
function updateStreamButton(isLive) {
    const startBtn = $('startStreamBtn'); //
    if (!startBtn) return; //
    startBtn.textContent = isLive ? "Stop Stream" : "Start Stream"; //
    startBtn.classList.toggle('danger', isLive); //
}

/**
 * Stop broadcast streaming (host side only).
 * Called when the host clicks "Stop Stream".
 * PeerConnection impact: closes all viewer PeerConnections.
 */
function stopStream() {
    state.isStreaming = false; //
    updateStreamButton(false); //
    if (state.currentRoom) {
      socket.emit('update-room-live', { roomName: state.currentRoom, isLive: false });
    }

    Object.values(viewerPeers).forEach(pc => pc.close()); //
    for (const k in viewerPeers) {
        delete viewerPeers[k]; //
    }
}

/**
 * Start broadcast streaming (host side only).
 * Called when the host clicks "Start Stream".
 * Signaling direction: [HOST] -> (webrtc-offer) -> [SERVER] -> [VIEWER]
 * PeerConnection impact: creates viewer PeerConnections and sends offers.
 */
async function startStream() {
    if (!state.currentRoom || !state.iAmHost) return; //

  if (!state.localStream) {
    await startLocalMedia();
  }

    state.isStreaming = true; //
    updateStreamButton(true); //
    if (state.currentRoom) {
      socket.emit('update-room-live', { roomName: state.currentRoom, isLive: true });
    }

  state.latestUserList.forEach((u) => {
    if (u.id !== state.myId) {
      connectViewer(u.id);
    }
  });
}

const startStreamBtn = $('startStreamBtn'); //
if (startStreamBtn) {
    startStreamBtn.onclick = async () => {
        if (!state.currentRoom || !state.iAmHost) {
            alert("Host only."); //
            return;
        }
        if (state.isStreaming) {
            stopStream(); //
        } else {
            await startStream(); //
        }
    };
}

// ======================================================
// 9. P2P CALLING (1-to-1)
// ======================================================

/**
 * Create and wire a 1-to-1 call PeerConnection.
 * Called for both outgoing calls (host rings) and incoming calls (viewer rings).
 * Signaling direction: [HOST|VIEWER] <-> (call-ice) <-> [SERVER]
 * PeerConnection impact: registers ICE + track handlers.
 */
function setupCallPeerConnection(targetId, name) {
    const pc = new RTCPeerConnection(getRtcConfig()); //
    callPeers[targetId] = { pc, name }; //
    attachCandidateDiagnostics(pc, `Call:${name || targetId}`); //

    pc.onicecandidate = e => {
        if (e.candidate) {
            socket.emit('call-ice', {
                targetId,
                candidate: e.candidate
            }); //
        }
    };

    pc.ontrack = e => addRemoteVideo(targetId, e.streams[0]); //
    return pc; //
}

/**
 * Attach local cam/mic tracks to a call PeerConnection.
 * Called right before creating offers/answers.
 * PeerConnection impact: adds local media tracks for the call.
 */
function attachLocalTracksToCall(pc) {
    if (!state.localStream) return;
    state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
}

const hangupBtn = $('hangupBtn'); //
if (hangupBtn) {
    hangupBtn.onclick = () => {
        Object.keys(callPeers).forEach(id => endPeerCall(id)); //
    };
}

/**
 * Handle an incoming ring alert from the server.
 * Called when server relays a ring-user event.
 * Signaling direction: [HOST|VIEWER] -> (ring-user) -> [SERVER] -> [TARGET]
 */
async function handleRingAlert({ from, fromId }) {
    if (confirm(`Incoming call from ${from}. Accept?`)) {
        await callPeer(fromId); //
    }
}

socket.on('ring-alert', handleRingAlert);

// Listener for Viewer "Hand Raise" call requests
/**
 * Handle a viewer "raise hand" request.
 * Called when the server notifies the host.
 * Signaling direction: [VIEWER] -> (request-to-call) -> [SERVER] -> [HOST]
 */
function handleCallRequestReceived({ id, name }) {
    const privateLog = $('chatLogPrivate'); //
    if (privateLog) {
        const atBottom =
            privateLog.scrollHeight - privateLog.scrollTop <= privateLog.clientHeight + 20; //
        const div = document.createElement('div'); //
        div.className = 'chat-line system-msg'; //
        div.style.color = "var(--accent)"; //
        div.innerHTML = `<strong>✋ CALL REQUEST:</strong> ${name} wants to join the stream.`; //
        privateLog.appendChild(div); //
        if (atBottom) {
            privateLog.scrollTop = privateLog.scrollHeight; //
        }
    }

    // NEW: behave like a call – give you a choice to ring them now
    const doRing = confirm(
        `${name} has requested to join the stream.\n\nRing them now?`
    ); //
    if (doRing && window.ringUser) {
        window.ringUser(id); //
    }

    renderUserList(); //
}

socket.on('call-request-received', handleCallRequestReceived);

/**
 * Create an outgoing call offer to a peer.
 * Called after the host accepts a ring or initiates a call.
 * Signaling direction: [HOST] -> (call-offer) -> [SERVER] -> [VIEWER]
 * PeerConnection impact: creates offer + local description.
 */
async function callPeer(targetId) {
  if (!state.localStream) {
    await startLocalMedia();
  }

  const pc = setupCallPeerConnection(targetId, 'Peer');
  attachLocalTracksToCall(pc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('call-offer', { targetId, offer });

  renderUserList();
}

/**
 * Handle an incoming call offer from another peer.
 * Called when the server relays a call-offer.
 * Signaling direction: [VIEWER] -> (call-offer) -> [SERVER] -> [HOST]
 * PeerConnection impact: sets remote description, creates answer.
 */
async function handleIncomingCall({ from, name, offer }) {
  if (!state.localStream) {
    await startLocalMedia();
  }

  const pc = setupCallPeerConnection(from, name);
  attachLocalTracksToCall(pc);

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit('call-answer', { targetId: from, answer });

  renderUserList();
}

socket.on('incoming-call', handleIncomingCall);

/**
 * Apply a call answer to an existing PeerConnection.
 * Called when the server relays call-answer to the offerer.
 */
async function handleCallAnswer({ from, answer }) {
    if (callPeers[from]) {
        await callPeers[from].pc.setRemoteDescription(
            new RTCSessionDescription(answer)
        ); //
    }
}

socket.on('call-answer', handleCallAnswer);

/**
 * Handle incoming ICE candidates for a call PeerConnection.
 * Signaling direction: [HOST|VIEWER] -> (call-ice) -> [SERVER] -> [PEER]
 */
function handleCallIce({ from, candidate }) {
    if (callPeers[from]) {
        callPeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate)); //
    }
}

socket.on('call-ice', handleCallIce);

/**
 * Handle a call end signal from the remote peer.
 * Signaling direction: [HOST|VIEWER] -> (call-end) -> [SERVER] -> [PEER]
 */
function handleCallEnd({ from }) {
    endPeerCall(from, true); //
}

socket.on('call-end', handleCallEnd);

function endPeerCall(id, isIncomingSignal) {
  if (callPeers[id]) {
    try {
      callPeers[id].pc.close();
    } catch (e) {
      console.error(e);
    }
  }
  delete callPeers[id];
  removeRemoteVideo(id);

  if (!isIncomingSignal) {
    socket.emit('call-end', { targetId: id });
  }

  renderUserList();
}

// ======================================================
// 10. VIEWER CONNECTION & ARCADE PUSH (UPDATED: Bitrate Patch)
// ======================================================

/**
 * Attach the mixed canvas stream + host audio to the viewer PeerConnection.
 * Called when creating a viewer PeerConnection.
 */
function attachBroadcastTracks(pc) {
    canvasStream.getTracks().forEach(t => pc.addTrack(t, canvasStream)); //

    if (state.localStream) {
        const at = state.localStream.getAudioTracks()[0];
        if (at) pc.addTrack(at, state.localStream);
    }
}

/**
 * Create and wire the host->viewer broadcast PeerConnection.
 * Called per viewer when streaming is active.
 * Signaling direction: [HOST] -> (webrtc-ice-candidate) -> [SERVER] -> [VIEWER]
 * PeerConnection impact: adds mixer tracks + configures ICE.
 */
function setupViewerPeerConnection(targetId) {
    const pc = new RTCPeerConnection(getRtcConfig()); //
    viewerPeers[targetId] = pc; //
    attachCandidateDiagnostics(pc, `Broadcast:${targetId}`); //

    pc.createDataChannel("control"); //

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-ice-candidate', {
        targetId,
        candidate: e.candidate
      });
    }
  };

    attachBroadcastTracks(pc); //

  if (state.activeToolboxFile) {
    pushFileToPeer(pc, state.activeToolboxFile, null);
  }

    return pc; //
}

/**
 * Create and send a WebRTC offer to a viewer.
 * Called when streaming starts or when a new viewer joins.
 * Signaling direction: [HOST] -> (webrtc-offer) -> [SERVER] -> [VIEWER]
 */
async function connectViewer(targetId) {
    if (viewerPeers[targetId]) return; //

    const pc = setupViewerPeerConnection(targetId); //

    const offer = await pc.createOffer(); //
    await pc.setLocalDescription(offer); //

  await applyBitrateConstraints(pc);

  socket.emit('webrtc-offer', { targetId, sdp: offer });
}

/**
 * Handle the viewer's answer to a broadcast offer.
 * Called when the server relays webrtc-answer.
 */
async function handleViewerAnswer({ from, sdp }) {
    if (viewerPeers[from]) {
        await viewerPeers[from].setRemoteDescription(
            new RTCSessionDescription(sdp)
        ); //
    }
}

socket.on('webrtc-answer', handleViewerAnswer);

/**
 * Handle ICE candidates from a viewer.
 * Called when the server relays webrtc-ice-candidate.
 */
async function handleViewerIceCandidate({ from, candidate }) {
    if (viewerPeers[from]) {
        await viewerPeers[from].addIceCandidate(
            new RTCIceCandidate(candidate)
        ); //
    }
}

socket.on('webrtc-ice-candidate', handleViewerIceCandidate);

// ======================================================
// 11. SOCKET & ROOM LOGIC
// ======================================================
socket.on('connect', () => {
  const signalStatus = $('signalStatus');
  if (signalStatus) {
    signalStatus.className = 'status-dot status-connected';
    signalStatus.textContent = 'Connected';
  }
  state.myId = socket.id;
  updatePrivacyControlAvailability();
});

socket.on('disconnect', () => {
  const signalStatus = $('signalStatus');
  if (signalStatus) {
    signalStatus.className = 'status-dot status-disconnected';
    signalStatus.textContent = 'Disconnected';
  }
  updatePrivacyControlAvailability();
});

function emitWithAck(eventName, payload) {
  return new Promise((resolve) => {
    socket.emit(eventName, payload, resolve);
  });
}

async function ensureHostRoom(roomName) {
  const info = await emitWithAck('get-room-info', { roomName });
  if (!info?.exists) {
    const createResp = await emitWithAck('enter-host-room', {
      roomName,
      privacy: 'public'
    });
    if (!createResp?.ok) {
      return { ok: false, error: createResp?.error || 'Unable to create room.' };
    }
    return { ok: true, created: true };
  }

  if (info.hasOwnerPassword) {
    const storedPassword = sessionStorage.getItem(`hostPassword:${roomName}`);
    const password = storedPassword || window.prompt('Enter host password for this room:') || '';
    if (!password) {
      return { ok: false, error: 'Host password is required to enter this room.' };
    }
    const authResp = await emitWithAck('enter-host-room', { roomName, password });
    if (!authResp?.ok) {
      return { ok: false, error: authResp?.error || 'Invalid password.' };
    }
    sessionStorage.setItem(`hostPassword:${roomName}`, password);
  } else {
    const authResp = await emitWithAck('enter-host-room', { roomName });
    if (!authResp?.ok) {
      return { ok: false, error: authResp?.error || 'Unable to enter room.' };
    }
  }

  return { ok: true, created: false };
}

async function joinRoomAsHost(room) {
  if (!room) return;
  state.iAmHost = true;
  state.wasHost = true;
  if (state.joined && state.currentRoom === room) return;
  if (state.joined && state.currentRoom && state.currentRoom !== room) {
    window.location.href = `/index.html?room=${encodeURIComponent(room)}&role=host`;
    return;
  }

  state.currentRoom = room;
  const nameInput = $('nameInput');
  state.userName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : 'Host';

  if (!socket.connected) socket.connect();

  const access = await ensureHostRoom(room);
  if (!access.ok) {
    alert(access.error || 'Unable to access room.');
    return;
  }

  socket.emit('join-room', { room, name: state.userName, isViewer: false }, (resp) => {
    if (resp?.isHost) {
      state.vipUsers = Array.isArray(resp.vipUsers) ? resp.vipUsers : [];
      state.vipCodes = Array.isArray(resp.vipCodes) ? resp.vipCodes : [];
      renderVipUsers();
      renderVipCodes();
      if (resp?.privacy) {
        applyPrivacyState(resp.privacy === 'private', { emitUpdate: false });
      }
      if (typeof resp?.vipRequired === 'boolean') {
        applyVipRequiredState(resp.vipRequired, { emitUpdate: false });
      }
      socket.emit('get-vip-codes', { roomName: room }, (codesResp) => {
        if (codesResp?.ok) {
          state.vipCodes = Array.isArray(codesResp.codes) ? codesResp.codes : [];
          renderVipCodes();
        }
      });
      loadRoomConfig(room);
    } else if (resp?.error) {
      alert(resp.error);
      return;
    }
    state.joined = true;
    updatePrivacyControlAvailability();
  });

  if (dom.leaveBtn) dom.leaveBtn.disabled = false;

  updateLink(room);
  startLocalMedia();
}

async function autoJoinHostRoom(room) {
  if (!room) return;
  state.iAmHost = true;
  state.wasHost = true;
  await joinRoomAsHost(room);
}

if (dom.joinBtn) {
  dom.joinBtn.onclick = () => {
    const room = $('roomInput').value.trim();
    if (!room) return;

    state.currentRoom = room;
    joinRoomAsHost(room);
  };
}

if (dom.leaveBtn) {
  dom.leaveBtn.onclick = () => {
    window.location.reload();
  };
}

window.addEventListener('load', () => {
  const { roomValue, roleParam } = applyRoomQueryDefaults();
  if (roleParam === 'host' && roomValue) {
    autoJoinHostRoom(roomValue);
  }
});

function generateQR(url) {
  const container = $('qrcode');
  if (container && typeof QRCode !== 'undefined') {
    container.innerHTML = '';
    new QRCode(container, {
      text: url,
      width: 128,
      height: 128,
      colorDark: '#4af3a3',
      colorLight: '#101524'
    });
  }
}

function updateLink(roomSlug) {
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace('index.html', '') + 'view.html';
  url.search = `?room=${encodeURIComponent(roomSlug)}`;
  const finalUrl = url.toString();

  const streamLinkInput = $('streamLinkInput');
  if (streamLinkInput) streamLinkInput.value = finalUrl;

  generateQR(finalUrl);
}

socket.on('user-joined', ({ id, name }) => {
  const privateLog = $('chatLogPrivate');
  appendChat(privateLog, 'System', `${name} joined room`, Date.now());

  if (state.iAmHost && state.isStreaming) {
    connectViewer(id);
  }
});

socket.on('user-left', ({ id }) => {
  if (viewerPeers[id]) {
    viewerPeers[id].close();
    delete viewerPeers[id];
  }
  endPeerCall(id, true);
});

socket.on('room-update', ({ locked, streamTitle, ownerId, users, vipRequired, privacy }) => {
  state.latestUserList = users || [];
  state.currentOwnerId = ownerId;

  if (streamTitle && dom.streamTitleInput) {
    dom.streamTitleInput.value = streamTitle;
    updateLink($('roomInput').value || state.currentRoom);
  }

  const lockRoomBtn = $('lockRoomBtn');
  if (lockRoomBtn) {
    lockRoomBtn.textContent = locked ? 'Unlock Room' : 'Lock Room';
    lockRoomBtn.onclick = () => {
      if (state.iAmHost) {
        socket.emit('lock-room', !locked);
      }
    };
  }

  renderUserList();

  if (typeof privacy === 'string') {
    applyPrivacyState(privacy === 'private', { emitUpdate: false });
  }
  if (typeof vipRequired === 'boolean') {
    applyVipRequiredState(vipRequired, { emitUpdate: false });
  }

  if (state.overlayActive) {
    renderHTMLLayout(state.currentRawHTML);
  }
});

socket.on('vip-codes-updated', (codes) => {
  state.vipCodes = Array.isArray(codes) ? codes : [];
  renderVipCodes();
});

socket.on('role', async ({ isHost }) => {
  state.wasHost = state.iAmHost;
  state.iAmHost = isHost;

  const localContainer = $('localContainer');
  if (localContainer) {
    const h2 = localContainer.querySelector('h2');
    if (h2) {
      h2.textContent = isHost ? 'You (Host)' : 'You';
    }
  }

  const hostControls = $('hostControls');
  if (hostControls) {
    hostControls.style.display = isHost ? 'block' : 'none';
  }

  renderUserList();
});

// ======================================================
// 12. HOST CONTROLS
// ======================================================
if (dom.updateTitleBtn) {
  dom.updateTitleBtn.onclick = () => {
    if (!dom.streamTitleInput) return;
    const t = dom.streamTitleInput.value.trim();
    if (t) {
      socket.emit('update-stream-title', t);
      if (state.overlayActive) renderHTMLLayout(state.currentRawHTML);
    }
  };
}

if (dom.streamTitleInput) {
  dom.streamTitleInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const t = dom.streamTitleInput.value.trim();
      if (t) {
        socket.emit('update-stream-title', t);
        if (state.overlayActive) renderHTMLLayout(state.currentRawHTML);
      }
    }
  };
}

if (dom.updateSlugBtn) {
  dom.updateSlugBtn.onclick = () => {
    if (!dom.slugInput) return;
    const s = dom.slugInput.value.trim();
    if (s) updateLink(s);
  };
}

if (dom.slugInput) {
  dom.slugInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const s = dom.slugInput.value.trim();
      if (s) updateLink(s);
    }
  };
}

function canUpdateRoomSettings() {
  return !!(state.currentRoom && state.joined && socket.connected);
}

function updateVipActionAvailability() {
  const ready = canUpdateRoomSettings();
  const vipName = dom.vipUserInput?.value.trim() || '';
  if (dom.addVipUserBtn) {
    dom.addVipUserBtn.disabled = !ready || !vipName;
    if (!ready) {
      dom.addVipUserBtn.title = 'Join a room to add VIP users.';
    } else if (!vipName) {
      dom.addVipUserBtn.title = 'Enter a VIP username first.';
    } else {
      dom.addVipUserBtn.title = '';
    }
  }

  if (dom.generateVipCodeBtn) {
    const canGenerate = ready && state.isPrivateMode;
    dom.generateVipCodeBtn.disabled = !canGenerate;
    if (!ready) {
      dom.generateVipCodeBtn.title = 'Join a room to generate VIP codes.';
    } else if (!state.isPrivateMode) {
      dom.generateVipCodeBtn.title = 'Turn on Private Room to generate VIP codes.';
    } else {
      dom.generateVipCodeBtn.title = '';
    }
  }
}

function updatePrivacyControlAvailability() {
  const ready = canUpdateRoomSettings();
  if (dom.togglePrivateBtn) {
    dom.togglePrivateBtn.disabled = !ready;
    dom.togglePrivateBtn.title = ready ? '' : 'Join a room to change privacy.';
  }
  if (dom.publicRoomToggle) {
    dom.publicRoomToggle.disabled = !ready;
    dom.publicRoomToggle.title = ready ? '' : 'Join a room to change privacy.';
  }
  if (dom.vipRequiredToggle) {
    dom.vipRequiredToggle.disabled = !ready;
    dom.vipRequiredToggle.title = ready ? '' : 'Join a room to change VIP access.';
  }
  updateVipActionAvailability();
}

function applyPrivacyState(isPrivate, { emitUpdate = true } = {}) {
  state.isPrivateMode = !!isPrivate;

  if (dom.togglePrivateBtn) {
    dom.togglePrivateBtn.textContent = state.isPrivateMode ? 'ON' : 'OFF';
    dom.togglePrivateBtn.className = state.isPrivateMode
      ? 'btn small danger'
      : 'btn small secondary';
  }

  if (dom.publicRoomToggle) {
    dom.publicRoomToggle.checked = !state.isPrivateMode;
  }

  if (dom.guestListPanel) {
    dom.guestListPanel.style.display = state.isPrivateMode ? 'block' : 'none';
  }

  if (emitUpdate && state.currentRoom) {
    socket.emit('update-room-privacy', {
      roomName: state.currentRoom,
      privacy: state.isPrivateMode ? 'private' : 'public'
    });
  }

  if (emitUpdate && state.isPrivateMode) {
    state.latestUserList.forEach((u) => {
      if (
        u.id !== state.myId &&
        !state.allowedGuests.some((g) => g.toLowerCase() === u.name.toLowerCase())
      ) {
        socket.emit('kick-user', u.id);
      }
    });
  }
  updateVipActionAvailability();
}

function applyVipRequiredState(isRequired, { emitUpdate = true } = {}) {
  state.vipRequired = !!isRequired;
  if (dom.vipRequiredToggle) {
    dom.vipRequiredToggle.textContent = state.vipRequired ? 'ON' : 'OFF';
    dom.vipRequiredToggle.className = state.vipRequired
      ? 'btn small danger'
      : 'btn small secondary';
  }
  if (emitUpdate && state.currentRoom) {
    socket.emit('update-vip-required', {
      roomName: state.currentRoom,
      vipRequired: state.vipRequired
    });
  }
}

if (dom.addGuestBtn) {
  dom.addGuestBtn.onclick = () => {
    if (!dom.guestNameInput) return;
    const n = dom.guestNameInput.value.trim();
    if (n && !state.allowedGuests.includes(n)) {
      state.allowedGuests.push(n);
      renderGuestList();
      dom.guestNameInput.value = '';
    }
  };
}

function renderGuestList() {
  if (!dom.guestListDisplay) return;

  dom.guestListDisplay.innerHTML = '';
  state.allowedGuests.forEach((name) => {
    const t = document.createElement('span');
    t.style.cssText =
      'background:var(--accent); color:#000; padding:2px 6px; border-radius:4px; font-size:0.7rem; margin:2px;';
    t.textContent = name;
    dom.guestListDisplay.appendChild(t);
  });
}

function setVipStatus(message, tone = 'muted') {
  if (!dom.vipStatus) return;
  dom.vipStatus.textContent = message || '';
  dom.vipStatus.style.color = tone === 'error' ? 'var(--danger)' : 'var(--muted)';
}

function setPaymentStatus(message, tone = 'muted') {
  if (!dom.paymentStatus) return;
  dom.paymentStatus.textContent = message || '';
  dom.paymentStatus.style.color = tone === 'error' ? 'var(--danger)' : 'var(--muted)';
}

function setTurnStatus(message, tone = 'muted') {
  if (!dom.turnStatus) return;
  dom.turnStatus.textContent = message || '';
  dom.turnStatus.style.color = tone === 'error' ? 'var(--danger)' : 'var(--muted)';
}

function applyPaymentConfig(config) {
  state.paymentEnabled = !!config.paymentEnabled;
  state.paymentLabel = config.paymentLabel || '';
  state.paymentUrl = config.paymentUrl || '';

  if (dom.paymentEnableToggle) {
    dom.paymentEnableToggle.checked = state.paymentEnabled;
  }
  if (dom.paymentLabelInput) {
    dom.paymentLabelInput.value = state.paymentLabel;
  }
  if (dom.paymentUrlInput) {
    dom.paymentUrlInput.value = state.paymentUrl;
  }
}

function applyTurnConfig(config) {
  const turn = config?.turnConfig || config || {};
  state.turnConfig = {
    enabled: !!turn.enabled,
    host: turn.host || '',
    port: turn.port || '',
    tlsPort: turn.tlsPort || '',
    username: turn.username || '',
    password: turn.password || ''
  };

  if (dom.turnEnableToggle) {
    dom.turnEnableToggle.checked = state.turnConfig.enabled;
  }
  if (dom.turnHostInput) {
    dom.turnHostInput.value = state.turnConfig.host;
  }
  if (dom.turnPortInput) {
    dom.turnPortInput.value = state.turnConfig.port || '';
  }
  if (dom.turnTlsPortInput) {
    dom.turnTlsPortInput.value = state.turnConfig.tlsPort || '';
  }
  if (dom.turnUsernameInput) {
    dom.turnUsernameInput.value = state.turnConfig.username;
  }
  if (dom.turnPasswordInput) {
    dom.turnPasswordInput.value = state.turnConfig.password;
  }
}

function collectTurnConfigFromInputs() {
  const enabled = !!dom.turnEnableToggle?.checked;
  const host = dom.turnHostInput?.value.trim() || '';
  const portValue = dom.turnPortInput?.value;
  const port = portValue ? Number(portValue) : '';
  const tlsPortValue = dom.turnTlsPortInput?.value;
  const tlsPort = tlsPortValue ? Number(tlsPortValue) : '';
  const username = dom.turnUsernameInput?.value.trim() || '';
  const password = dom.turnPasswordInput?.value.trim() || '';

  if (enabled) {
    if (!host || !port) {
      setTurnStatus('TURN host and port are required when relay is enabled.', 'error');
      return null;
    }
    if (!username || !password) {
      setTurnStatus('TURN username and password are required when relay is enabled.', 'error');
      return null;
    }
  }

  return {
    enabled,
    host,
    port,
    tlsPort,
    username,
    password
  };
}

async function loadRoomConfig(roomName) {
  if (!roomName) return;
  const resp = await emitWithAck('get-room-config', { roomName });
  if (resp?.ok) {
    applyPaymentConfig(resp);
    applyTurnConfig(resp.turnConfig);
  }
}

function isValidPaymentUrl(value) {
  return value.startsWith('http://') || value.startsWith('https://');
}

if (dom.paymentSaveBtn) {
  dom.paymentSaveBtn.onclick = () => {
    if (!state.currentRoom) {
      setPaymentStatus('Join a room to save payment settings.', 'error');
      return;
    }

    const enabled = !!dom.paymentEnableToggle?.checked;
    const label = dom.paymentLabelInput?.value.trim() || '';
    const url = dom.paymentUrlInput?.value.trim() || '';

    if (url && !isValidPaymentUrl(url)) {
      setPaymentStatus('Payment URL must start with http(s).', 'error');
      return;
    }

    socket.emit(
      'update-room-payments',
      {
        roomName: state.currentRoom,
        paymentEnabled: enabled,
        paymentLabel: label,
        paymentUrl: url
      },
      (resp) => {
        if (resp?.ok) {
          state.paymentEnabled = enabled;
          state.paymentLabel = label;
          state.paymentUrl = url;
          setPaymentStatus('Payment settings saved.');
        } else {
          setPaymentStatus(resp?.error || 'Unable to save payment settings.', 'error');
        }
      }
    );
  };
}

function renderVipUsers() {
  if (!dom.vipUserList) return;
  dom.vipUserList.innerHTML = '';
  state.vipUsers.forEach((name) => {
    const tag = document.createElement('span');
    tag.style.cssText =
      'background:rgba(255,255,255,0.1); color:#fff; padding:2px 6px; border-radius:4px; font-size:0.7rem;';
    tag.textContent = name;
    dom.vipUserList.appendChild(tag);
  });
}

function renderVipCodes() {
  if (!dom.vipCodeList) return;
  dom.vipCodeList.innerHTML = '';
  state.vipCodes.forEach((entry) => {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex; align-items:center; justify-content:space-between; gap:6px; background:rgba(255,255,255,0.06); padding:4px 6px; border-radius:6px; font-size:0.7rem;';

    const label = document.createElement('span');
    if (typeof entry === 'string') {
      label.textContent = entry;
    } else {
      const remaining = Number.isFinite(entry.usesLeft)
        ? entry.usesLeft
        : Math.max(0, (entry.maxUses || 0) - (entry.used || 0));
      label.textContent = `${entry.code} (${remaining}/${entry.maxUses})`;
    }

    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'btn small danger';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.onclick = () => {
      if (!state.currentRoom || !entry?.code) return;
      socket.emit('revoke-vip-code', { roomName: state.currentRoom, code: entry.code }, (resp) => {
        if (!resp?.ok) {
          setVipStatus(resp?.error || 'Unable to revoke VIP code.', 'error');
        } else {
          setVipStatus('VIP code revoked.');
        }
      });
    };

    row.appendChild(label);
    if (entry?.code) {
      row.appendChild(revokeBtn);
    }
    dom.vipCodeList.appendChild(row);
  });
}

if (dom.addVipUserBtn) {
  dom.addVipUserBtn.onclick = () => {
    if (!dom.vipUserInput || !state.currentRoom) return;
    const userName = dom.vipUserInput.value.trim();
    if (!userName) return;
    socket.emit('add-vip-user', { room: state.currentRoom, userName }, (resp) => {
      if (resp?.ok) {
        if (!state.vipUsers.some((u) => u.toLowerCase() === userName.toLowerCase())) {
          state.vipUsers.push(userName);
          renderVipUsers();
        }
        setVipStatus('VIP user added.');
        dom.vipUserInput.value = '';
        updateVipActionAvailability();
      } else {
        setVipStatus(resp?.error || 'Unable to add VIP user.', 'error');
      }
    });
  };
}

if (dom.vipUserInput) {
  dom.vipUserInput.addEventListener('input', () => {
    updateVipActionAvailability();
  });
}

if (dom.generateVipCodeBtn) {
  dom.generateVipCodeBtn.onclick = () => {
    if (!state.currentRoom) return;
    const maxUses = dom.vipCodeUses ? Number(dom.vipCodeUses.value) : 1;
    socket.emit('generate-vip-code', { room: state.currentRoom, maxUses }, (resp) => {
      if (resp?.ok && resp?.code) {
        state.vipCodes.push({
          code: resp.code,
          maxUses: resp.maxUses || maxUses || 1,
          usesLeft: resp.usesLeft ?? resp.maxUses ?? maxUses ?? 1
        });
        renderVipCodes();
        setVipStatus('VIP code generated.');
      } else {
        setVipStatus(resp?.error || 'Unable to generate VIP code.', 'error');
      }
    });
  };
}

if (dom.togglePrivateBtn) {
  dom.togglePrivateBtn.onclick = () => {
    if (!canUpdateRoomSettings()) {
      setVipStatus('Join a room to change privacy.', 'error');
      return;
    }
    applyPrivacyState(!state.isPrivateMode);
  };
}

if (dom.publicRoomToggle) {
  dom.publicRoomToggle.onchange = () => {
    if (!canUpdateRoomSettings()) {
      setVipStatus('Join a room to change privacy.', 'error');
      dom.publicRoomToggle.checked = !state.isPrivateMode;
      return;
    }
    applyPrivacyState(!dom.publicRoomToggle.checked);
  };
}

if (dom.vipRequiredToggle) {
  dom.vipRequiredToggle.onclick = () => {
    if (!canUpdateRoomSettings()) {
      setVipStatus('Join a room to change VIP access.', 'error');
      return;
    }
    applyVipRequiredState(!state.vipRequired);
  };
}

if (dom.turnSaveBtn) {
  dom.turnSaveBtn.onclick = () => {
    if (!state.currentRoom) return;
    const turnConfig = collectTurnConfigFromInputs();
    if (!turnConfig) return;
    socket.emit('update-room-turn', { roomName: state.currentRoom, turnConfig }, (resp) => {
      if (!resp?.ok) {
        setTurnStatus(resp?.error || 'Unable to save TURN settings.', 'error');
        return;
      }
      applyTurnConfig(turnConfig);
      setTurnStatus(
        turnConfig.enabled ? 'Relay enabled for this room.' : 'Relay disabled for this room.'
      );
    });
  };
}

// ======================================================
// 13. CHAT SYSTEM
// ======================================================
function appendChat(log, name, text, ts) {
  if (!log) return;

  const d = document.createElement('div');
  d.className = 'chat-line';

  const s = document.createElement('strong');
  s.textContent = name;

  const t = document.createElement('small');
  t.textContent = new Date(ts).toLocaleTimeString();

  d.appendChild(s);
  d.appendChild(document.createTextNode(' '));
  d.appendChild(t);
  d.appendChild(document.createTextNode(`: ${text}`));

  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function sendPublic() {
  if (dom.contentStream && !dom.contentStream.classList.contains('active')) return;
  if (!dom.inputPublic) return;
  const t = dom.inputPublic.value.trim();
  if (!t || !state.currentRoom) return;

  socket.emit('public-chat', {
    room: state.currentRoom,
    name: state.userName,
    text: t
  });

  dom.inputPublic.value = '';
}

if (dom.btnSendPublic) {
  dom.btnSendPublic.onclick = sendPublic;
}

if (dom.inputPublic) {
  dom.inputPublic.onkeydown = (e) => {
    if (e.key === 'Enter') sendPublic();
  };
}

function sendPrivate() {
  if (dom.contentRoom && !dom.contentRoom.classList.contains('active')) return;
  if (!dom.inputPrivate) return;
  const t = dom.inputPrivate.value.trim();
  if (!t || !state.currentRoom) return;

  socket.emit('private-chat', {
    room: state.currentRoom,
    name: state.userName,
    text: t
  });

  dom.inputPrivate.value = '';
}

if (dom.btnSendPrivate) {
  dom.btnSendPrivate.onclick = sendPrivate;
}

if (dom.inputPrivate) {
  dom.inputPrivate.onkeydown = (e) => {
    if (e.key === 'Enter') sendPrivate();
  };
}

socket.on('public-chat', (d) => {
  if (state.mutedUsers.has(d.name)) return;
  const log = $('chatLogPublic');
  appendChat(log, d.name, d.text, d.ts);
  if (tabs.stream && !tabs.stream.classList.contains('active')) {
    tabs.stream.classList.add('has-new');
  }

  if (state.overlayActive) {
    renderHTMLLayout(state.currentRawHTML);
  }
});

socket.on('private-chat', (d) => {
  const log = $('chatLogPrivate');
  appendChat(log, d.name, d.text, d.ts);
  if (tabs.room && !tabs.room.classList.contains('active')) {
    tabs.room.classList.add('has-new');
  }
});

if (dom.emojiStripPublic) {
  dom.emojiStripPublic.onclick = (e) => {
    const emoji = e.target.closest?.('.emoji');
    if (emoji) {
      if (dom.inputPublic) {
        dom.inputPublic.value += emoji.textContent;
        dom.inputPublic.focus();
      }
    }
  };
}

if (dom.emojiStripPrivate) {
  dom.emojiStripPrivate.onclick = (e) => {
    const emoji = e.target.closest?.('.emoji');
    if (emoji) {
      if (dom.inputPrivate) {
        dom.inputPrivate.value += emoji.textContent;
        dom.inputPrivate.focus();
      }
    }
  };
}

// ======================================================
// 14. FILE SHARING (TAB)
// ======================================================
if (dom.fileInput) {
  dom.fileInput.onchange = () => {
    if (dom.fileInput.files.length) {
      if (dom.fileNameLabel) dom.fileNameLabel.textContent = dom.fileInput.files[0].name;
      if (dom.sendFileBtn) dom.sendFileBtn.disabled = false;
    }
  };
}

if (dom.sendFileBtn) {
  dom.sendFileBtn.onclick = () => {
    if (!dom.fileInput || !dom.fileInput.files.length || !state.currentRoom) return;

    const f = dom.fileInput.files[0];

    if (f.size > 10 * 1024 * 1024) {
      alert("File too large (Limit: 10MB). Use 'Arcade'.");
      return;
    }

    const r = new FileReader();
    r.onload = () => {
      socket.emit('file-share', {
        room: state.currentRoom,
        name: state.userName,
        fileName: f.name,
        fileData: r.result
      });
      dom.fileInput.value = '';
      if (dom.fileNameLabel) dom.fileNameLabel.textContent = 'No file selected';
      dom.sendFileBtn.disabled = true;
    };
    r.readAsDataURL(f);
  };
}

socket.on('file-share', (d) => {
  const div = document.createElement('div');
  div.className = 'file-item';

  const info = document.createElement('div');
  const b = document.createElement('strong');
  b.textContent = d.name;
  info.appendChild(b);
  info.appendChild(document.createTextNode(` shared: ${d.fileName}`));

  const link = document.createElement('a');
  link.href = d.fileData;
  link.download = d.fileName;
  link.className = 'btn small primary';
  link.textContent = 'Download';

  div.appendChild(info);
  div.appendChild(link);

  if (dom.fileLog) dom.fileLog.appendChild(div);

  if (tabs.files && !tabs.files.classList.contains('active')) {
    tabs.files.classList.add('has-new');
  }
});

// ======================================================
// 15. ARCADE & HTML OVERLAY
// ======================================================
if (dom.arcadeInput) {
  dom.arcadeInput.onchange = () => {
    const f = dom.arcadeInput.files[0];
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
// 16. USER LIST & MIXER SELECTION (UPDATED: Stats Support)
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
