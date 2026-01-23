const resultsEl = document.getElementById('selftestResults');
const logEl = document.getElementById('selftestLog');
const statusEl = document.getElementById('selftestStatus');
const startedEl = document.getElementById('selftestStarted');
const finishedEl = document.getElementById('selftestFinished');
const studioFrame = document.getElementById('selftestStudioFrame');

const params = new URLSearchParams(window.location.search);
const targetOrigin = params.get('target') || window.location.origin;
const targetBaseUrl = targetOrigin.replace(/\/$/, '');

const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  results: []
};

const runId = Date.now();

const context = {
  roomName: `selftest-${runId}`,
  privateRoomName: `selftest-private-${runId}`,
  password: `pw-${Math.random().toString(36).slice(2, 8)}`,
  privatePassword: `pw-private-${Math.random().toString(36).slice(2, 8)}`,
  hostSocket: null,
  viewerSocket: null,
  broadcastOrder: [],
  callOrder: [],
  viewerIsViewer: false,
  studioReady: false
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

function ensureSameOriginAccess() {
  if (window.location.origin !== targetBaseUrl) {
    throw new Error('Selftest must be served from the same origin as the target.');
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
    studioFrame.src = `${targetBaseUrl}/index.html?selftest=1`;
    studioFrame.onload = () => resolve();
  });
  return studioFrameLoaded;
}

let viewerFrame = null;
function ensureViewerFrame() {
  if (viewerFrame) return viewerFrame;
  viewerFrame = document.createElement('iframe');
  viewerFrame.id = 'selftestViewerFrame';
  viewerFrame.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;top:-9999px;';
  document.body.appendChild(viewerFrame);
  return viewerFrame;
}

async function loadViewerFrame({ roomName, name, vipCode } = {}) {
  ensureViewerFrame();
  const room = roomName || context.roomName;
  const viewerName = name || 'SelfTestViewer';
  const params = new URLSearchParams({
    room,
    name: viewerName,
    v: String(Date.now())
  });
  if (vipCode) params.set('vipCode', vipCode);
  await new Promise((resolve) => {
    viewerFrame.onload = () => resolve();
    viewerFrame.src = `${targetBaseUrl}/view.html?${params.toString()}`;
  });
  return waitForFrameElements(
    viewerFrame,
    ['viewerNameInput', 'viewerVipCodeInput', 'joinRoomBtn', 'joinStatus', 'viewerJoinPanel', 'chatLog'],
    8000
  );
}

async function waitForViewerState(predicate, ms = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    const frameWindow = viewerFrame?.contentWindow;
    if (frameWindow && predicate(frameWindow)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Viewer frame did not reach expected state');
}

async function joinViewerInFrame({ roomName, name, vipCode } = {}) {
  const viewerDoc = await loadViewerFrame({ roomName, name, vipCode });
  const nameInput = viewerDoc.getElementById('viewerNameInput');
  const vipInput = viewerDoc.getElementById('viewerVipCodeInput');
  const joinBtn = viewerDoc.getElementById('joinRoomBtn');
  if (nameInput) nameInput.value = name || 'SelfTest Viewer';
  if (vipInput) vipInput.value = vipCode || '';
  joinBtn.click();
  await waitForViewerState((frameWindow) => {
    const panel = frameWindow.document.getElementById('viewerJoinPanel');
    return panel && panel.classList.contains('hidden');
  }, 8000);
  return viewerDoc;
}

function ensureViewerFrameLoaded() {
  return loadViewerFrame({ roomName: context.roomName, name: 'SelfTestViewer' });
}

async function ensureStudioHostJoined() {
  if (context.studioReady) return studioFrame?.contentWindow?.document;
  await ensureStudioFrameLoaded();
  const doc = await waitForFrameElements(
    studioFrame,
    ['roomInput', 'nameInput', 'joinBtn', 'togglePrivateBtn', 'vipRequiredToggle', 'leaveBtn'],
    8000
  );
  const frameWindow = studioFrame.contentWindow;
  if (!frameWindow) throw new Error('Studio iframe missing');
  frameWindow.sessionStorage.setItem(`hostPassword:${context.roomName}`, context.password);
  frameWindow.sessionStorage.setItem(`hostAccess:${context.roomName}`, '1');

  const roomInput = doc.getElementById('roomInput');
  const nameInput = doc.getElementById('nameInput');
  const joinBtn = doc.getElementById('joinBtn');

  roomInput.value = context.roomName;
  nameInput.value = 'SelfTest Studio Host';
  joinBtn.click();

  await withTimeout(
    new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const leaveBtn = doc.getElementById('leaveBtn');
        const privateBtn = doc.getElementById('togglePrivateBtn');
        const vipBtn = doc.getElementById('vipRequiredToggle');
        if (
          leaveBtn &&
          privateBtn &&
          vipBtn &&
          !leaveBtn.disabled &&
          !privateBtn.disabled
        ) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 8000) {
          clearInterval(interval);
          reject(new Error('Studio host did not finish joining'));
        }
      }, 200);
    }),
    9000,
    'Studio host join'
  );

  context.studioReady = true;
  if (!context.hostSocket && frameWindow.__selftestHostSocket) {
    context.hostSocket = frameWindow.__selftestHostSocket;
  }
  return doc;
}

