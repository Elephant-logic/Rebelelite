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

const runId = Date.now();
const context = {
  roomName: `selftest-${runId}`,
  password: `pw-${Math.random().toString(36).slice(2, 8)}`,
  hostSocket: null,
  viewerSocket: null,
  studioFrameLoaded: null
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

function waitForEvent(target, event, predicate = null, ms = 5000) {
  return withTimeout(
    new Promise((resolve) => {
      const handler = (...args) => {
        if (!predicate || predicate(...args)) {
          target.off(event, handler);
          resolve(args);
        }
      };
      target.on(event, handler);
    }),
    ms,
    `Waiting for ${event}`
  );
}

function waitForCondition(check, ms = 5000, label = 'Condition') {
  return withTimeout(
    new Promise((resolve) => {
      const interval = setInterval(() => {
        if (check()) {
          clearInterval(interval);
          resolve();
        }
      }, 150);
    }),
    ms,
    label
  );
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
  await waitForEvent(socket, 'connect', null, 5000);
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

async function ensureStudioFrameLoaded() {
  if (context.studioFrameLoaded) return context.studioFrameLoaded;
  if (!studioFrame) throw new Error('Studio iframe missing');
  context.studioFrameLoaded = new Promise((resolve) => {
    studioFrame.src = `/index.html?selftest=1&v=${Date.now()}`;
    studioFrame.onload = () => resolve();
  });
  await context.studioFrameLoaded;
  await waitForCondition(
    () => studioFrame.contentWindow && studioFrame.contentWindow.__overlayTest,
    8000,
    'Overlay hooks ready'
  );
  return context.studioFrameLoaded;
}

async function testHostClaimAndJoin() {
  const hostSocket = io({ autoConnect: false });
  context.hostSocket = hostSocket;
  await connectSocket(hostSocket);

  const claimResp = await emitWithAck(hostSocket, 'claim-room', {
    name: context.roomName,
    password: context.password,
    privacy: 'public'
  });
  if (!claimResp?.ok) throw new Error(claimResp?.error || 'Claim failed');

  const authResp = await emitWithAck(hostSocket, 'auth-host-room', {
    roomName: context.roomName,
    password: context.password
  });
  if (!authResp?.ok) throw new Error(authResp?.error || 'Host auth failed');

  const joinResp = await emitWithAck(hostSocket, 'join-room', {
    room: context.roomName,
    name: 'SelfTest Host',
    isViewer: false
  });
  if (!joinResp?.ok || !joinResp?.isHost) {
    throw new Error(joinResp?.error || 'Host join failed');
  }

  return 'Host claimed room and joined as host.';
}

async function testViewerJoinAndStream() {
  if (!context.hostSocket) throw new Error('Host socket missing');
  const viewerSocket = io({ autoConnect: false });
  context.viewerSocket = viewerSocket;
  await connectSocket(viewerSocket);

  const joinResp = await emitWithAck(viewerSocket, 'join-room', {
    room: context.roomName,
    name: 'SelfTest Viewer',
    isViewer: true
  });
  if (!joinResp?.ok) throw new Error(joinResp?.error || 'Viewer join failed');

  const hostPc = new RTCPeerConnection(iceConfig);
  const viewerPc = new RTCPeerConnection(iceConfig);
  const hostStream = createCanvasStream('Broadcast');
  let trackReceived = false;

  hostPc.onicecandidate = (e) => {
    if (!e.candidate) return;
    context.hostSocket.emit('webrtc-ice-candidate', {
      targetId: viewerSocket.id,
      candidate: e.candidate
    });
  };

  viewerPc.onicecandidate = (e) => {
    if (!e.candidate) return;
    viewerSocket.emit('webrtc-ice-candidate', {
      targetId: context.hostSocket.id,
      candidate: e.candidate
    });
  };

  viewerPc.ontrack = () => {
    trackReceived = true;
  };

  context.hostSocket.on('webrtc-answer', async ({ sdp }) => {
    await hostPc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  context.hostSocket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (candidate) await hostPc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  viewerSocket.on('webrtc-offer', async ({ sdp, from }) => {
    await viewerPc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await viewerPc.createAnswer();
    await viewerPc.setLocalDescription(answer);
    viewerSocket.emit('webrtc-answer', { targetId: from, sdp: answer });
  });

  viewerSocket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (candidate) await viewerPc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  hostStream.getTracks().forEach((track) => hostPc.addTrack(track, hostStream));
  const offer = await hostPc.createOffer();
  await hostPc.setLocalDescription(offer);
  context.hostSocket.emit('webrtc-offer', { targetId: viewerSocket.id, sdp: offer });

  await waitForCondition(() => trackReceived, 8000, 'Viewer received track');

  hostPc.close();
  viewerPc.close();
  hostStream.getTracks().forEach((track) => track.stop());

  return 'Viewer joined and received a broadcast track.';
}

async function testChatBetweenHostAndViewer() {
  if (!context.hostSocket || !context.viewerSocket) {
    throw new Error('Sockets missing for chat test');
  }

  const hostMessage = 'Hello from host';
  const viewerMessage = 'Hello from viewer';

  const hostReceived = waitForEvent(
    context.hostSocket,
    'public-chat',
    (payload) => payload && payload.text === viewerMessage,
    5000
  );
  const viewerReceived = waitForEvent(
    context.viewerSocket,
    'public-chat',
    (payload) => payload && payload.text === hostMessage,
    5000
  );

  context.hostSocket.emit('public-chat', {
    room: context.roomName,
    name: 'SelfTest Host',
    text: hostMessage,
    fromViewer: false
  });

  context.viewerSocket.emit('public-chat', {
    room: context.roomName,
    name: 'SelfTest Viewer',
    text: viewerMessage,
    fromViewer: true
  });

  await hostReceived;
  await viewerReceived;

  return 'Host and viewer exchanged chat messages.';
}

async function testOverlayUpload() {
  await ensureStudioFrameLoaded();
  const frameWindow = studioFrame.contentWindow;
  if (!frameWindow || !frameWindow.__overlayTest) {
    throw new Error('Overlay test hooks missing');
  }

  const overlayHtml = '<div id="banner">Overlay OK</div>';
  const initialCount = frameWindow.__overlayTest.getRenderCount();
  frameWindow.__overlayTest.loadHTML(overlayHtml);

  await waitForCondition(
    () => frameWindow.__overlayTest.getRenderCount() > initialCount,
    4000,
    'Overlay render count updated'
  );

  return 'Overlay HTML loaded without crashing.';
}

async function run() {
  updateTimestamp(startedEl, report.startedAt);
  logLine(`Starting self-test for room ${context.roomName}`);

  const tests = [
    {
      name: 'Host can claim and join a room',
      run: testHostClaimAndJoin
    },
    {
      name: 'Viewer can join and receive a stream',
      run: testViewerJoinAndStream
    },
    {
      name: 'Chat works between host and viewer',
      run: testChatBetweenHostAndViewer
    },
    {
      name: 'Overlay upload renders without crashing',
      run: testOverlayUpload
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

  if (context.hostSocket) context.hostSocket.disconnect();
  if (context.viewerSocket) context.viewerSocket.disconnect();
}

run().catch((err) => {
  addResult('Self-test execution error', false, err.message);
  markStatus('Failed');
});
