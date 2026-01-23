const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);

// Increased buffer to 50MB for large arcade transfers
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e7,
  pingTimeout: 10000,
  pingInterval: 25000
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/selftest', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selftest.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state (per room: owner, lock state, users)
const rooms = Object.create(null);
const vipTokens = new Map();

// Persistent room registry (in-memory for now, structured for easy DB swap).
const roomDirectory = {
  rooms: Object.create(null)
};

function normalizeRoomName(roomName) {
  if (!roomName || typeof roomName !== 'string') return '';
  return roomName.trim().slice(0, 50);
}

function normalizeVipCode(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().toUpperCase();
}

function buildRoomRecord({ roomName, ownerPassword, privacy }) {
  return {
    roomName,
    ownerPassword: ownerPassword ? String(ownerPassword) : null,
    privacy: privacy === 'private' ? 'private' : 'public',
    isLive: false,
    vipRequired: false,
    vipCodes: {},
    createdAt: Date.now(),
    title: null,
    viewers: 0,
    vipUsers: [],
    paymentEnabled: false,
    paymentLabel: '',
    paymentUrl: '',
    turnConfig: {
      enabled: false,
      host: '',
      port: '',
      tlsPort: '',
      username: '',
      password: ''
    }
  };
}

function getRoomRecord(roomName) {
  const name = normalizeRoomName(roomName);
  if (!name) return null;
  return roomDirectory.rooms[name] || null;
}

function createRoomRecord({ roomName, ownerPassword, privacy }) {
  const name = normalizeRoomName(roomName);
  if (!name) return { ok: false, error: 'Invalid room name.' };
  if (roomDirectory.rooms[name]) return { ok: false, error: 'Room already exists.' };
  const record = buildRoomRecord({ roomName: name, ownerPassword, privacy });
  roomDirectory.rooms[name] = record;
  return { ok: true, room: record };
}

function updateRoomRecord(roomName, updater) {
  const name = normalizeRoomName(roomName);
  if (!name) return { ok: false, error: 'Invalid room name.' };
  const existing = roomDirectory.rooms[name];
  if (!existing) return { ok: false, error: 'Room not found.' };
  updater(existing);
  return { ok: true, room: existing };
}

function listPublicRooms() {
  return Object.values(roomDirectory.rooms)
    .filter((room) => room.privacy === 'public' && room.isLive)
    .map((room) => ({
      name: room.roomName,
      viewers: typeof room.viewers === 'number' ? room.viewers : 0,
      title: room.title || null,
      live: !!room.isLive
    }));
}

function getRoomDirectoryEntry(roomName) {
  return getRoomRecord(roomName);
}

function getRoomInfo(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      ownerId: null,
      locked: false,
      streamTitle: 'Untitled Stream',
      users: new Map()
    };
  }
  return rooms[roomName];
}

function listVipCodes(record) {
  if (!record || !record.vipCodes) return [];
  return Object.entries(record.vipCodes).map(([code, meta]) => {
    const maxUses = meta.maxUses ?? null;
    const usesLeft = meta.usesLeft ?? null;
    const used = Number.isFinite(meta.used)
      ? meta.used
      : Number.isFinite(maxUses) && Number.isFinite(usesLeft)
        ? Math.max(0, maxUses - usesLeft)
        : 0;
    return {
      code,
      maxUses,
      usesLeft,
      used,
      multiUse: !!meta.multiUse
    };
  });
}

function emitVipCodesUpdate(roomName) {
  const info = rooms[roomName];
  if (!info || !info.ownerId) return;
  const record = getRoomRecord(roomName);
  if (!record) return;
  io.to(info.ownerId).emit('vip-codes-updated', listVipCodes(record));
}

function isRoomClaimed(roomName) {
  const record = getRoomRecord(roomName);
  return !!record;
}