async function setStudioToggle(doc, id, expected) {
  const btn = doc.getElementById(id);
  if (!btn) throw new Error(`Missing toggle ${id}`);
  if (btn.textContent.trim() !== expected) {
    btn.click();
  }
  await withTimeout(
    new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (btn.textContent.trim() === expected) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 4000) {
          clearInterval(interval);
          reject(new Error(`Toggle ${id} did not reach ${expected}`));
        }
      }, 150);
    }),
    4500,
    `Toggle ${id}`
  );
}

async function waitForRoomInfo(expected) {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  return withTimeout(
    new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(async () => {
        const info = await emitWithAck(context.hostSocket, 'get-room-info', {
          roomName: context.roomName
        });
        const matches = Object.entries(expected).every(([key, value]) => info?.[key] === value);
        if (matches) {
          clearInterval(interval);
          resolve(info);
        } else if (Date.now() - start > 4000) {
          clearInterval(interval);
          reject(
            new Error(
              `Room info mismatch (expected ${JSON.stringify(expected)}, got ${JSON.stringify(info)})`
            )
          );
        }
      }, 200);
    }),
    4500,
    'Room info update'
  );
}

async function setRoomPrivacy(privacy) {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  const resp = await emitWithAck(context.hostSocket, 'update-room-privacy', {
    roomName: context.roomName,
    privacy
  });
  if (!resp?.ok) throw new Error(resp?.error || 'Unable to update room privacy');
  await waitForRoomInfo({ privacy });
}

async function setVipRequired(required) {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  const resp = await emitWithAck(context.hostSocket, 'update-vip-required', {
    roomName: context.roomName,
    vipRequired: required
  });
  if (!resp?.ok) throw new Error(resp?.error || 'Unable to update VIP requirement');
  await waitForRoomInfo({ vipRequired: required });
}

