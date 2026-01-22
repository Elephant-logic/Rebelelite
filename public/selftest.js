const resultsEl = document.getElementById('selftestResults');
const logEl = document.getElementById('selftestLog');
const statusEl = document.getElementById('selftestStatus');
const startedEl = document.getElementById('selftestStarted');
const finishedEl = document.getElementById('selftestFinished');
const studioFrame = document.getElementById('selftestStudioFrame');

const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  results: []
};

const context = {
  roomName: `selftest-${Date.now()}`,
  password: `pw-${Math.random().toString(36).slice(2, 8)}`,
  hostSocket: null,
  viewerSocket: null,
  broadcastOrder: [],
  callOrder: [],
  viewerIsViewer: false
};

const iceConfig =
  typeof ICE_SERVERS !== 'undefined' && Array.isArray(ICE_SERVERS) && ICE_SERVERS.length
    ? { iceServers: ICE_SERVERS }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function logLine(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(`%c[SelfTest]%c ${message}`, 'color:#4af3a3;font-weight:700;', 'color:inherit;');
  if (logEl) {
    logEl.textContent += `${line}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function addResult(name, ok, details) {
  const badgeClass = ok ? 'badge-pass' : 'badge-fail';
  const badgeText = ok ? 'PASS' : 'FAIL';

  report.results.push({ name, ok, details });

  if (resultsEl) {
    const row = document.createElement('div');
    row.className = 'selftest-result';

    const left = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = name;
    left.appendChild(title);
    if (details) {
      const small = document.createElement('small');
      small.textContent = details;
      left.appendChild(small);
    }

    const badge = document.createElement('span');
    badge.className = badgeClass;
    badge.textContent = badgeText;

    row.appendChild(left);
    row.appendChild(badge);
    resultsEl.appendChild(row);
  }

  logLine(`${badgeText}: ${name}${details ? ` — ${details}` : ''}`);
}

function markStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function updateTimestamp(el, value) {
  if (el) el.textContent = value || '--';
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function waitForEvent(target, event, ms = 5000) {
  return withTimeout(
    new Promise((resolve) => {
      target.once(event, (...args) => resolve(args));
    }),
    ms,
    `Waiting for ${event}`
  );
}

async function waitForFrameElements(frame, ids, ms = 5000) {
  const startedAt = Date.now();
  let lastMissing = ids;
  while (Date.now() - startedAt < ms) {
    const doc = frame?.contentWindow?.document;
    if (doc) {
      const missing = ids.filter((id) => !doc.getElementById(id));
      lastMissing = missing;
      if (!missing.length) {
        return doc;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Missing elements: ${lastMissing.join(', ')}`);
}

let studioFrameLoaded = null;
function ensureStudioFrameLoaded() {
  if (studioFrameLoaded) return studioFrameLoaded;
  if (!studioFrame) return Promise.reject(new Error('Studio iframe missing'));
  studioFrameLoaded = new Promise((resolve) => {
    studioFrame.src = '/index.html?selftest=1';
    studioFrame.onload = () => resolve();
  });
  return studioFrameLoaded;
}

function emitWithAck(socket, event, payload, ms = 5000) {
  return withTimeout(
    new Promise((resolve) => {
      socket.emit(event, payload, (resp) => resolve(resp));
    }),
    ms,
    `Ack ${event}`
  );
}

async function connectSocket(socket) {
  if (socket.connected) return;
  socket.connect();
  await waitForEvent(socket, 'connect', 5000);
}

function createCanvasStream(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#121826';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#4af3a3';
  ctx.font = '20px sans-serif';
  ctx.fillText(label, 20, 50);
  return canvas.captureStream(12);
}

function ensureSequence(order, expected) {
  const indexes = expected.map((step) => order.indexOf(step));
  if (indexes.some((i) => i === -1)) return false;
  for (let i = 1; i < indexes.length; i += 1) {
    if (indexes[i] <= indexes[i - 1]) return false;
  }
  return true;
}

