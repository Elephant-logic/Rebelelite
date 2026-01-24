// ======================================================
// SIGNALING MAP (Current Behavior - No Changes)
// ======================================================
// [HOST]  -> (join-room)        -> [SERVER]
// [VIEWER]-> (join-room)        -> [SERVER]
// [HOST]  -> (webrtc-offer)     -> [SERVER] -> [VIEWER]
// [VIEWER]-> (webrtc-answer)    -> [SERVER] -> [HOST]
// [HOST]  -> (ice-candidate)    -> [SERVER] -> [VIEWER]
// [VIEWER]-> (ice-candidate)    -> [SERVER] -> [HOST]

// ======================================================
// WEBRTC HANDSHAKE FLOW (Viewer Perspective - Existing Order)
// ======================================================
// 1) Viewer joins room.
// 2) Host creates and sends offer (relayed by server).
// 3) Viewer sets remote description.
// 4) Viewer creates answer and sends it back.
// 5) ICE candidates exchanged both directions.
// 6) PeerConnection connects and stream is displayed.

const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });
const DEBUG_SIGNAL = window.localStorage.getItem('debugSignal') === '1';

function getRtcConfig() {
  return { iceServers: getIceServers(state.turnConfig) };
}

const state = {
  pc: null,
  hostId: null,
  currentRoom: null,
  myName: `Viewer-${Math.floor(Math.random() * 1000)}`,
  broadcastStream: null,
  callPc: null,
  localCallStream: null,
  statsInterval: null,
  joined: false,
  roomPrivacy: 'public',
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

// ======================================================
// REAL-TIME HEALTH REPORTING (Professional Patch)
// ======================================================
function startStatsReporting(peer) {
  if (state.statsInterval) clearInterval(state.statsInterval);
  state.statsInterval = setInterval(async () => {
    if (!peer || peer.connectionState !== 'connected') return;

    const stats = await peer.getStats();
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        const latency = Math.round((report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000) || 0;

        const badge = $('latencyBadge');
        const mirror = $('viewerStatusMirror');
        if (badge) {
          badge.innerHTML = `⏱️ ${latency}ms`;
          badge.style.display = 'inline-block';
          badge.style.color = latency > 200 ? '#ff4b6a' : '#9ba3c0';
        }
        if (mirror) mirror.innerHTML = `${latency}ms`;

        socket.emit('report-stats', { latency });
      }
    });
  }, 2000);
}

// ======================================================
// 1. ARCADE RECEIVER (P2P game/tool file from host)
// ======================================================
function setupReceiver(pcInstance) {
  pcInstance.ondatachannel = (e) => {
    if (e.channel.label !== 'side-load-pipe') return;

    const chan = e.channel;
    let chunks = [];
    let meta = null;
    let received = 0;

    chan.onmessage = (evt) => {
      if (!meta && typeof evt.data === 'string') {
        try {
          const parsed = JSON.parse(evt.data);
          if (parsed && parsed.type === 'meta') {
            meta = parsed;
            received = 0;
            chunks = [];
            console.log('[Arcade] Receiving:', meta.name, meta.size);
            return;
          }
        } catch (err) {
          console.warn('[Arcade] Bad meta', err);
        }
        return;
      }

      if (!meta) return;

      chunks.push(evt.data);
      received += evt.data.byteLength || evt.data.size || 0;

      if (received >= meta.size) {
        const blob = new Blob(chunks, {
          type: meta.mime || 'application/octet-stream'
        });
        const url = URL.createObjectURL(blob);

        const toolbox = $('toolboxContainer');
        if (toolbox) {
          const card = document.createElement('div');
          card.className = 'toolbox-card';

          const title = document.createElement('div');
          title.className = 'toolbox-title';
          title.textContent = meta.name || 'Tool';

          const actions = document.createElement('div');
          actions.className = 'toolbox-actions';

          const a = document.createElement('a');
          a.href = url;
          a.download = meta.name || 'download.bin';
          a.className = 'btn-ctrl pulse-primary';
          a.textContent = 'Download';

          actions.appendChild(a);
          card.appendChild(title);
          card.appendChild(actions);
          toolbox.appendChild(card);
        }

        console.log('[Arcade] Complete:', meta.name);
        meta = null;
        chunks = [];
        received = 0;
        chan.close();
      }
    };
  };
}