async function setRoomPrivacyAndVip({ privacy, vipRequired }) {
  if (privacy) await setRoomPrivacy(privacy);
  if (typeof vipRequired === 'boolean') await setVipRequired(vipRequired);
  await waitForRoomInfo({ privacy, vipRequired });
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

function createSocket() {
  return io(targetBaseUrl, { autoConnect: false });
}

async function joinViewerSocket({ roomName, name, vipCode } = {}) {
  const socket = createSocket();
  await connectSocket(socket);
  const resp = await emitWithAck(socket, 'join-room', {
    room: roomName || context.roomName,
    name: name || 'SelfTest Viewer',
    isViewer: true,
    vipCode
  });
  socket.disconnect();
  return resp;
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

function isScrolledToBottom(log) {
  if (!log) return false;
  if (log.scrollHeight <= log.clientHeight) return true;
  return log.scrollTop >= log.scrollHeight - log.clientHeight - 4;
}

function extractVipCode(text) {
  const match = String(text || '').match(/[A-Z0-9]{5,8}/);
  return match ? match[0] : '';
}

async function testClaimRoom() {
  const socket = createSocket();
  await connectSocket(socket);
  const resp = await emitWithAck(socket, 'claim-room', {
    name: context.roomName,
    password: context.password,
    public: true
  });
  const info = await emitWithAck(socket, 'get-room-info', { roomName: context.roomName });
  socket.disconnect();
  if (!resp?.ok) throw new Error(resp?.error || 'Claim failed');
  if (!info?.exists || info?.privacy !== 'public') {
    throw new Error('Room was not registered as public after claim');
  }
  return 'Room claimed successfully as public.';
}

async function testClaimPrivateRoom() {
  const socket = createSocket();
  await connectSocket(socket);
  const claimResp = await emitWithAck(socket, 'claim-room', {
    name: context.privateRoomName,
    password: context.privatePassword,
    privacy: 'private'
  });
  if (!claimResp?.ok) {
    socket.disconnect();
    throw new Error(claimResp?.error || 'Private room claim failed');
  }

  const authResp = await emitWithAck(socket, 'auth-host-room', {
    roomName: context.privateRoomName,
    password: context.privatePassword
  });
  if (!authResp?.ok) {
    socket.disconnect();
    throw new Error(authResp?.error || 'Private room auth failed');
  }

  const joinResp = await emitWithAck(socket, 'join-room', {
    room: context.privateRoomName,
    name: 'SelfTest Private Host',
    isViewer: false
  });
  const info = await emitWithAck(socket, 'get-room-info', { roomName: context.privateRoomName });
  socket.disconnect();
  if (!joinResp?.ok || !joinResp?.isHost) {
    throw new Error(joinResp?.error || 'Private host join failed');
  }
  if (!info?.exists || info?.privacy !== 'private') {
    throw new Error('Room was not registered as private after claim');
  }
  return 'Private room claimed and host joined successfully.';
}

async function testHostReenter() {
  const hostSocket = createSocket();
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

async function testVipCodeGenerationAndJoin() {
  const doc = await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'private', vipRequired: true });

  const generateBtn = doc.getElementById('generateVipCodeBtn');
  const vipCodeList = doc.getElementById('vipCodeList');
  const vipInput = doc.getElementById('vipUserInput');
  const addVipBtn = doc.getElementById('addVipUserBtn');
  if (!generateBtn || !vipCodeList) {
    throw new Error('VIP code controls missing in studio');
  }
  if (!vipInput || !addVipBtn) {
    throw new Error('VIP username controls missing in studio');
  }

  vipInput.value = 'VipViewer';
  vipInput.dispatchEvent(new Event('input', { bubbles: true }));
  addVipBtn.click();

  await waitForCondition(
    () => !generateBtn.disabled,
    4000,
    'Enable VIP code generation'
  );

  const beforeList = vipCodeList.textContent;
  generateBtn.click();

  await waitForCondition(
    () => extractVipCode(vipCodeList.textContent) && vipCodeList.textContent !== beforeList,
    6000,
    'VIP code list update'
  );

  const code = extractVipCode(vipCodeList.textContent);
  if (!code) throw new Error('VIP code did not appear in studio list');

  const codesResp = await emitWithAck(context.hostSocket, 'get-vip-codes', {
    roomName: context.roomName
  });
  if (!codesResp?.ok || !Array.isArray(codesResp.codes)) {
    throw new Error('Unable to read VIP codes from server');
  }
  const serverHasCode = codesResp.codes.some((entry) => entry.code === code);
  if (!serverHasCode) throw new Error('VIP code missing from server metadata');

  const joinResp = await joinViewerSocket({
    roomName: context.roomName,
    name: 'VipViewer',
    vipCode: code
  });
  if (!joinResp?.ok || !joinResp?.isVip) {
    throw new Error(joinResp?.error || 'Viewer could not join with VIP code');
  }

  return `VIP code generated (${code}), stored, and accepted for VIP join.`;
}

async function testPrivateVipLogic() {
  const doc = await ensureStudioHostJoined();
  const vipToggle = doc.getElementById('vipRequiredToggle');
  if (!vipToggle) throw new Error('VIP toggle missing in studio');

  await setRoomPrivacyAndVip({ privacy: 'public', vipRequired: false });

  if (vipToggle.textContent.trim() !== 'OFF') {
    throw new Error('VIP Required should be OFF when room is public');
  }
  if (!vipToggle.disabled) {
    throw new Error('VIP Required should be disabled while room is public');
  }

  const publicJoin = await joinViewerSocket({
    roomName: context.roomName,
    name: 'PublicViewer'
  });
  if (!publicJoin?.ok) {
    throw new Error(publicJoin?.error || 'Public viewer could not join');
  }

  await setRoomPrivacyAndVip({ privacy: 'private', vipRequired: false });

  const privateJoin = await joinViewerSocket({
    roomName: context.roomName,
    name: 'PrivateViewer'
  });
  if (!privateJoin?.ok) {
    throw new Error(privateJoin?.error || 'Private room blocked viewer with a name');
  }

  const vipInput = doc.getElementById('vipUserInput');
  const addVipBtn = doc.getElementById('addVipUserBtn');
  if (!vipInput || !addVipBtn) {
    throw new Error('VIP username controls missing in studio');
  }

  vipInput.value = 'ListVip';
  vipInput.dispatchEvent(new Event('input', { bubbles: true }));
  addVipBtn.click();

  await setRoomPrivacyAndVip({ privacy: 'private', vipRequired: true });

  const blockedJoin = await joinViewerSocket({
    roomName: context.roomName,
    name: 'NotVip'
  });
  if (blockedJoin?.ok) {
    throw new Error('VIP-required room allowed viewer not on VIP list');
  }

  const vipNameJoin = await joinViewerSocket({
    roomName: context.roomName,
    name: 'ListVip'
  });
  if (vipNameJoin?.ok) {
    throw new Error('Private room allowed VIP username without code');
  }

  const invalidCodeJoin = await joinViewerSocket({
    roomName: context.roomName,
    name: 'ListVip',
    vipCode: 'BADCODE'
  });
  if (invalidCodeJoin?.ok) {
    throw new Error('Private room allowed invalid VIP code');
  }

  const codeResp = await emitWithAck(context.hostSocket, 'generate-vip-code', {
    room: context.roomName,
    maxUses: 1
  });
  if (!codeResp?.ok || !codeResp?.code) {
    throw new Error('VIP code generation failed for private/VIP test');
  }
  const validJoin = await joinViewerSocket({
    roomName: context.roomName,
    name: 'ListVip',
    vipCode: codeResp.code
  });
  if (!validJoin?.ok || !validJoin?.isVip) {
    throw new Error(validJoin?.error || 'VIP room blocked valid VIP code');
  }

  return 'Private/VIP rules enforced for public, private, and VIP-required states.';
}

async function testChatDeliveryAndAutoscroll() {
  const doc = await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'public', vipRequired: false });

  const hostLog = doc.getElementById('chatLogPublic');
  const hostInput = doc.getElementById('inputPublic');
  const hostSend = doc.getElementById('btnSendPublic');
  if (!hostLog || !hostInput || !hostSend) {
    throw new Error('Host chat controls missing');
  }

  const viewerDoc = await joinViewerInFrame({
    roomName: context.roomName,
    name: 'ChatViewer'
  });
  const viewerLog = viewerDoc.getElementById('chatLog');
  const viewerInput = viewerDoc.getElementById('chatInput');
  const viewerSend = viewerDoc.getElementById('sendBtn');
  if (!viewerLog || !viewerInput || !viewerSend) {
    throw new Error('Viewer chat controls missing');
  }

  hostInput.value = 'Host says hello';
  hostSend.click();

  await waitForCondition(
    () => hostLog.textContent.includes('Host says hello'),
    6000,
    'Host chat echo'
  );
  await waitForCondition(
    () => viewerLog.textContent.includes('Host says hello'),
    6000,
    'Viewer receives host chat'
  );

  viewerInput.value = 'Viewer replying';
  viewerSend.click();

  await waitForCondition(
    () => viewerLog.textContent.includes('Viewer replying'),
    6000,
    'Viewer chat echo'
  );
  await waitForCondition(
    () => hostLog.textContent.includes('Viewer replying'),
    6000,
    'Host receives viewer chat'
  );

  for (let i = 0; i < 40; i += 1) {
    viewerInput.value = `Scroll message ${i + 1}`;
    viewerSend.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  if (viewerLog.scrollHeight > viewerLog.clientHeight && !isScrolledToBottom(viewerLog)) {
    throw new Error('Viewer chat did not auto-scroll to bottom');
  }
  if (hostLog.scrollHeight > hostLog.clientHeight && !isScrolledToBottom(hostLog)) {
    throw new Error('Host chat did not auto-scroll to bottom');
  }

  return 'Chat delivers host/viewer messages with auto-scroll.';
}

