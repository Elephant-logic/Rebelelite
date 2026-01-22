const fs = require('fs');
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

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state (per room: owner, lock state, users)
const rooms = Object.create(null);
const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const DEFAULT_ROOMS_STORE = { rooms: {} };
let roomsStore = loadRoomsStore();
let roomsWritePromise = Promise.resolve();

function normalizeRoomName(roomName) {
  if (!roomName || typeof roomName !== 'string') return '';
  return roomName.trim().slice(0, 50);
}

function ensureRoomsFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ROOMS_FILE)) {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(DEFAULT_ROOMS_STORE, null, 2));
  }
}

function normalizeStoredRoom(record) {
  if (!record || typeof record !== 'object') return false;
  let changed = false;
  if (!Array.isArray(record.vipUsers)) {
    record.vipUsers = [];
    changed = true;
  }
  if (!Array.isArray(record.vipCodes)) {
    record.vipCodes = [];
    changed = true;
  }
  if (typeof record.paid !== 'boolean') {
    record.paid = false;
    changed = true;
  }
  return changed;
}

function loadRoomsStore() {
  ensureRoomsFile();
  try {
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
    if (!raw.trim()) return { rooms: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.rooms !== 'object') {
      fs.writeFileSync(ROOMS_FILE, JSON.stringify(DEFAULT_ROOMS_STORE, null, 2));
      return { rooms: {} };
    }
    let changed = false;
    Object.values(parsed.rooms).forEach((room) => {
      if (normalizeStoredRoom(room)) changed = true;
    });
    if (changed) {
      fs.writeFileSync(ROOMS_FILE, JSON.stringify(parsed, null, 2));
    }
    return parsed;
  } catch (error) {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(DEFAULT_ROOMS_STORE, null, 2));
    return { rooms: {} };
  }
}

function queueRoomsWrite() {
  const payload = JSON.stringify(roomsStore, null, 2);
  const writeTask = roomsWritePromise.then(() => fs.promises.writeFile(ROOMS_FILE, payload));
  roomsWritePromise = writeTask.catch(() => {});
  return writeTask;
}

function getStoredRoom(roomName) {
  const name = normalizeRoomName(roomName);
  if (!name) return null;
  const record = roomsStore.rooms[name] || null;
  if (record) normalizeStoredRoom(record);
  return record;
}

function listPublicRooms() {
  return Object.values(roomsStore.rooms)
    .filter((room) => room.privacy === 'public')
    .map((room) => ({
      name: room.name,
      viewers: typeof room.viewers === 'number' ? room.viewers : 0,
      title: room.title || null,
      live: !!room.live
    }));
}

async function createStoredRoom({ name, password, privacy, owner }) {
  const roomName = normalizeRoomName(name);
  if (!roomName) return { ok: false, error: 'Invalid room name.' };
  if (roomsStore.rooms[roomName]) {
    return { ok: false, error: 'Room already claimed.' };
  }
  const record = {
    name: roomName,
    password: String(password || ''),
    privacy: privacy === 'private' ? 'private' : 'public',
    owner: owner || null,
    created: new Date().toISOString(),
    live: false,
    viewers: 0,
    title: null,
    vipUsers: [],
    vipCodes: [],
    paid: false
  };
  roomsStore.rooms[roomName] = record;
  try {
    await queueRoomsWrite();
    return { ok: true, room: record };
  } catch (error) {
    delete roomsStore.rooms[roomName];
    return { ok: false, error: 'Unable to save room.' };
  }
}

async function updateStoredRoom(roomName, updater) {
  const name = normalizeRoomName(roomName);
  if (!name) return { ok: false, error: 'Invalid room name.' };
  const existing = roomsStore.rooms[name];
  if (!existing) return { ok: false, error: 'Room not found.' };
  const previous = { ...existing };
  updater(existing);
  try {
    await queueRoomsWrite();
    return { ok: true, room: existing };
  } catch (error) {
    roomsStore.rooms[name] = previous;
    return { ok: false, error: 'Unable to save room.' };
  }
}