// ======================================================
// 2. STREAM CONNECTION (host → viewer video)
// ======================================================
/**
 * Update the viewer status indicator.
 * Called on socket connect/disconnect and when stream becomes live.
 */
function setViewerStatus(text, isLive) {
    const status = $("viewerStatus");
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('live', !!isLive);
}

/**
 * Attach the remote stream to the viewer video element.
 * Called when the broadcast PeerConnection receives a track.
 */
function attachViewerStream(stream) {
    const v = $("viewerVideo");
    if (!v) return;
    if (v.srcObject !== stream) {
        v.srcObject = stream;
        v.muted = false;
        v.play().catch(() => {});
    }
    setViewerStatus("LIVE", true);
}

/**
 * Create and wire the broadcast PeerConnection (host -> viewer).
 * Called when a webrtc-offer arrives.
 * Signaling direction: [VIEWER] -> (webrtc-answer) -> [SERVER] -> [HOST]
 */
function createBroadcastPeerConnection() {
    const nextPc = new RTCPeerConnection(getRtcConfig());
    attachCandidateDiagnostics(nextPc, 'Broadcast');
    setupReceiver(nextPc);

    if (nextPc.addTransceiver) {
        nextPc.addTransceiver('video', { direction: 'recvonly' });
        nextPc.addTransceiver('audio', { direction: 'recvonly' });
    }

    nextPc.ontrack = (e) => {
        if (DEBUG_SIGNAL) {
            console.log('[Viewer] broadcast ontrack', {
                track: e.track && e.track.kind
            });
        }
        if (!state.broadcastStream) {
            state.broadcastStream = new MediaStream();
        }
        if (e.track && !state.broadcastStream.getTracks().includes(e.track)) {
            state.broadcastStream.addTrack(e.track);
        }
        attachViewerStream(state.broadcastStream);
    };

    nextPc.onicecandidate = (e) => {
        if (e.candidate && state.hostId) {
            socket.emit("webrtc-ice-candidate", {
                targetId: state.hostId,
                candidate: e.candidate
            });
        }
    };

    return nextPc;
}

/**
 * Handle an incoming broadcast offer from the host.
 * Called when the server relays webrtc-offer.
 */
async function handleBroadcastOffer({ sdp, from }) {
    try {
        if (DEBUG_SIGNAL) {
            console.log('[Viewer] received webrtc-offer', { from });
        }
        state.hostId = from;

        if (state.pc) {
            try {
                state.pc.close();
            } catch (e) {}
            state.pc = null;
        }
        state.broadcastStream = new MediaStream();

        await fetchRoomConfig(state.currentRoom);
        state.pc = createBroadcastPeerConnection();

        await state.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);

        socket.emit("webrtc-answer", {
            targetId: state.hostId,
            sdp: answer
        });
        if (DEBUG_SIGNAL) {
            console.log('[Viewer] sent webrtc-answer', { targetId: state.hostId });
        }

        // NEW: Initiate stats polling
        startStatsReporting(state.pc);
    } catch (err) {
        console.error("[Viewer] webrtc-offer failed", err);
    }
}

/**
 * Handle incoming ICE candidates for the broadcast PeerConnection.
 * Called when the server relays webrtc-ice-candidate.
 */
async function handleBroadcastIceCandidate({ candidate }) {
    if (!state.pc || !candidate) return;
    try {
        await state.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("[Viewer] addIceCandidate failed", err);
    }
}

socket.on("connect", () => {
    setViewerStatus("CONNECTED", false);
});

socket.on("disconnect", () => {
    setViewerStatus("OFFLINE", false);
});

socket.on('viewer-joined', ({ streamStatus } = {}) => {
    const isLive = streamStatus === 'LIVE';
    setViewerStatus(isLive ? 'LIVE' : 'CONNECTED', isLive);
});

socket.on("webrtc-offer", handleBroadcastOffer);
socket.on("webrtc-ice-candidate", handleBroadcastIceCandidate);

// ======================================================
// 3. ON-STAGE CALL (host ↔ viewer 1-to-1 call)
// ======================================================
/**
 * Ensure we have a local cam/mic stream for stage calls.
 * Called before creating a call offer or answer.
 * PeerConnection impact: supplies local tracks for callPc.
 */