async function testOverlayTickerUpload() {
  await ensureStudioFrameLoaded();
  const frameWindow = studioFrame.contentWindow;
  const doc = frameWindow?.document;
  if (!frameWindow || !doc) throw new Error('Studio iframe not ready');

  const overlayInput = doc.getElementById('htmlOverlayInput');
  const overlayFields = doc.getElementById('overlayFields');
  const hook = frameWindow.__overlayTest;
  if (!overlayInput || !overlayFields || !hook) {
    throw new Error('Overlay upload controls missing');
  }

  const overlayHtml = `
    <div id="ticker">Live now</div>
    <div id="djName">DJ Rebel</div>
  `;
  const file = new frameWindow.File([overlayHtml], 'overlay.html', { type: 'text/html' });
  const dataTransfer = new frameWindow.DataTransfer();
  dataTransfer.items.add(file);
  overlayInput.files = dataTransfer.files;
  overlayInput.dispatchEvent(new frameWindow.Event('change', { bubbles: true }));

  await waitForCondition(
    () => {
      const labels = Array.from(overlayFields.querySelectorAll('label')).map((label) =>
        label.textContent.trim()
      );
      return labels.includes('ticker') && labels.includes('djName');
    },
    6000,
    'Overlay fields detected'
  );

  const initialRender = hook.getRenderCount();

  const updateOverlayField = (name, value) => {
    const row = Array.from(overlayFields.querySelectorAll('.overlay-field')).find(
      (item) => item.querySelector('label')?.textContent.trim() === name
    );
    const input = row?.querySelector('input, textarea');
    if (!input) throw new Error(`Overlay input missing for ${name}`);
    input.value = value;
    input.dispatchEvent(new frameWindow.Event('input', { bubbles: true }));
  };

  updateOverlayField('ticker', 'Breaking News');
  updateOverlayField('djName', 'DJ Night');

  await waitForCondition(
    () => hook.getFieldValue('ticker') === 'Breaking News' && hook.getFieldValue('djName') === 'DJ Night',
    6000,
    'Overlay fields updated'
  );

  if (hook.getRenderCount() <= initialRender) {
    throw new Error('Overlay did not re-render after updates');
  }

  return 'Overlay HTML upload detected ticker fields and applied updates.';
}