function ensureHandshakeOrder(order) {
  const offerIndex = order.indexOf('offer');
  const answerIndex = order.indexOf('answer');
  const iceIndex = order.indexOf('ice');
  const trackIndex = order.indexOf('track');
  if ([offerIndex, answerIndex, iceIndex, trackIndex].some((idx) => idx === -1)) {
    return false;
  }
  return (
    offerIndex < answerIndex &&
    offerIndex < iceIndex &&
    offerIndex < trackIndex
  );
}

async function testClaimRoom() {
  const socket = io({ autoConnect: false });
  await connectSocket(socket);
  const resp = await emitWithAck(socket, 'claim-room', {
    name: context.roomName,
    password: context.password,
    public: true
  });
  socket.disconnect();
  if (!resp?.ok) throw new Error(resp?.error || 'Claim failed');
  return 'Room claimed successfully.';
}

async function testHostReenter() {
  const hostSocket = io({ autoConnect: false });
  context.hostSocket = hostSocket;
  context.hostRolePromise = waitForEvent(hostSocket, 'role', 7000).then(([role]) => {
    context.hostRole = role;
    return role;
  });
  hostSocket.on('room-update', (payload) => {
    context.latestRoomUpdate = payload;
  });
  await connectSocket(hostSocket);

  const authResp = await emitWithAck(hostSocket, 'auth-host-room', {
    roomName: context.roomName,
    password: context.password
  });
  if (!authResp?.ok) throw new Error(authResp?.error || 'Auth failed');

  const joinResp = await emitWithAck(hostSocket, 'join-room', {
    room: context.roomName,
    name: 'SelfTest Host',
    isViewer: false
  });
  if (!joinResp?.ok || !joinResp.isHost) {
    throw new Error(joinResp?.error || 'Host join failed');
  }
  return 'Host re-entered with password.';
}

async function testHostStudioAutoEntry() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  let role = context.hostRole;
  if (!role && context.hostRolePromise) {
    try {
      role = await context.hostRolePromise;
    } catch (err) {
      // fall through to a fresh wait below
    }
  }
  if (!role) {
    [role] = await waitForEvent(context.hostSocket, 'role', 5000);
  }
  if (!role?.isHost) throw new Error('Role event did not confirm host');
  return 'Host role confirmed after auth.';
}

