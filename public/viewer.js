const $ = (id) => document.getElementById(id);
const socket = io({ autoConnect: false });

// ICE config (uses ICE_SERVERS from ice.js if present, else Google STUN)
const iceConfig = (typeof ICE_SERVERS !== 'undefined' && Array.isArray(ICE_SERVERS) && ICE_SERVERS.length)
  ? { iceServers: ICE_SERVERS }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const state = {
  pc: null,
  hostId: null,
  currentRoom: null,
  myName: `Viewer-${Math.floor(Math.random() * 1000)}`,
  callPc: null,
  localCallStream: null,
  statsInterval: null
};

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
socket.on('connect', () => {
  const status = $('viewerStatus');
  if (status) status.textContent = 'CONNECTED';
});

socket.on('disconnect', () => {
  const status = $('viewerStatus');
  if (status) {
    status.textContent = 'OFFLINE';
    status.classList.remove('live');
  }
});

socket.on('webrtc-offer', async ({ sdp, from }) => {
  try {
    state.hostId = from;

    if (state.pc) {
      try {
        state.pc.close();
      } catch (e) {}
      state.pc = null;
    }

    state.pc = new RTCPeerConnection(iceConfig);
    setupReceiver(state.pc);

    state.pc.ontrack = (e) => {
      const v = $('viewerVideo');
      if (!v) return;
      if (v.srcObject !== e.streams[0]) {
        v.srcObject = e.streams[0];
        v.play().catch(() => {});
      }
      const status = $('viewerStatus');
      if (status) {
        status.textContent = 'LIVE';
        status.classList.add('live');
      }
    };

    state.pc.onicecandidate = (e) => {
      if (e.candidate && state.hostId) {
        socket.emit('webrtc-ice-candidate', {
          targetId: state.hostId,
          candidate: e.candidate
        });
      }
    };

    await state.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      targetId: state.hostId,
      sdp: answer
    });

    startStatsReporting(state.pc);
  } catch (err) {
    console.error('[Viewer] webrtc-offer failed', err);
  }
});

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  if (!state.pc || !candidate) return;
  try {
    await state.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('[Viewer] addIceCandidate failed', err);
  }
});

// ======================================================
// 3. ON-STAGE CALL (host ↔ viewer 1-to-1 call)
// ======================================================
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

socket.on('ring-alert', async ({ from, fromId }) => {
  const ok = confirm(
    `Host ${from} wants to bring you on stage.\n\nAllow camera & mic?`
  );
  if (!ok) return;

  try {
    await ensureLocalCallStream();
    await startCallToHost(fromId);
  } catch (err) {
    console.error('[Viewer] stage call failed', err);
    alert('Could not access your camera/mic. Check permissions and try again.');
  }
});

async function startCallToHost(targetId) {
  if (!targetId) return;

  await ensureLocalCallStream();

  if (state.callPc) {
    try {
      state.callPc.close();
    } catch (e) {}
    state.callPc = null;
  }

  const pc2 = new RTCPeerConnection(iceConfig);
  state.callPc = pc2;

  pc2.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('call-ice', {
        targetId,
        candidate: e.candidate
      });
    }
  };

  pc2.ontrack = (e) => {
    console.log('[Viewer] host call track', e.streams[0]);
  };

  state.localCallStream.getTracks().forEach((t) => pc2.addTrack(t, state.localCallStream));

  const offer = await pc2.createOffer();
  await pc2.setLocalDescription(offer);

  socket.emit('call-offer', {
    targetId,
    offer
  });
}

socket.on('call-answer', async ({ from, answer }) => {
  if (!state.callPc || !answer) return;
  try {
    await state.callPc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error('[Viewer] remote answer failed', err);
  }
});

socket.on('call-ice', async ({ from, candidate }) => {
  if (!state.callPc || !candidate) return;
  try {
    await state.callPc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('[Viewer] call ICE failed', err);
  }
});

socket.on('call-end', ({ from }) => {
  if (state.callPc) {
    try {
      state.callPc.close();
    } catch (e) {}
    state.callPc = null;
  }
});

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

socket.on('public-chat', (d) => {
  appendChat(d.name, d.text);
});

socket.on('kicked', () => {
  alert('You have been kicked from the room by the host.');
  window.location.href = 'index.html';
});

socket.on('room-error', (err) => {
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

  input.value = '';
}

window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room') || 'lobby';
  const nameParam = params.get('name');

  if (nameParam && nameParam.trim()) {
    state.myName = nameParam.trim().slice(0, 30);
  } else {
    const entered = prompt('Enter your display name:', state.myName);
    if (entered && entered.trim()) {
      state.myName = entered.trim().slice(0, 30);
    }
  }

  state.currentRoom = room;

  const nameLabel = $('viewerNameLabel');
  if (nameLabel) nameLabel.textContent = state.myName;

  socket.connect();
  socket.emit('join-room', {
    room,
    name: state.myName,
    isViewer: true
  });

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