async function testVipDefaultsAndButtons() {
  const doc = await ensureStudioHostJoined();
  const vipToggle = doc.getElementById('vipRequiredToggle');
  const addBtn = doc.getElementById('addVipUserBtn');
  const vipInput = doc.getElementById('vipUserInput');
  const generateBtn = doc.getElementById('generateVipCodeBtn');

  if (!vipToggle || !addBtn || !vipInput || !generateBtn) {
    throw new Error('VIP controls missing in studio');
  }

  if (vipToggle.textContent.trim() !== 'OFF') {
    throw new Error('VIP Required did not default to OFF on new room');
  }

  await setStudioToggle(doc, 'togglePrivateBtn', 'OFF');
  await waitForRoomInfo({ privacy: 'public', vipRequired: false });

  if (!addBtn.disabled) {
    throw new Error('Add VIP button should be disabled with empty input');
  }

  vipInput.value = 'VIPTester';
  vipInput.dispatchEvent(new Event('input', { bubbles: true }));
  await waitForCondition(() => !addBtn.disabled, 2000, 'Enable VIP add button');

  vipInput.value = '';
  vipInput.dispatchEvent(new Event('input', { bubbles: true }));
  await waitForCondition(() => addBtn.disabled, 2000, 'Disable VIP add button');

  if (!generateBtn.disabled) {
    throw new Error('Generate VIP code should be disabled when room is public');
  }

  await setStudioToggle(doc, 'togglePrivateBtn', 'ON');
  await waitForRoomInfo({ privacy: 'private' });
  await waitForCondition(() => generateBtn.disabled, 2000, 'Keep VIP code disabled without VIP requirement');

  await setStudioToggle(doc, 'vipRequiredToggle', 'ON');
  await waitForCondition(() => !generateBtn.disabled, 2000, 'Enable VIP code button');

  await setStudioToggle(doc, 'togglePrivateBtn', 'OFF');
  await waitForRoomInfo({ privacy: 'public' });
  await waitForCondition(() => generateBtn.disabled, 2000, 'Disable VIP code button');

  return 'VIP defaults and button states verified.';
}