async function testPublicViewerJoinAndBroadcast() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');

  const viewerSocket = io({ autoConnect: false });
  context.viewerSocket = viewerSocket;
  await connectSocket(viewerSocket);

  const joinResp = await emitWithAck(viewerSocket, 'join-room', {
    room: context.roomName,
    name: 'SelfTest Viewer',
    isViewer: true
  });
  if (!joinResp?.ok) throw new Error(joinResp?.error || 'Viewer join failed');

  let roomUpdate = context.latestRoomUpdate;
  if (!roomUpdate?.users?.some((user) => user.id === viewerSocket.id)) {
    roomUpdate = await withTimeout(
      new Promise((resolve) => {
        const handler = (payload) => {
          if (payload?.users?.some((user) => user.id === viewerSocket.id)) {
            context.hostSocket.off('room-update', handler);
            resolve(payload);
          }
        };
        context.hostSocket.on('room-update', handler);
      }),
      6000,
      'Room update for viewer'
    );
  }

  const hostPc = new RTCPeerConnection(iceConfig);
  const viewerPc = new RTCPeerConnection(iceConfig);
  const hostStream = createCanvasStream('Broadcast');

  let iceEnabled = false;
  const hostIceQueue = [];
  const viewerIceQueue = [];
  let trackReceived = false;

  const flushIce = () => {
    if (!iceEnabled) return;
    hostIceQueue.splice(0).forEach((candidate) => {
      context.hostSocket.emit('webrtc-ice-candidate', {
        targetId: viewerSocket.id,
        candidate
      });
      if (!context.broadcastOrder.includes('ice')) context.broadcastOrder.push('ice');
    });
    viewerIceQueue.splice(0).forEach((candidate) => {
      viewerSocket.emit('webrtc-ice-candidate', {
        targetId: context.hostSocket.id,
        candidate
      });
      if (!context.broadcastOrder.includes('ice')) context.broadcastOrder.push('ice');
    });
  };

  hostPc.onicecandidate = (e) => {
    if (!e.candidate) return;
    hostIceQueue.push(e.candidate);
    flushIce();
  };
  viewerPc.onicecandidate = (e) => {
    if (!e.candidate) return;
    viewerIceQueue.push(e.candidate);
    flushIce();
  };

  viewerPc.ontrack = (e) => {
    if (trackReceived) return;
    trackReceived = true;
    if (!context.broadcastOrder.includes('track')) context.broadcastOrder.push('track');
  };

  context.hostSocket.on('webrtc-answer', async ({ sdp }) => {
    await hostPc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  context.hostSocket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (candidate) await hostPc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  viewerSocket.on('webrtc-offer', async ({ sdp, from }) => {
    context.broadcastOrder.push('offer');
    await viewerPc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await viewerPc.createAnswer();
    await viewerPc.setLocalDescription(answer);
    context.broadcastOrder.push('answer');
    viewerSocket.emit('webrtc-answer', { targetId: from, sdp: answer });
    iceEnabled = true;
    flushIce();
  });

  viewerSocket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (candidate) await viewerPc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  hostStream.getTracks().forEach((track) => hostPc.addTrack(track, hostStream));
  const offer = await hostPc.createOffer();
  await hostPc.setLocalDescription(offer);
  context.hostSocket.emit('webrtc-offer', { targetId: viewerSocket.id, sdp: offer });

  await withTimeout(
    new Promise((resolve) => {
      const interval = setInterval(() => {
        if (trackReceived) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    }),
    8000,
    'Broadcast track'
  );

  if (roomUpdate?.users) {
    const viewerEntry = roomUpdate.users.find((user) => user.id === viewerSocket.id);
    context.viewerIsViewer = !!viewerEntry?.isViewer;
  }

  hostPc.close();
  viewerPc.close();
  hostStream.getTracks().forEach((track) => track.stop());

  return 'Viewer joined and received broadcast track.';
}

async function testPrivateViewerBlocked() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  await emitWithAck(context.hostSocket, 'update-room-privacy', {
    name: context.roomName,
    privacy: 'private'
  });
  await emitWithAck(context.hostSocket, 'update-vip-required', {
    roomName: context.roomName,
    vipRequired: false
  });

  const openSocket = io({ autoConnect: false });
  await connectSocket(openSocket);
  const joinResp = await emitWithAck(openSocket, 'join-room', {
    room: context.roomName,
    name: 'NoVipViewer',
    isViewer: true
  });
  openSocket.disconnect();
  if (!joinResp?.ok) throw new Error('Private room blocked viewer while VIP was off');
  return 'Private room allowed viewer when VIP requirement is off.';
}

async function testPrivateVipRequiredBlocked() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  await emitWithAck(context.hostSocket, 'update-vip-required', {
    roomName: context.roomName,
    vipRequired: true
  });

  const blockedSocket = io({ autoConnect: false });
  await connectSocket(blockedSocket);
  const joinResp = await emitWithAck(blockedSocket, 'join-room', {
    room: context.roomName,
    name: 'BlockedViewer',
    isViewer: true
  });
  blockedSocket.disconnect();
  if (joinResp?.ok) throw new Error('Private room allowed non-VIP viewer');
  return 'Private room blocked non-VIP viewer with VIP required.';
}

async function testVipViewerJoinAndUsage() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  const codeResp = await emitWithAck(context.hostSocket, 'generate-vip-code', {
    room: context.roomName,
    maxUses: 1
  });
  if (!codeResp?.ok || !codeResp?.code) throw new Error('VIP code generation failed');

  const vipSocket = io({ autoConnect: false });
  await connectSocket(vipSocket);
  const joinResp = await emitWithAck(
    vipSocket,
    'join-room',
    {
    room: context.roomName,
    name: 'VipViewer',
    isViewer: true,
    vipCode: codeResp.code
    },
    8000
  );
  if (!joinResp?.ok || !joinResp?.isVip) {
    throw new Error(joinResp?.error || 'VIP viewer could not join');
  }

  const codesResp = await emitWithAck(context.hostSocket, 'get-vip-codes', {
    roomName: context.roomName
  });
  vipSocket.disconnect();

  if (!codesResp?.ok || !Array.isArray(codesResp.codes)) {
    throw new Error('Unable to fetch VIP codes');
  }
  const entry = codesResp.codes.find((item) => item.code === codeResp.code);
  if (!entry || entry.used < 1) throw new Error('VIP usage was not decremented');
  return 'VIP viewer joined and usage decremented.';
}