async function ensureLocalCallStream() {
  if (
    state.localCallStream &&
    state.localCallStream.getTracks().some((t) => t.readyState === 'live')
  ) {
    return;
  }

  state.localCallStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } }
  });

  const prev = $('selfCamPreview');
  if (prev) {
    prev.srcObject = state.localCallStream;
    prev.muted = true;
    prev.play().catch(() => {});
  }
}

/**
 * Handle host ring to bring viewer on stage.
 * Signaling direction: [HOST] -> (ring-user) -> [SERVER] -> [VIEWER]
 */
async function handleRingAlert({ from, fromId }) {
    const ok = confirm(
        `Host ${from} wants to bring you on stage.\n\nAllow camera & mic?`
    );
    if (!ok) return;

    try {
        await ensureLocalCallStream();
        await startCallToHost(fromId);
    } catch (err) {
        console.error("[Viewer] stage call failed", err);
        alert("Could not access your camera/mic. Check permissions and try again.");
    }
}

socket.on("ring-alert", handleRingAlert);

/**
 * Create and wire the viewer's call PeerConnection.
 * Called when accepting a ring or when restarting a call.
 * Signaling direction: [VIEWER] -> (call-offer) -> [SERVER] -> [HOST]
 */
function createCallPeerConnection() {
    const pc2 = new RTCPeerConnection(getRtcConfig());
    attachCandidateDiagnostics(pc2, 'Call');
    state.callPc = pc2;

    pc2.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit("call-ice", {
                targetId: state.hostId,
                candidate: e.candidate
            });
        }
    };

  pc2.ontrack = (e) => {
    console.log('[Viewer] host call track', e.streams[0]);
  };

    state.localCallStream.getTracks().forEach((t) => pc2.addTrack(t, state.localCallStream));
    return pc2;
}

/**
 * Start a call offer toward the host.
 * Called after the host rings the viewer.
 */
async function startCallToHost(targetId) {
    if (!targetId) return;

    await ensureLocalCallStream();

    if (state.callPc) {
        try {
            state.callPc.close();
        } catch (e) {}
        state.callPc = null;
    }

    state.hostId = targetId;
    const pc2 = createCallPeerConnection();

  const offer = await pc2.createOffer();
  await pc2.setLocalDescription(offer);

    socket.emit("call-offer", {
        targetId: state.hostId,
        offer
    });
}

/**
 * Apply the host's answer to the viewer call offer.
 * Called when the server relays call-answer.
 */
async function handleCallAnswer({ from, answer }) {
    if (!state.callPc || !answer) return;
    try {
        await state.callPc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
        console.error("[Viewer] remote answer failed", err);
    }
}

/**
 * Handle ICE candidates for the on-stage call.
 * Signaling direction: [HOST] -> (call-ice) -> [SERVER] -> [VIEWER]
 */
async function handleCallIce({ from, candidate }) {
    if (!state.callPc || !candidate) return;
    try {
        await state.callPc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("[Viewer] call ICE failed", err);
    }
}

/**
 * End the on-stage call from host instruction.
 * Signaling direction: [HOST] -> (call-end) -> [SERVER] -> [VIEWER]
 */
function handleCallEnd({ from }) {
    if (state.callPc) {
        try {
            state.callPc.close();
        } catch (e) {}
        state.callPc = null;
    }
}

socket.on("call-answer", handleCallAnswer);
socket.on("call-ice", handleCallIce);
socket.on("call-end", handleCallEnd);