async function testPublicViewerJoinAndBroadcast() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'public', vipRequired: false });

  const viewerSocket = createSocket();
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
  await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'private', vipRequired: false });

  const openSocket = createSocket();
  await connectSocket(openSocket);
  const joinResp = await emitWithAck(openSocket, 'join-room', {
    room: context.roomName,
    name: 'NoVipViewer',
    isViewer: true
  });
  openSocket.disconnect();
  if (!joinResp?.ok) throw new Error('Private room blocked viewer with a name');
  return 'Private room allowed viewer with only a name.';
}

async function testPrivateVipRequiredBlocked() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'private', vipRequired: true });

  const blockedSocket = createSocket();
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

async function testViewerVipBlockedMessage() {
  await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'private', vipRequired: true });

  await ensureViewerFrameLoaded();
  const viewerDoc = await waitForFrameElements(
    viewerFrame,
    ['viewerNameInput', 'viewerVipCodeInput', 'joinRoomBtn', 'joinStatus'],
    6000
  );

  const nameInput = viewerDoc.getElementById('viewerNameInput');
  const vipInput = viewerDoc.getElementById('viewerVipCodeInput');
  const joinBtn = viewerDoc.getElementById('joinRoomBtn');
  const joinStatus = viewerDoc.getElementById('joinStatus');

  nameInput.value = 'Blocked Viewer';
  vipInput.value = '';
  joinBtn.click();

  await waitForViewerState(
    (frameWindow) => {
      const status = frameWindow.document.getElementById('joinStatus');
      return status && /vip/i.test(status.textContent || '');
    },
    6000
  );

  const message = joinStatus.textContent.trim();
  if (!/vip/i.test(message)) {
    throw new Error('Viewer did not receive friendly VIP required message');
  }

  await new Promise((resolve) => {
    viewerFrame.onload = () => resolve();
    viewerFrame.src = `/view.html?room=${encodeURIComponent(context.roomName)}&name=SelfTestViewer2&v=${Date.now()}`;
  });
  const secondViewerDoc = await waitForFrameElements(
    viewerFrame,
    ['viewerNameInput', 'viewerVipCodeInput', 'joinRoomBtn', 'joinStatus'],
    6000
  );
  const secondNameInput = secondViewerDoc.getElementById('viewerNameInput');
  const secondVipInput = secondViewerDoc.getElementById('viewerVipCodeInput');
  const secondJoinBtn = secondViewerDoc.getElementById('joinRoomBtn');
  const secondStatus = secondViewerDoc.getElementById('joinStatus');

  secondNameInput.value = 'Blocked Viewer 2';
  secondVipInput.value = 'BADCODE';
  secondJoinBtn.click();

  await waitForViewerState(
    (frameWindow) => {
      const status = frameWindow.document.getElementById('joinStatus');
      return status && /vip/i.test(status.textContent || '');
    },
    6000
  );

  const invalidMessage = secondStatus.textContent.trim();
  if (!/vip/i.test(invalidMessage)) {
    throw new Error(`Viewer did not receive friendly VIP invalid message (got "${invalidMessage}")`);
  }

  return `Viewer sees friendly VIP messages: "${message}" / "${invalidMessage}"`;
}