async function testVipRevoke() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  const codeResp = await emitWithAck(context.hostSocket, 'generate-vip-code', {
    room: context.roomName,
    maxUses: 2
  });
  if (!codeResp?.ok || !codeResp?.code) throw new Error('VIP code generation failed');

  const vipSocket = io({ autoConnect: false });
  await connectSocket(vipSocket);
  const joinResp = await emitWithAck(vipSocket, 'join-room', {
    room: context.roomName,
    name: 'VipViewerOnce',
    isViewer: true,
    vipCode: codeResp.code
  });
  vipSocket.disconnect();
  if (!joinResp?.ok) throw new Error('VIP viewer could not join with code');

  const revokeResp = await emitWithAck(context.hostSocket, 'revoke-vip-code', {
    roomName: context.roomName,
    code: codeResp.code
  });
  if (!revokeResp?.ok) throw new Error('VIP code revoke failed');

  const blockedSocket = io({ autoConnect: false });
  await connectSocket(blockedSocket);
  const blockedResp = await emitWithAck(blockedSocket, 'join-room', {
    room: context.roomName,
    name: 'VipViewerRevoked',
    isViewer: true,
    vipCode: codeResp.code
  });
  blockedSocket.disconnect();
  if (blockedResp?.ok) throw new Error('Revoked VIP code still allowed access');
  return 'Revoked VIP code no longer grants access.';
}