function issueVipToken(roomName) {
  const token = `${roomName}-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  vipTokens.set(token, { roomName, created: Date.now() });
  return token;
}

function consumeVipToken(token, roomName) {
  if (!token || !vipTokens.has(token)) return false;
  const data = vipTokens.get(token);
  if (!data || data.roomName !== roomName) return false;
  if (Date.now() - data.created > 15 * 60 * 1000) {
    vipTokens.delete(token);
    return false;
  }
  vipTokens.delete(token);
  return true;
}

function requireRoom(socket) {
  return socket.data.room || null;
}

function requireOwner(info, socket) {
  return info && info.ownerId === socket.id;
}

function buildUserList(room) {
  const users = [];
  for (const [id, u] of room.users.entries()) {
    users.push({
      id,
      name: u.name,
      isViewer: u.isViewer,
      requestingCall: u.requestingCall,
      isVip: u.isVip
    });
  }
  return users;
}

function generateVipCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return output;
}

function normalizePaymentLabel(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().slice(0, 80);
}

function normalizePaymentUrl(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().slice(0, 500);
}

function isValidPaymentUrl(value) {
  return typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'));
}

function normalizeTurnConfig(config = {}) {
  const enabled = !!config.enabled;
  const host = typeof config.host === 'string' ? config.host.trim() : '';
  const port = Number(config.port);
  const tlsPort = config.tlsPort ? Number(config.tlsPort) : '';
  const username = typeof config.username === 'string' ? config.username.trim() : '';
  const password = typeof config.password === 'string' ? config.password.trim() : '';
  return {
    enabled,
    host,
    port: Number.isFinite(port) ? port : '',
    tlsPort: Number.isFinite(tlsPort) ? tlsPort : '',
    username,
    password
  };
}

function isValidTurnConfig(config) {
  if (!config || !config.enabled) return false;
  if (!config.host || !config.port) return false;
  if (!config.username || !config.password) return false;
  return true;
}

function sanitizeTurnConfig(config) {
  const normalized = normalizeTurnConfig(config);
  if (!normalized.enabled) {
    return {
      enabled: false,
      host: '',
      port: '',
      tlsPort: '',
      username: '',
      password: ''
    };
  }
  if (!isValidTurnConfig(normalized)) return null;
  return normalized;
}

function broadcastRoomUpdate(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  const record = getRoomRecord(roomName);
  const vipRequired =
    record && record.privacy === 'private' ? !!record.vipRequired : false;

  io.to(roomName).emit('room-update', {
    users: buildUserList(room),
    ownerId: room.ownerId,
    locked: room.locked,
    streamTitle: room.streamTitle,
    privacy: record ? record.privacy : 'public',
    vipRequired
  });
}

// Relay helper to keep signaling logic centralized (no behavior changes).
function relayToTarget(eventName, targetId, payload) {
  if (targetId) io.to(targetId).emit(eventName, payload);
}

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  socket.on('get-public-rooms', () => {
    socket.emit('public-rooms', listPublicRooms());
  });

  socket.on('list-public-rooms', () => {
    socket.emit('public-rooms', listPublicRooms());
  });

  socket.on('claim-room', ({ name, password, privacy } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const roomName = normalizeRoomName(name);
    if (!roomName || !password) {
      reply({ ok: false, error: 'Room name and password are required.' });
      return;
    }
    const record = getRoomRecord(roomName);
    if (!record) {
      const result = createRoomRecord({
        roomName,
        ownerPassword: password,
        privacy
      });
      reply(result.ok ? { ok: true } : { ok: false, error: result.error });
      return;
    }
    if (record.ownerPassword) {
      if (record.ownerPassword !== String(password || '')) {
        reply({ ok: false, error: 'Invalid room password.' });
        return;
      }
      reply({ ok: true });
      return;
    }
    updateRoomRecord(roomName, (room) => {
      room.ownerPassword = String(password);
      room.privacy = privacy === 'private' ? 'private' : 'public';
    });
    reply({ ok: true });
  });

  socket.on('enter-host-room', ({ roomName, password, privacy } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const normalizedName = normalizeRoomName(roomName);
    if (!normalizedName) {
      reply({ ok: false, error: 'Room name is required.' });
      return;
    }
    const record = getRoomRecord(normalizedName);
    if (!record) {
      const result = createRoomRecord({
        roomName: normalizedName,
        ownerPassword: password || null,
        privacy: privacy === 'private' ? 'private' : 'public'
      });
      if (result.ok && password) {
        if (!socket.data.hostAuthRooms) socket.data.hostAuthRooms = new Set();
        socket.data.hostAuthRooms.add(normalizedName);
      }
      reply(result.ok ? { ok: true, created: true } : { ok: false, error: result.error });
      return;
    }
    if (record.ownerPassword) {
      if (record.ownerPassword !== String(password || '')) {
        reply({ ok: false, error: 'Invalid room password.' });
        return;
      }
      if (!socket.data.hostAuthRooms) socket.data.hostAuthRooms = new Set();
      socket.data.hostAuthRooms.add(normalizedName);
    }
    reply({ ok: true, created: false });
  });

  socket.on('get-room-info', ({ roomName } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const record = getRoomRecord(roomName);
    const vipRequired =
      record && record.privacy === 'private' ? !!record.vipRequired : false;
    reply({
      exists: !!record,
      privacy: record ? record.privacy : 'public',
      hasOwnerPassword: !!(record && record.ownerPassword),
      vipRequired
    });
  });

  socket.on('get-room-config', ({ roomName } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const record = getRoomRecord(roomName);
    if (!record) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    reply({
      ok: true,
      paymentEnabled: !!record.paymentEnabled,
      paymentLabel: record.paymentLabel || '',
      paymentUrl: record.paymentUrl || '',
      turnConfig: record.turnConfig || {
        enabled: false,
        host: '',
        port: '',
        tlsPort: '',
        username: '',
        password: ''
      }
    });
  });

  socket.on('check-room-claimed', ({ roomName } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const record = getRoomRecord(roomName);
    const claimed = !!record;
    const hasPassword = !!(record && record.ownerPassword);
    reply({ claimed, hasPassword });
  });

  socket.on('auth-host-room', ({ name, roomName, password } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const targetName = roomName || name;
    const record = getRoomRecord(targetName);
    if (!record) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    if (record.ownerPassword !== String(password || '')) {
      reply({ ok: false, error: 'Invalid room password.' });
      return;
    }
    if (!socket.data.hostAuthRooms) socket.data.hostAuthRooms = new Set();
    socket.data.hostAuthRooms.add(record.roomName);
    reply({ ok: true });
  });

  socket.on('host-login', ({ name, password } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const record = getRoomRecord(name);
    if (!record) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    if (record.ownerPassword !== String(password || '')) {
      reply({ ok: false, error: 'Invalid room password.' });
      return;
    }
    reply({ ok: true });
  });

  socket.on('update-room-privacy', ({ roomName, privacy, name } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const targetName = roomName || name;
    if (!targetName || !privacy) {
      reply({ ok: false, error: 'Room name and privacy are required.' });
      return;
    }
    const info = getRoomInfo(targetName);
    if (!requireOwner(info, socket)) {
      reply({ ok: false, error: 'Only the host can update room privacy.' });
      return;
    }
    const normalizedPrivacy = privacy === 'private' ? 'private' : 'public';
    const result = updateRoomRecord(targetName, (room) => {
      room.privacy = normalizedPrivacy;
      if (normalizedPrivacy === 'public') {
        room.vipRequired = false;
      }
    });
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }
    broadcastRoomUpdate(targetName);
    reply({ ok: true, privacy: result.room.privacy, vipRequired: !!result.room.vipRequired });
  });

  socket.on('update-vip-required', ({ roomName, vipRequired } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const targetName = normalizeRoomName(roomName);
    if (!targetName) {
      reply({ ok: false, error: 'Room name is required.' });
      return;
    }
    const info = getRoomInfo(targetName);
    if (!requireOwner(info, socket)) {
      reply({ ok: false, error: 'Only the host can update VIP requirements.' });
      return;
    }
    const record = getRoomRecord(targetName);
    if (!record) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    if (record.privacy !== 'private' && vipRequired) {
      updateRoomRecord(targetName, (room) => {
        room.vipRequired = false;
      });
      broadcastRoomUpdate(targetName);
      reply({ ok: false, error: 'VIP access requires a private room.', vipRequired: false });
      return;
    }
    const result = updateRoomRecord(targetName, (room) => {
      room.vipRequired = !!vipRequired;
    });
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }
    broadcastRoomUpdate(targetName);
    reply({ ok: true, vipRequired: !!result.room.vipRequired });
  });

  socket.on('update-room-live', ({ roomName, name, isLive, live, viewers, title } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const targetName = roomName || name;
    if (!targetName) {
      reply({ ok: false, error: 'Room name is required.' });
      return;
    }
    const result = updateRoomRecord(targetName, (room) => {
      if (typeof isLive === 'boolean') room.isLive = isLive;
      if (typeof live === 'boolean') room.isLive = live;
      if (typeof viewers === 'number' && Number.isFinite(viewers)) {
        room.viewers = Math.max(0, Math.floor(viewers));
      }
      if (typeof title === 'string') {
        room.title = title.slice(0, 100) || null;
      }
    });
    reply(result.ok ? { ok: true } : { ok: false, error: result.error });
  });

  socket.on('update-room-payments', ({ roomName, paymentEnabled, paymentLabel, paymentUrl } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const targetName = normalizeRoomName(roomName);
    if (!targetName) {
      reply({ ok: false, error: 'Room name is required.' });
      return;
    }
    const info = rooms[targetName];
    if (!requireOwner(info, socket)) {
      reply({ ok: false, error: 'Only the host can update payment settings.' });
      return;
    }

    const normalizedLabel = normalizePaymentLabel(paymentLabel);
    const normalizedUrl = normalizePaymentUrl(paymentUrl);
    const enabled = !!paymentEnabled;

    if (enabled) {
      if (!normalizedLabel) {
        reply({ ok: false, error: 'Payment button label is required.' });
        return;
      }
      if (!normalizedUrl || !isValidPaymentUrl(normalizedUrl)) {
        reply({ ok: false, error: 'Payment URL must start with http:// or https://.' });
        return;
      }
    }

    const result = updateRoomRecord(targetName, (room) => {
      room.paymentEnabled = enabled;
      room.paymentLabel = normalizedLabel;
      room.paymentUrl = normalizedUrl;
    });

    reply(result.ok ? { ok: true } : { ok: false, error: result.error });
  });

  socket.on('update-room-turn', ({ roomName, turnConfig } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const targetName = normalizeRoomName(roomName);
    if (!targetName) {
      reply({ ok: false, error: 'Room name is required.' });
      return;
    }
    const info = rooms[targetName];
    if (!requireOwner(info, socket)) {
      reply({ ok: false, error: 'Only the host can update TURN settings.' });
      return;
    }

    const sanitized = sanitizeTurnConfig(turnConfig);
    if (!sanitized) {
      reply({ ok: false, error: 'TURN host, port, username, and password are required.' });
      return;
    }

    const result = updateRoomRecord(targetName, (room) => {
      room.turnConfig = sanitized;
    });

    reply(result.ok ? { ok: true } : { ok: false, error: result.error });
  });

  socket.on('add-vip-user', ({ room, userName } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const roomName = normalizeRoomName(room);
    const trimmedName = typeof userName === 'string' ? userName.trim() : '';
    if (!roomName || !trimmedName) {
      reply({ ok: false, error: 'Room and username are required.' });
      return;
    }
    const info = getRoomInfo(roomName);
    if (!requireOwner(info, socket)) {
      reply({ ok: false, error: 'Only the host can add VIP users.' });
      return;
    }
    const result = updateRoomRecord(roomName, (storedRoom) => {
      const exists = storedRoom.vipUsers.some(
        (user) => String(user).trim().toLowerCase() === trimmedName.toLowerCase()
      );
      if (!exists) storedRoom.vipUsers.push(trimmedName);
    });
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }
    reply({ ok: true });
  });

  socket.on('generate-vip-code', ({ room, maxUses } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const roomName = normalizeRoomName(room);
    if (!roomName) {
      reply({ ok: false, error: 'Room is required.' });
      return;
    }
    const info = getRoomInfo(roomName);
    if (!requireOwner(info, socket)) {
      reply({ ok: false, error: 'Only the host can generate VIP codes.' });
      return;
    }
    const record = getRoomRecord(roomName);
    if (!record) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    if (record.privacy !== 'private') {
      reply({ ok: false, error: 'VIP codes are only available for private rooms.' });
      return;
    }
    const code = generateVipCode(6);
    const parsedMaxUses = Number(maxUses);
    const isMultiUse = !Number.isFinite(parsedMaxUses) || parsedMaxUses <= 0;
    const normalizedMaxUses = isMultiUse ? null : Math.max(1, Math.floor(parsedMaxUses));
    const result = updateRoomRecord(roomName, (storedRoom) => {
      storedRoom.vipCodes[code] = {
        maxUses: normalizedMaxUses,
        usesLeft: normalizedMaxUses,
        used: 0,
        multiUse: isMultiUse
      };
    });
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }
    emitVipCodesUpdate(roomName);
    reply({
      ok: true,
      code,
      maxUses: normalizedMaxUses,
      usesLeft: normalizedMaxUses,
      multiUse: isMultiUse
    });
  });

  socket.on('get-vip-codes', ({ roomName, room } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const targetName = normalizeRoomName(roomName || room);
    if (!targetName) {
      reply({ ok: false, error: 'Room is required.' });
      return;
    }
    const info = getRoomInfo(targetName);
    if (!requireOwner(info, socket)) {
      reply({ ok: false, error: 'Only the host can view VIP codes.' });
      return;
    }
    const record = getRoomRecord(targetName);
    if (!record) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    reply({ ok: true, codes: listVipCodes(record) });
  });

  socket.on('revoke-vip-code', ({ roomName, code } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const targetName = normalizeRoomName(roomName);
    const normalized = normalizeVipCode(code);
    if (!targetName || !normalized) {
      reply({ ok: false, error: 'Room and code are required.' });
      return;
    }
    const info = getRoomInfo(targetName);
    if (!requireOwner(info, socket)) {
      reply({ ok: false, error: 'Only the host can revoke VIP codes.' });
      return;
    }
    const record = getRoomRecord(targetName);
    if (!record?.vipCodes?.[normalized]) {
      reply({ ok: false, error: 'VIP code not found.' });
      return;
    }
    const result = updateRoomRecord(targetName, (storedRoom) => {
      delete storedRoom.vipCodes[normalized];
    });
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }
    emitVipCodesUpdate(targetName);
    reply({ ok: true });
  });

  socket.on('redeem-vip-code', ({ code, desiredName } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const normalized = normalizeVipCode(code);
    if (!normalized) {
      reply({ ok: false, reason: 'invalid or exhausted' });
      return;
    }
    const entries = Object.values(roomDirectory.rooms);
    const targetRoom = entries.find((room) => room.vipCodes && room.vipCodes[normalized]);
    if (!targetRoom) {
      reply({ ok: false, reason: 'invalid or exhausted' });
      return;
    }
    const meta = targetRoom.vipCodes[normalized];
    const canUse = !!meta && (meta.multiUse || meta.usesLeft > 0);
    if (!canUse) {
      reply({ ok: false, reason: 'invalid or exhausted' });
      return;
    }
    let exhausted = false;
    const result = updateRoomRecord(targetRoom.roomName, (storedRoom) => {
      const liveMeta = storedRoom.vipCodes[normalized];
      if (!liveMeta || (!liveMeta.multiUse && liveMeta.usesLeft <= 0)) {
        exhausted = true;
        return;
      }
      if (liveMeta.multiUse) {
        liveMeta.used = (liveMeta.used || 0) + 1;
        return;
      }
      liveMeta.usesLeft -= 1;
      liveMeta.used = (liveMeta.used || 0) + 1;
    });
    if (!result.ok) {
      reply({ ok: false, reason: 'invalid or exhausted' });
      return;
    }
    if (exhausted) {
      reply({ ok: false, reason: 'invalid or exhausted' });
      return;
    }
    emitVipCodesUpdate(targetRoom.roomName);
    if (!socket.data.vipRooms) socket.data.vipRooms = new Set();
    socket.data.vipRooms.add(targetRoom.roomName);
    const vipToken = issueVipToken(targetRoom.roomName);
    reply({ ok: true, roomName: targetRoom.roomName, role: 'vip', vipToken, desiredName });

    const roomInfo = rooms[targetRoom.roomName];
    if (roomInfo?.ownerId) {
      io.to(roomInfo.ownerId).emit('vip-codes-updated', listVipCodes(targetRoom));
    }
  });

  // ======================================================
  // ROOM JOIN + ROLE ASSIGNMENT
  // ======================================================
  socket.on('join-room', ({ room, name, isViewer, vipCode, vipToken } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    if (!room || typeof room !== 'string') {
      reply({ ok: false, error: 'Invalid room' });
      socket.emit('room-error', 'Invalid room');
      return;
    }

    const roomName = room.trim().slice(0, 50);
    const rawName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;
    const displayName = rawName.slice(0, 30);

    const info = getRoomInfo(roomName);
    let directoryEntry = getRoomDirectoryEntry(roomName);
    if (directoryEntry && !directoryEntry.title) {
      updateRoomRecord(roomName, (storedRoom) => {
        storedRoom.title = info.streamTitle;
      });
    }

    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      reply({ ok: false, error: 'Room is locked by host' });
      socket.emit('room-error', 'Room is locked by host');
      socket.disconnect();
      return;
    }

    const viewerMode = !!isViewer;
    const wantsHost = !viewerMode;
    const isClaimed = isRoomClaimed(roomName);

    // Host access rules:
    // - Unclaimed rooms: first host joins without password and claims the room.
    // - Claimed rooms with a password: host must authenticate before joining.
    if (wantsHost && isClaimed && directoryEntry?.ownerPassword) {
      const authed = socket.data.hostAuthRooms && socket.data.hostAuthRooms.has(roomName);
      if (!authed) {
        reply({ ok: false, error: 'Host password required.' });
        return;
      }
    }

    if (wantsHost && !directoryEntry) {
      const created = createRoomRecord({
        roomName,
        ownerPassword: null,
        privacy: 'public'
      });
      if (!created.ok) {
        reply({ ok: false, error: created.error });
        return;
      }
      directoryEntry = getRoomDirectoryEntry(roomName);
    }

    // VIP access rules:
    // - Private rooms allow any named viewer.
    // - When VIP Required is enabled, viewers must be on the VIP list and provide a valid code.
    const vipRooms = socket.data.vipRooms;

    const privacy = directoryEntry ? directoryEntry.privacy : 'public';
    const isPrivate = privacy === 'private';
    const vipRequired = isPrivate ? !!directoryEntry.vipRequired : false;
    const vipGate = isPrivate && vipRequired;

    const vipByName =
      viewerMode &&
      vipGate &&
      Array.isArray(directoryEntry?.vipUsers) &&
      directoryEntry.vipUsers.some(
        (user) => String(user).trim().toLowerCase() === displayName.toLowerCase()
      );

    let vipByCode = false;
    if (viewerMode && vipGate && vipByName && vipCode && directoryEntry?.vipCodes) {
      const normalized = normalizeVipCode(vipCode);
      const meta = normalized ? directoryEntry.vipCodes[normalized] : null;
      const canUse = !!meta && (meta.multiUse || meta.usesLeft > 0);
      if (canUse) {
        let exhausted = false;
        const result = updateRoomRecord(roomName, (storedRoom) => {
          const liveMeta = storedRoom.vipCodes[normalized];
          if (!liveMeta || (!liveMeta.multiUse && liveMeta.usesLeft <= 0)) {
            exhausted = true;
            return;
          }
          if (liveMeta.multiUse) {
            liveMeta.used = (liveMeta.used || 0) + 1;
            return;
          }
          liveMeta.usesLeft -= 1;
          liveMeta.used = (liveMeta.used || 0) + 1;
        });
        if (result.ok && !exhausted) {
          vipByCode = true;
          emitVipCodesUpdate(roomName);
        }
      }
    }

    let vipTokenAccepted = false;
    if (viewerMode && vipGate && vipByName && vipToken) {
      vipTokenAccepted = consumeVipToken(vipToken, roomName);
      if (vipTokenAccepted) {
        if (!socket.data.vipRooms) socket.data.vipRooms = new Set();
        socket.data.vipRooms.add(roomName);
      }
    }

    const hasVipToken =
      vipGate && vipByName && (vipTokenAccepted || (vipRooms && vipRooms.has(roomName)));

    const isVip = viewerMode && vipGate && vipByName && (vipByCode || hasVipToken);

    if (viewerMode && vipGate && !vipByName) {
      reply({ ok: false, error: 'VIP username required.' });
      return;
    }

    if (viewerMode && vipGate && !vipByCode && !hasVipToken) {
      reply({ ok: false, error: vipCode ? 'Invalid or exhausted VIP code.' : 'VIP code required.' });
      return;
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;
    socket.data.isViewer = viewerMode;
    socket.data.isVip = isVip;
    socket.data.roomRole = isVip ? 'vip' : viewerMode ? 'viewer' : 'host';

    if (!info.ownerId && !viewerMode) {
      info.ownerId = socket.id;
    }

    if (viewerMode && directoryEntry) {
      updateRoomRecord(roomName, (storedRoom) => {
        storedRoom.viewers = Math.max(0, (storedRoom.viewers || 0) + 1);
      });
    }

    info.users.set(socket.id, {
      name: displayName,
      isViewer: viewerMode,
      requestingCall: false,
      isVip
    });

    const isHost = info.ownerId === socket.id;
    socket.emit('role', {
      isHost,
      streamTitle: info.streamTitle
    });

    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });
    broadcastRoomUpdate(roomName);
    const response = { ok: true, isVip, isHost };
    if (isHost && directoryEntry) {
      response.vipUsers = [...directoryEntry.vipUsers];
      response.vipCodes = listVipCodes(directoryEntry);
      response.privacy = directoryEntry.privacy;
      response.vipRequired = !!directoryEntry.vipRequired;
    }
    reply(response);

    if (viewerMode && vipByCode && directoryEntry) {
      const hostId = info.ownerId;
      if (hostId) {
        io.to(hostId).emit('vip-codes-updated', listVipCodes(directoryEntry));
      }
    }
  });

  // Viewer "raise hand" request (host receives a prompt)
  socket.on('request-to-call', () => {
    const roomName = requireRoom(socket);
    if (!roomName) return;
    const info = rooms[roomName];
    const user = info?.users.get(socket.id);

    if (user) {
      user.requestingCall = true;
      if (info.ownerId) {
        io.to(info.ownerId).emit('call-request-received', {
          id: socket.id,
          name: socket.data.name
        });
      }
      broadcastRoomUpdate(roomName);
    }
  });

  // Host handoff (ownership transfer)
  socket.on('promote-to-host', ({ targetId }) => {
    const roomName = requireRoom(socket);
    if (!roomName) return;
    const info = rooms[roomName];
    if (info && info.ownerId === socket.id) {
      info.ownerId = targetId;
      socket.emit('role', { isHost: false });
      const nextSocket = io.sockets.sockets.get(targetId);
      if (nextSocket) {
        nextSocket.emit('role', { isHost: true, streamTitle: info.streamTitle });
      }
      broadcastRoomUpdate(roomName);
    }
  });

  // Room locking (host only)
  socket.on('lock-room', (locked) => {
    const roomName = requireRoom(socket);
    if (!roomName) return;
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return;
    info.locked = !!locked;
    broadcastRoomUpdate(roomName);
  });

  // Stream title update (host only)
  socket.on('update-stream-title', (title) => {
    const roomName = requireRoom(socket);
    if (!roomName) return;
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return;
    info.streamTitle = (title || 'Untitled Stream').slice(0, 100);
    const directoryEntry = getRoomDirectoryEntry(roomName);
    if (directoryEntry) {
      updateRoomRecord(roomName, (storedRoom) => {
        storedRoom.title = info.streamTitle;
      });
    }
    broadcastRoomUpdate(roomName);
  });

  // Remove a user from the room (host only)
  socket.on('kick-user', (targetId) => {
    const roomName = requireRoom(socket);
    if (!roomName) return;
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.leave(roomName);
      targetSocket.disconnect();
    }
    info.users.delete(targetId);
    broadcastRoomUpdate(roomName);
  });

  // ======================================================
  // WEBRTC BROADCAST SIGNALING (host <-> viewer)
  // ======================================================
  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    if (targetId && sdp) relayToTarget('webrtc-offer', targetId, { sdp, from: socket.id });
  });
  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    if (targetId && sdp) relayToTarget('webrtc-answer', targetId, { sdp, from: socket.id });
  });
  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) relayToTarget('webrtc-ice-candidate', targetId, { candidate, from: socket.id });
  });

  // ======================================================
  // CALL SIGNALING (host <-> viewer 1:1)
  // ======================================================
  socket.on('ring-user', (targetId) => {
    relayToTarget('ring-alert', targetId, { from: socket.data.name, fromId: socket.id });
  });
  socket.on('call-offer', ({ targetId, offer }) => {
    if (targetId && offer) {
      relayToTarget('incoming-call', targetId, { from: socket.id, name: socket.data.name, offer });
    }
  });
  socket.on('call-answer', ({ targetId, answer }) => {
    if (targetId && answer) relayToTarget('call-answer', targetId, { from: socket.id, answer });
  });
  socket.on('call-ice', ({ targetId, candidate }) => {
    if (targetId && candidate) relayToTarget('call-ice', targetId, { from: socket.id, candidate });
  });
  socket.on('call-end', ({ targetId }) => {
    relayToTarget('call-end', targetId, { from: socket.id });
  });

  // ======================================================
  // CHAT + FILE EVENTS
  // ======================================================
  socket.on('public-chat', ({ room, name, text, fromViewer }) => {
    const roomName = normalizeRoomName(room || socket.data.room);
    if (!roomName || !text) return;
    const info = rooms[roomName];
    io.to(roomName).emit('public-chat', {
      name: (name || socket.data.name || 'Anon').slice(0, 30),
      text: String(text).slice(0, 500),
      ts: Date.now(),
      isOwner: info && info.ownerId === socket.id,
      fromViewer: !!fromViewer
    });
  });

  socket.on('private-chat', ({ room, name, text }) => {
    const roomName = normalizeRoomName(room || socket.data.room);
    if (!roomName || !text) return;
    io.to(roomName).emit('private-chat', {
      name: (name || socket.data.name || 'Anon').slice(0, 30),
      text: String(text).slice(0, 500),
      ts: Date.now()
    });
  });

  socket.on('file-share', ({ room, name, fileName, fileType, fileData }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !fileName || !fileData) return;
    io.to(roomName).emit('file-share', {
      name: (name || socket.data.name).slice(0, 30),
      fileName: String(fileName).slice(0, 100),
      fileType: fileType || 'application/octet-stream',
      fileData
    });
  });

  // ======================================================
  // CLEANUP
  // ======================================================
  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info) return;
    info.users.delete(socket.id);
    const directoryEntry = getRoomDirectoryEntry(roomName);
    if (directoryEntry && socket.data.isViewer) {
      updateRoomRecord(roomName, (storedRoom) => {
        storedRoom.viewers = Math.max(0, (storedRoom.viewers || 0) - 1);
      });
    }

    if (info.ownerId === socket.id) {
      info.ownerId = null;
      if (directoryEntry) {
        updateRoomRecord(roomName, (storedRoom) => {
          storedRoom.isLive = false;
        });
      }
    }

    socket.to(roomName).emit('user-left', { id: socket.id });
    if (info.users.size === 0) delete rooms[roomName];
    else broadcastRoomUpdate(roomName);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel Secure Server running on ${PORT}`);
});