function getRoomDirectoryEntry(roomName) {
  return getStoredRoom(roomName);
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

function normalizeVipCode(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().toUpperCase();
}

function isVipForRoom(record, displayName, vipCode) {
  if (!record) return false;
  const normalizedName = (displayName || '').trim().toLowerCase();
  const normalizedCode = normalizeVipCode(vipCode);
  const vipByName = normalizedName
    ? record.vipUsers.some((user) => String(user).trim().toLowerCase() === normalizedName)
    : false;
  const vipByCode = normalizedCode
    ? record.vipCodes.some((code) => normalizeVipCode(code) === normalizedCode)
    : false;
  return vipByName || vipByCode;
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

function broadcastRoomUpdate(roomName) {
  const room = rooms[roomName];
  if (!room) return;

  io.to(roomName).emit('room-update', {
    users: buildUserList(room),
    ownerId: room.ownerId,
    locked: room.locked,
    streamTitle: room.streamTitle
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

  socket.on('claim-room', async ({ name, password, public: isPublic } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    if (!name || !password) {
      reply({ ok: false, error: 'Room name and password are required.' });
      return;
    }
    const result = await createStoredRoom({
      name,
      password,
      privacy: isPublic ? 'public' : 'private',
      owner: socket.id
    });
    reply(result.ok ? { ok: true } : { ok: false, error: result.error });
  });

  socket.on('auth-host-room', ({ name, password } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const record = getStoredRoom(name);
    if (!record) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    if (record.password !== String(password || '')) {
      reply({ ok: false, error: 'Invalid room password.' });
      return;
    }
    reply({ ok: true });
  });

  socket.on('host-login', ({ name, password } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const record = getStoredRoom(name);
    if (!record) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    if (record.password !== String(password || '')) {
      reply({ ok: false, error: 'Invalid room password.' });
      return;
    }
    reply({ ok: true });
  });

  socket.on('update-room-privacy', async ({ name, privacy } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    if (!name || !privacy) {
      reply({ ok: false, error: 'Room name and privacy are required.' });
      return;
    }
    const normalizedPrivacy = privacy === 'private' ? 'private' : 'public';
    const result = await updateStoredRoom(name, (room) => {
      room.privacy = normalizedPrivacy;
    });
    reply(result.ok ? { ok: true } : { ok: false, error: result.error });
  });

  socket.on('update-room-live', async ({ name, live, viewers, title } = {}, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    if (!name) {
      reply({ ok: false, error: 'Room name is required.' });
      return;
    }
    const result = await updateStoredRoom(name, (room) => {
      if (typeof live === 'boolean') room.live = live;
      if (typeof viewers === 'number' && Number.isFinite(viewers)) {
        room.viewers = Math.max(0, Math.floor(viewers));
      }
      if (typeof title === 'string') {
        room.title = title.slice(0, 100) || null;
      }
    });
    reply(result.ok ? { ok: true } : { ok: false, error: result.error });
  });

  socket.on('add-vip-user', async ({ room, userName } = {}, callback) => {
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
    const result = await updateStoredRoom(roomName, (storedRoom) => {
      normalizeStoredRoom(storedRoom);
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

  socket.on('generate-vip-code', async ({ room } = {}, callback) => {
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
    const code = generateVipCode(6);
    const result = await updateStoredRoom(roomName, (storedRoom) => {
      normalizeStoredRoom(storedRoom);
      storedRoom.vipCodes.push(code);
    });
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }
    reply({ ok: true, code });
  });

  // ======================================================
  // ROOM JOIN + ROLE ASSIGNMENT
  // ======================================================
  socket.on('join-room', ({ room, name, isViewer, vipCode } = {}, callback) => {
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
    const directoryEntry = getRoomDirectoryEntry(roomName);
    if (directoryEntry && !directoryEntry.title) {
      updateStoredRoom(roomName, (storedRoom) => {
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
    const isVip = viewerMode ? isVipForRoom(directoryEntry, displayName, vipCode) : false;

    if (viewerMode && directoryEntry?.privacy === 'private' && !isVip) {
      reply({ ok: false, error: 'This room is private · VIPs only' });
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
      normalizeStoredRoom(directoryEntry);
      response.vipUsers = [...directoryEntry.vipUsers];
      response.vipCodes = [...directoryEntry.vipCodes];
      response.privacy = directoryEntry.privacy;
    }
    reply(response);
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
      updateStoredRoom(roomName, (storedRoom) => {
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
    const roomName = room || socket.data.room;
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
    const roomName = room || socket.data.room;
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
      updateStoredRoom(roomName, (storedRoom) => {
        storedRoom.viewers = Math.max(0, (storedRoom.viewers || 0) - 1);
      });
    }

    if (info.ownerId === socket.id) {
      info.ownerId = null;
      if (directoryEntry) {
        updateStoredRoom(roomName, (storedRoom) => {
          storedRoom.live = false;
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