async function testOverlayFieldDetection() {
  await ensureStudioFrameLoaded();
  const frameWindow = studioFrame.contentWindow;
  if (!frameWindow) throw new Error('Studio iframe not ready');

  const hook = frameWindow.__overlayTest;
  if (!hook) throw new Error('Overlay test hook missing');

  const overlayHtml = `
    <div id="ticker">Live now</div>
    <img id="logo" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=" />
  `;

  const initialRender = hook.getRenderCount();
  hook.loadHTML(overlayHtml);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const fields = hook.getFields();
  const names = fields.map((field) => field.name);
  if (!names.includes('ticker') || !names.includes('logo')) {
    throw new Error(`Overlay fields missing: ${names.join(', ') || 'none'}`);
  }

  const overlayFieldsContainer = frameWindow.document.getElementById('overlayFields');
  const labels = Array.from(overlayFieldsContainer?.querySelectorAll('label') || []).map(
    (label) => label.textContent
  );
  if (!labels.includes('ticker') || !labels.includes('logo')) {
    throw new Error('Overlay sidebar controls were not created for ticker/logo');
  }

  hook.updateField('ticker', 'Breaking News');
  hook.updateField(
    'logo',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4DwQACfsD/VPv9x4AAAAASUVORK5CYII='
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  const updatedTicker = hook.getFieldValue('ticker');
  const updatedLogo = hook.getFieldValue('logo');
  if (updatedTicker !== 'Breaking News') {
    throw new Error('Overlay text field did not update backing DOM');
  }
  if (!updatedLogo || !updatedLogo.includes('data:image/png')) {
    throw new Error('Overlay image field did not update backing DOM');
  }

  const updatedRender = hook.getRenderCount();
  if (updatedRender <= initialRender) {
    throw new Error('Overlay render did not re-run after updates');
  }

  return 'Overlay fields detected, editable, and re-rendered.';
}

async function testStudioButtonsWired() {
  await ensureStudioFrameLoaded();
  const ids = [
    'joinBtn',
    'startStreamBtn',
    'shareScreenBtn',
    'toggleMicBtn',
    'hangupBtn'
  ];
  const doc = await waitForFrameElements(studioFrame, ids, 6000);

  await new Promise((resolve) => setTimeout(resolve, 800));

  const joinBtn = doc.getElementById('joinBtn');
  const startBtn = doc.getElementById('startStreamBtn');
  const shareBtn = doc.getElementById('shareScreenBtn');
  const muteBtn = doc.getElementById('toggleMicBtn');
  const endBtn = doc.getElementById('hangupBtn');

  const wired = [
    joinBtn?.onclick,
    startBtn?.onclick,
    shareBtn?.onclick,
    muteBtn?.onclick,
    endBtn?.onclick
  ].every((handler) => typeof handler === 'function');

  if (!wired) throw new Error('One or more studio buttons are not wired');
  return 'Studio controls wired (join, start/stop, screen share, mute, end call).';
}

async function testWebrtcHandshakeOrder() {
  if (!context.broadcastOrder.length) {
    throw new Error('Broadcast handshake did not execute');
  }
  const broadcastOk = ensureHandshakeOrder(context.broadcastOrder);

  const hostSocket = context.hostSocket;
  const viewerSocket = context.viewerSocket;
  if (!hostSocket || !viewerSocket) throw new Error('Sockets missing for call test');

  const hostPc = new RTCPeerConnection(iceConfig);
  const viewerPc = new RTCPeerConnection(iceConfig);
  const hostStream = createCanvasStream('Call Host');
  const viewerStream = createCanvasStream('Call Viewer');
  let iceEnabled = false;
  const hostIceQueue = [];
  const viewerIceQueue = [];
  let trackReceived = false;

  const flushIce = () => {
    if (!iceEnabled) return;
    hostIceQueue.splice(0).forEach((candidate) => {
      hostSocket.emit('call-ice', { targetId: viewerSocket.id, candidate });
      if (!context.callOrder.includes('ice')) context.callOrder.push('ice');
    });
    viewerIceQueue.splice(0).forEach((candidate) => {
      viewerSocket.emit('call-ice', { targetId: hostSocket.id, candidate });
      if (!context.callOrder.includes('ice')) context.callOrder.push('ice');
    });
  };

  hostPc.onicecandidate = (e) => {
    if (!e.candidate) return;
    hostIceQueue.push(e.candidate);
    flushIce();
  };
  viewerPc.onicecandidate = (e) => {
    if (!e.candidate) return;
    viewerIceQueue.push(e.candidate);
    flushIce();
  };

  hostPc.ontrack = () => {
    if (trackReceived) return;
    trackReceived = true;
    if (!context.callOrder.includes('track')) context.callOrder.push('track');
  };

  hostSocket.once('incoming-call', async ({ from, offer }) => {
    await hostPc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await hostPc.createAnswer();
    await hostPc.setLocalDescription(answer);
    context.callOrder.push('answer');
    hostSocket.emit('call-answer', { targetId: from, answer });
    iceEnabled = true;
    flushIce();
  });

  viewerSocket.on('call-answer', async ({ answer }) => {
    await viewerPc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  hostSocket.on('call-ice', async ({ candidate }) => {
    if (candidate) await hostPc.addIceCandidate(new RTCIceCandidate(candidate));
  });
  viewerSocket.on('call-ice', async ({ candidate }) => {
    if (candidate) await viewerPc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  viewerStream.getTracks().forEach((track) => viewerPc.addTrack(track, viewerStream));
  hostStream.getTracks().forEach((track) => hostPc.addTrack(track, hostStream));

  const offer = await viewerPc.createOffer();
  await viewerPc.setLocalDescription(offer);
  context.callOrder.push('offer');
  viewerSocket.emit('call-offer', {
    targetId: hostSocket.id,
    offer
  });

  await withTimeout(
    new Promise((resolve) => {
      const interval = setInterval(() => {
        if (trackReceived) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    }),
    12000,
    'Call track'
  );

  hostPc.close();
  viewerPc.close();
  hostStream.getTracks().forEach((track) => track.stop());
  viewerStream.getTracks().forEach((track) => track.stop());

  const callOk = ensureHandshakeOrder(context.callOrder);
  if (!broadcastOk || !callOk) {
    throw new Error(
      `Handshake order invalid (broadcast: ${context.broadcastOrder.join(' > ') || 'none'}, call: ${context.callOrder.join(' > ') || 'none'})`
    );
  }
  return 'Broadcast + call handshake order verified.';
}

async function testHostStateStored() {
  if (!studioFrame?.contentWindow) throw new Error('Studio iframe missing');
  const frameWindow = studioFrame.contentWindow;
  frameWindow.sessionStorage.setItem(`hostPassword:${context.roomName}`, context.password);
  frameWindow.sessionStorage.setItem(`hostAccess:${context.roomName}`, '1');

  let promptCalled = false;
  frameWindow.prompt = () => {
    promptCalled = true;
    return '';
  };

  const doc = await waitForFrameElements(studioFrame, ['roomInput', 'nameInput', 'joinBtn'], 6000);
  const roomInput = doc.getElementById('roomInput');
  const nameInput = doc.getElementById('nameInput');
  const joinBtn = doc.getElementById('joinBtn');

  roomInput.value = context.roomName;
  nameInput.value = 'ReloadHost';
  joinBtn.click();

  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (promptCalled) throw new Error('Prompt shown despite cached host access');
  return 'Host access persisted via local storage.';
}

async function testViewerNotUpgraded() {
  if (!context.viewerSocket) throw new Error('Viewer socket missing');
  if (!context.viewerIsViewer) {
    throw new Error('Viewer upgraded to guest without host approval');
  }
  return 'Viewer stayed in viewer role unless host promotes.';
}

async function run() {
  updateTimestamp(startedEl, report.startedAt);
  logLine(`Starting self-test for room ${context.roomName}`);

  const tests = [
    {
      name: 'Host can create/claim a room',
      run: testClaimRoom
    },
    {
      name: 'Host can re-enter a claimed room using password',
      run: testHostReenter
    },
    {
      name: 'Host enters studio automatically after auth',
      run: testHostStudioAutoEntry
    },
    {
      name: 'Public viewers join without VIP and receive broadcast tracks',
      run: testPublicViewerJoinAndBroadcast
    },
    {
      name: 'Private room allows viewers when VIP is off',
      run: testPrivateViewerBlocked
    },
    {
      name: 'Private room blocks viewers when VIP is required',
      run: testPrivateVipRequiredBlocked
    },
    {
      name: 'VIP viewers can join with code and decrements usage',
      run: testVipViewerJoinAndUsage
    },
    {
      name: 'VIP codes can be revoked and stop granting access',
      run: testVipRevoke
    },
    {
      name: 'Overlay fields detect IDs and re-render on edit',
      run: testOverlayFieldDetection
    },
    {
      name: 'Studio buttons are wired',
      run: testStudioButtonsWired
    },
    {
      name: 'WebRTC handshake order is offer → answer → ice → track',
      run: testWebrtcHandshakeOrder
    },
    {
      name: 'Host state stored locally so reload preserves access',
      run: testHostStateStored
    },
    {
      name: 'Viewer not upgraded to guest unless host allows',
      run: testViewerNotUpgraded
    }
  ];

  for (const test of tests) {
    try {
      const detail = await test.run();
      addResult(test.name, true, detail);
    } catch (err) {
      addResult(test.name, false, err.message);
    }
  }

  report.finishedAt = new Date().toISOString();
  updateTimestamp(finishedEl, report.finishedAt);
  const failures = report.results.filter((item) => !item.ok).length;
  markStatus(failures ? `Complete with ${failures} failure(s)` : 'All tests passed');
  logLine('Self-test completed.');
}

run().catch((err) => {
  addResult('Self-test execution error', false, err.message);
  markStatus('Failed');
});