async function testViewerChatAutoscroll() {
  await ensureViewerFrameLoaded();
  const viewerDoc = await waitForFrameElements(viewerFrame, ['chatLog'], 4000);
  const log = viewerDoc.getElementById('chatLog');
  const frameWindow = viewerFrame.contentWindow;
  if (!frameWindow || !frameWindow.appendChat) {
    throw new Error('Viewer chat helper missing');
  }

  for (let i = 0; i < 24; i += 1) {
    frameWindow.appendChat('SelfTest', `Message ${i + 1}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));

  const atBottom = log.scrollTop >= log.scrollHeight - log.clientHeight - 4;
  if (!atBottom) throw new Error('Viewer chat did not auto-scroll to bottom');
  return 'Viewer chat auto-scrolls on overflow.';
}

async function testPrivateRoomToggleOff() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'public', vipRequired: false });
  return 'Private room toggled off and returned to public.';
}

async function testVipViewerJoinAndUsage() {
  if (!context.hostSocket) throw new Error('Host socket not initialized');
  await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'private', vipRequired: true });
  await emitWithAck(context.hostSocket, 'add-vip-user', {
    room: context.roomName,
    userName: 'VipViewer'
  });
  const codeResp = await emitWithAck(context.hostSocket, 'generate-vip-code', {
    room: context.roomName,
    maxUses: 1
  });
  if (!codeResp?.ok || !codeResp?.code) throw new Error('VIP code generation failed');

  const vipSocket = createSocket();
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
  await ensureStudioHostJoined();
  await setRoomPrivacyAndVip({ privacy: 'private', vipRequired: true });
  await emitWithAck(context.hostSocket, 'add-vip-user', {
    room: context.roomName,
    userName: 'VipViewerOnce'
  });
  const codeResp = await emitWithAck(context.hostSocket, 'generate-vip-code', {
    room: context.roomName,
    maxUses: 2
  });
  if (!codeResp?.ok || !codeResp?.code) throw new Error('VIP code generation failed');

  const vipSocket = createSocket();
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

  const blockedSocket = createSocket();
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
    'hangupBtn',
    'togglePrivateBtn',
    'vipRequiredToggle',
    'addVipUserBtn',
    'generateVipCodeBtn',
    'paymentSaveBtn'
  ];
  const doc = await waitForFrameElements(studioFrame, ids, 6000);

  await new Promise((resolve) => setTimeout(resolve, 800));

  const joinBtn = doc.getElementById('joinBtn');
  const startBtn = doc.getElementById('startStreamBtn');
  const shareBtn = doc.getElementById('shareScreenBtn');
  const muteBtn = doc.getElementById('toggleMicBtn');
  const endBtn = doc.getElementById('hangupBtn');
  const privateBtn = doc.getElementById('togglePrivateBtn');
  const vipToggle = doc.getElementById('vipRequiredToggle');
  const addVipBtn = doc.getElementById('addVipUserBtn');
  const generateVipBtn = doc.getElementById('generateVipCodeBtn');
  const paymentBtn = doc.getElementById('paymentSaveBtn');

  const wired = [
    joinBtn?.onclick,
    startBtn?.onclick,
    shareBtn?.onclick,
    muteBtn?.onclick,
    endBtn?.onclick,
    privateBtn?.onclick,
    vipToggle?.onclick,
    addVipBtn?.onclick,
    generateVipBtn?.onclick,
    paymentBtn?.onclick
  ].every((handler) => typeof handler === 'function');

  const layoutButtons = Array.from(doc.querySelectorAll('.mixer-controls .mixer-btn'));
  const layoutWired = layoutButtons.length > 0 && layoutButtons.every((btn) => typeof btn.onclick === 'function');

  if (!wired || !layoutWired) {
    throw new Error('One or more studio buttons are not wired');
  }
  return 'Studio controls wired (stream, layout, VIP, payments).';
}

async function testStageCallFlow() {
  if (!context.broadcastOrder.length) {
    throw new Error('Broadcast handshake did not execute');
  }
  const broadcastOk = ensureHandshakeOrder(context.broadcastOrder);

  const hostSocket = context.hostSocket;
  const viewerSocket = context.viewerSocket;
  if (!hostSocket || !viewerSocket) throw new Error('Sockets missing for call test');

  context.callOrder = [];
  viewerSocket.emit('request-to-call');
  await waitForEvent(hostSocket, 'call-request-received', 5000);

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

  hostSocket.on('call-answer', async ({ answer }) => {
    await hostPc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  hostSocket.on('call-ice', async ({ candidate }) => {
    if (candidate) await hostPc.addIceCandidate(new RTCIceCandidate(candidate));
  });
  viewerSocket.on('call-ice', async ({ candidate }) => {
    if (candidate) await viewerPc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  viewerSocket.on('incoming-call', async ({ offer, from }) => {
    context.callOrder.push('offer');
    await viewerPc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await viewerPc.createAnswer();
    await viewerPc.setLocalDescription(answer);
    context.callOrder.push('answer');
    viewerSocket.emit('call-answer', { targetId: from, answer });
    iceEnabled = true;
    flushIce();
  });

  viewerStream.getTracks().forEach((track) => viewerPc.addTrack(track, viewerStream));
  hostStream.getTracks().forEach((track) => hostPc.addTrack(track, hostStream));

  const offer = await hostPc.createOffer();
  await hostPc.setLocalDescription(offer);
  hostSocket.emit('call-offer', {
    targetId: viewerSocket.id,
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

  const hangupPromise = waitForEvent(viewerSocket, 'call-end', 5000);
  hostSocket.emit('call-end', { targetId: viewerSocket.id });
  await hangupPromise;

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
  return 'Stage call flow completed (request, accept, handshake, hang-up).';
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
  logLine(`Target: ${targetBaseUrl}`);
  ensureSameOriginAccess();
  logLine(`Starting self-test for room ${context.roomName}`);

  const tests = [
    {
      name: 'Host can create/claim a public room',
      run: testClaimRoom
    },
    {
      name: 'Host can create/claim a private room and join',
      run: testClaimPrivateRoom
    },
    {
      name: 'VIP code generation creates a real server-backed code',
      run: testVipCodeGenerationAndJoin
    },
    {
      name: 'Private/VIP logic enforces the three room rules',
      run: testPrivateVipLogic
    },
    {
      name: 'Chat sends host ↔ viewer messages and auto-scrolls',
      run: testChatDeliveryAndAutoscroll
    },
    {
      name: 'Overlay HTML upload detects ticker fields and updates preview',
      run: testOverlayTickerUpload
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