// ======================================================
// 4. CHAT + SYSTEM MESSAGES
// ======================================================
function appendChat(name, text) {
  const log = $('chatLog');
  if (!log) return;

  const div = document.createElement('div');
  div.className = 'chat-line';

  const strong = document.createElement('strong');
  strong.textContent = name;

  const span = document.createElement('span');
  span.textContent = `: ${text}`;

  div.appendChild(strong);
  div.appendChild(span);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function getFriendlyVipMessage(error, hasCode) {
  const normalizedError = (error || '').toLowerCase();
  if (normalizedError.includes('invalid') || normalizedError.includes('exhausted')) {
    return 'That VIP code didn’t work. Please check with the host for a fresh code.';
  }
  if (!hasCode || normalizedError.includes('required')) {
    return 'This room is VIP-only right now. Ask the host for a VIP code to join.';
  }
  return 'This room is VIP-only right now. Ask the host for a VIP code to join.';
}

socket.on('public-chat', (d) => {
  if (DEBUG_SIGNAL) {
    console.log('[Viewer] public-chat received', { name: d.name });
  }
  appendChat(d.name, d.text);
});

socket.on('kicked', () => {
  alert('You have been kicked from the room by the host.');
  window.location.href = 'index.html';
});

socket.on('room-error', (err) => {
  if (!state.joined) {
    const status = $('joinStatus');
    if (status) status.textContent = err || 'Room error';
    return;
  }
  alert(err || 'Room error');
  window.location.href = 'index.html';
});

// ======================================================
// 5. UI WIRING (join room, chat, mute, fullscreen, etc.)
// ======================================================
function sendChat() {
  const input = $('chatInput');
  if (!input || !state.currentRoom) return;

  const text = input.value.trim();
  if (!text) return;

  socket.emit('public-chat', {
    room: state.currentRoom,
    name: state.myName,
    text,
    fromViewer: true
  });
  if (DEBUG_SIGNAL) {
    console.log('[Viewer] public-chat sent', { room: state.currentRoom });
  }

  input.value = '';
}

function emitWithAck(eventName, payload) {
  return new Promise((resolve) => {
    socket.emit(eventName, payload, resolve);
  });
}

async function hydrateRoomInfo(roomName) {
  if (!socket.connected) socket.connect();
  const info = await emitWithAck('get-room-info', { roomName });
  if (info?.privacy) {
    state.roomPrivacy = info.privacy;
  }
  if (typeof info?.vipRequired === 'boolean') {
    state.vipRequired = info.vipRequired;
  }
  const vipLabel = $('viewerVipLabel');
  if (vipLabel) {
    const required = state.roomPrivacy === 'private' && state.vipRequired;
    vipLabel.textContent =
      required
        ? 'VIP Code (required for private rooms)'
        : 'VIP Code (optional)';
  }
}

function applyPaymentConfig(config) {
  state.paymentEnabled = !!config.paymentEnabled;
  state.paymentLabel = config.paymentLabel || '';
  state.paymentUrl = config.paymentUrl || '';

  const button = $('paymentBtn');
  if (!button) return;

  if (state.paymentEnabled && state.paymentUrl) {
    button.textContent = state.paymentLabel || 'Tip the host';
    button.style.display = 'inline-block';
    button.onclick = () => {
      window.open(state.paymentUrl, '_blank', 'noopener');
    };
  } else {
    button.style.display = 'none';
    button.onclick = null;
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
}

async function fetchRoomConfig(roomName) {
  if (!socket.connected) socket.connect();
  const config = await emitWithAck('get-room-config', { roomName });
  if (config?.ok) {
    applyPaymentConfig(config);
    applyTurnConfig(config.turnConfig);
  }
}

window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room') || 'lobby';
  const nameParam = params.get('name');
  const vipParam = params.get('vipCode') || params.get('vip');
  const vipTokenParam = params.get('vipToken');

  if (nameParam && nameParam.trim()) {
    state.myName = nameParam.trim().slice(0, 30);
  }

  state.currentRoom = room;

  const nameInput = $('viewerNameInput');
  if (nameInput && state.myName) nameInput.value = state.myName;

  const vipInput = $('viewerVipCodeInput');
  if (vipInput && vipParam && vipParam.trim()) vipInput.value = vipParam.trim().slice(0, 20);

  const joinPanel = $('viewerJoinPanel');
  const joinBtn = $('joinRoomBtn');
  const joinStatus = $('joinStatus');
  let activeVipToken = vipTokenParam ? vipTokenParam.trim() : '';

  const roomInfoPromise = hydrateRoomInfo(room);

  const completeJoin = (vipToken) => {
    const codeValue = vipToken ? '' : vipInput?.value.trim();
    if (!socket.connected) socket.connect();
      socket.emit(
        'join-room',
        {
          room: state.currentRoom,
          name: state.myName,
          isViewer: true,
          vipToken,
          vipCode: codeValue
        },
        (resp) => {
          if (resp?.ok) {
            state.joined = true;
            if (joinPanel) joinPanel.classList.add('hidden');
            if (joinStatus) joinStatus.textContent = '';
            socket.emit('viewer-ready', {
              room: state.currentRoom,
              name: state.myName
            });
            fetchRoomConfig(state.currentRoom);
          } else {
            if (joinStatus) {
              const errorText = resp?.error || '';
            const hasVipCode = !!codeValue;
            const vipMessage =
              state.roomPrivacy === 'private' && state.vipRequired
                ? getFriendlyVipMessage(errorText, hasVipCode)
                : '';
            joinStatus.textContent = vipMessage || errorText || 'Unable to join room.';
          }
        }
      }
    );
  };

  const attemptJoin = async () => {
    if (DEBUG_SIGNAL) {
      console.log('[Viewer] join-room click');
    }
    await roomInfoPromise;
    const chosenName = (nameInput?.value || state.myName || '').trim();
    if (!chosenName) {
      if (joinStatus) joinStatus.textContent = 'Please enter a display name.';
      return;
    }

    state.myName = chosenName.slice(0, 30);
    if (joinStatus) joinStatus.textContent = 'Connecting...';

    if (activeVipToken) {
      completeJoin(activeVipToken);
      return;
    }

    completeJoin('');
  };

  if (joinBtn) joinBtn.onclick = attemptJoin;
  if (nameInput) {
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter') attemptJoin();
    };
  }
  if (vipInput) {
    vipInput.onkeydown = (e) => {
      if (e.key === 'Enter') attemptJoin();
    };
  }

  const nameLabel = $('viewerNameLabel');
  if (nameLabel) nameLabel.textContent = state.myName;

  const sendBtn = $('sendBtn');
  const chatInput = $('chatInput');
  if (sendBtn && chatInput) {
    sendBtn.onclick = sendChat;
    chatInput.onkeydown = (e) => {
      if (e.key === 'Enter') sendChat();
    };
  }

  const emojiStrip = $('emojiStrip');
  if (emojiStrip && chatInput) {
    emojiStrip.onclick = (e) => {
      if (e.target.classList.contains('emoji')) {
        chatInput.value += e.target.textContent;
        chatInput.focus();
      }
    };
  }

  const requestBtn = $('requestCallBtn');
  if (requestBtn) {
    requestBtn.onclick = () => {
      socket.emit('request-to-call');
      document.body.classList.add('hand-active');
      requestBtn.textContent = 'Request Sent ✋';
      requestBtn.disabled = true;
    };
  }

  const unmuteBtn = $('unmuteBtn');
  if (unmuteBtn) {
    unmuteBtn.onclick = () => {
      const v = $('viewerVideo');
      if (!v) return;
      const willUnmute = v.muted;

      v.muted = !v.muted;
      v.volume = v.muted ? 0.0 : 1.0;

      if (willUnmute) {
        v.play().catch(() => {});
        unmuteBtn.textContent = '🔊 Mute';
        unmuteBtn.classList.remove('pulse-primary');
      } else {
        unmuteBtn.textContent = '🔇 Unmute';
      }
    };
  }

  const fsBtn = $('fullscreenBtn');
  if (fsBtn) {
    fsBtn.onclick = () => {
      const v = $('viewerVideo');
      if (!v) return;
      if (v.requestFullscreen) v.requestFullscreen();
      else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
      else if (v.msRequestFullscreen) v.msRequestFullscreen();
    };
  }

  const toggleChatBtn = $('toggleChatBtn');
  if (toggleChatBtn) {
    toggleChatBtn.onclick = () => {
      const box = $('chatBox');
      if (!box) return;
      box.classList.toggle('hidden');
    };
  }
});

// ======================================================
// HELPER / GUIDE (Developer Notes)
// ======================================================
// - Signaling system:
//   * Viewer joins room, waits for host webrtc-offer.
//   * Viewer answers and exchanges ICE via the server.
// - Mixer + WebRTC:
//   * Viewer receives a single mixed canvas stream from the host.
//   * The mixer composition is controlled entirely in app.js.
// - Adding overlays in the future:
//   * Overlays should be drawn into the host mixer canvas.
//   * Viewer only needs to display the incoming stream.
