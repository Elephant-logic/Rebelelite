require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);

// Middleware for parsing JSON and raw body (needed for Stripe webhooks)
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

// Increased buffer to 50MB for large arcade transfers
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e7,
  pingTimeout: 10000,
  pingInterval: 25000
});

const TreeManager = require('./tree-manager');
const treeManager = new TreeManager();

// ========== FOUNDATION REGISTRY INTEGRATION ==========
const FoundationRegistry = require('./foundation-registry');
const StripeHandler = require('./stripe-handler');

const foundationRegistry = new FoundationRegistry();
const stripeHandler = new StripeHandler(foundationRegistry);

// Initialize Foundation Registry
(async () => {
  await foundationRegistry.init();
  console.log('[Foundation] Registry initialized');
  
  const status = foundationRegistry.getStatus();
  console.log(`[Foundation] ${status.totalSold}/${status.limit} rooms sold (${status.remaining} remaining)`);
})();
// ========== END FOUNDATION REGISTRY INTEGRATION ==========


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/selftest', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selftest.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ========== FOUNDATION API ROUTES ==========
// API: Get Foundation Registry status
app.get('/api/foundation/status', (req, res) => {
  res.json(foundationRegistry.getStatus());
});

// API: Check if room name is available
app.get('/api/foundation/check/:roomName', (req, res) => {
  const { roomName } = req.params;
  
  if (!/^[a-z0-9-]{3,32}$/.test(roomName)) {
    return res.status(400).json({ 
      error: 'Invalid room name format',
      available: false 
    });
  }

  const available = foundationRegistry.isAvailable(roomName);
  const isFoundation = foundationRegistry.isFoundationRoom(roomName);

  res.json({ 
    available,
    isFoundation,
    roomName 
  });
});

// API: Create Stripe Checkout Session
app.post('/api/foundation/purchase', async (req, res) => {
  try {
    const { roomName, password, email } = req.body;

    if (!roomName || !password || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const successUrl = `${req.protocol}://${req.get('host')}/purchase-success?session_id={CHECKOUT_SESSION_ID}&room=${encodeURIComponent(roomName)}`;
    const cancelUrl = `${req.protocol}://${req.get('host')}/purchase-cancelled`;

    const session = await stripeHandler.createCheckoutSession(
      roomName,
      password,
      email,
      successUrl,
      cancelUrl
    );

    res.json({ 
      success: true,
      sessionId: session.sessionId,
      url: session.url 
    });
  } catch (err) {
    console.error('[API] Purchase error:', err);
    res.status(400).json({ 
      error: err.message || 'Purchase failed' 
    });
  }
});

// Stripe Webhook Handler
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const result = await stripeHandler.handleWebhook(req.body, sig);
    
    // Broadcast updated status to all connected clients
    const status = foundationRegistry.getStatus();
    io.emit('foundation-update', status);

    res.json(result);
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});
// ========== END FOUNDATION API ROUTES ==========

app.get('/api/tree', (req, res) => {
  const { room } = req.query;
  if (!room) return res.status(400).json({ error: 'Missing room' });

  const tree = treeManager.trees.get(room);
  if (!tree) return res.status(404).json({ error: 'Room not found' });

  const nodes = [];
  tree.nodes.forEach(node => {
    nodes.push({
      id: node.socketId,
      parentId: node.parent,
      tier: node.tier,
      capacity: node.capacity,
      childrenCount: node.children.size
    });
  });

  res.json({
    hostId: tree.host,
    nodes
  });
});

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
    },
    isFoundationRoom: false // ADDED for Foundation tracking
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
      live: !!room.isLive,
      isFoundationRoom: !!room.isFoundationRoom // ADDED for Foundation badge
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
  return Object.entries(record.vipCodes).map(([code, meta]) => ({
    code,
    maxUses: meta.maxUses,
    usesLeft: meta.usesLeft,
    used: Math.max(0, meta.maxUses - meta.usesLeft)
  }));
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
  if (!isValidTurnConfig(normalized)) {
    return { enabled: false, host: '', port: '', tlsPort: '', username: '', password: '' };
  }
  return normalized;
}

function broadcastRoomUpdate(roomName) {
  const info = rooms[roomName];
  if (!info) return;
  const userList = buildUserList(info);
  io.to(roomName).emit('room-state', {
    locked: info.locked,
    users: userList,
    streamTitle: info.streamTitle
  });
}

function relayToTarget(event, targetId, data) {
  io.to(targetId).emit(event, data);
}

io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  // ========== FOUNDATION STATUS ON CONNECT ==========
  socket.emit('foundation-update', foundationRegistry.getStatus());
  // ========== END FOUNDATION STATUS ==========

  socket.on('claim-room', ({ name, password, privacy }, callback) => {
    const roomName = normalizeRoomName(name);
    if (!roomName) return callback({ ok: false, error: 'Invalid room name.' });

    // ========== FOUNDATION CHECK ==========
    if (foundationRegistry.isFoundationRoom(roomName)) {
      return callback({ 
        ok: false, 
        error: 'This is a Foundation Room. Purchase required at landing page.' 
      });
    }
    // ========== END FOUNDATION CHECK ==========

    if (roomDirectory.rooms[roomName]) {
      return callback({ ok: false, error: 'Room name already claimed.' });
    }

    const result = createRoomRecord({ roomName, ownerPassword: password, privacy });
    if (!result.ok) return callback(result);
    callback({ ok: true });
  });

  socket.on('enter-host-room', ({ roomName, password }, callback) => {
    const normalized = normalizeRoomName(roomName);
    if (!normalized) return callback({ ok: false, error: 'Invalid room name.' });

    // ========== FOUNDATION AUTHENTICATION ==========
    const isFoundation = foundationRegistry.isFoundationRoom(normalized);

    if (isFoundation) {
      // Foundation Room - require password verification
      if (!password) {
        return callback({ 
          ok: false, 
          error: 'This is a Foundation Room. Password required.',
          isFoundationRoom: true
        });
      }

      if (!foundationRegistry.verifyPassword(normalized, password)) {
        return callback({ 
          ok: false, 
          error: 'Incorrect Foundation Room password',
          isFoundationRoom: true
        });
      }

      // Password verified - create or get room record
      if (!roomDirectory.rooms[normalized]) {
        const record = buildRoomRecord({ 
          roomName: normalized, 
          ownerPassword: password, 
          privacy: 'public' 
        });
        record.isFoundationRoom = true;
        roomDirectory.rooms[normalized] = record;
      }

      console.log(`[Foundation] Host authenticated: ${normalized}`);
      return callback({ 
        ok: true,
        isFoundationRoom: true,
        roomInfo: foundationRegistry.getRoomInfo(normalized)
      });
    }
    // ========== END FOUNDATION AUTHENTICATION ==========

    // Legacy room logic
    let record = roomDirectory.rooms[normalized];
    if (!record) {
      const result = createRoomRecord({ roomName: normalized, ownerPassword: password, privacy: 'public' });
      if (!result.ok) return callback(result);
      record = result.room;
    }

    if (record.ownerPassword && record.ownerPassword !== password) {
      return callback({ ok: false, error: 'Incorrect room password.' });
    }

    callback({ ok: true, isFoundationRoom: false });
  });

  socket.on('get-public-rooms', () => {
    socket.emit('public-rooms', listPublicRooms());
  });

  socket.on('create-room', ({ room, ownerPassword, privacy, userName }) => {
    const roomName = normalizeRoomName(room);
    if (!roomName) return socket.emit('error-message', 'Invalid room name.');
    let record = getRoomDirectoryEntry(roomName);
    if (!record) {
      const result = createRoomRecord({ roomName, ownerPassword, privacy });
      if (!result.ok) return socket.emit('error-message', result.error);
      record = result.room;
      
      // ========== MARK AS FOUNDATION IF APPLICABLE ==========
      if (foundationRegistry.isFoundationRoom(roomName)) {
        record.isFoundationRoom = true;
      }
      // ========== END FOUNDATION MARK ==========
    }

    const info = getRoomInfo(roomName);
    const wasPreviousOwner = info.ownerId && info.ownerId !== socket.id;
    if (wasPreviousOwner) {
      const oldOwnerSocket = io.sockets.sockets.get(info.ownerId);
      if (oldOwnerSocket && oldOwnerSocket.data.room === roomName) {
        return socket.emit('error-message', 'A host is already live in this room.');
      }
    }

    info.ownerId = socket.id;
    socket.data.room = roomName;
    socket.data.name = userName;
    socket.data.isHost = true;
    socket.join(roomName);

    updateRoomRecord(roomName, (storedRoom) => {
      storedRoom.isLive = true;
    });

    info.users.set(socket.id, {
      name: userName,
      isHost: true
    });

    socket.emit('room-created', { 
      room: roomName,
      isFoundationRoom: record.isFoundationRoom || false
    });

    broadcastRoomUpdate(roomName);
  });

  socket.on('generate-vip-code', ({ maxUses = 1 }, callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return callback({ ok: false, error: 'Not the owner.' });

    let code;
    let attempts = 0;
    const record = getRoomDirectoryEntry(roomName);
    if (!record) return callback({ ok: false, error: 'Room not found in directory.' });

    do {
      code = generateVipCode();
      attempts += 1;
      if (attempts > 100) return callback({ ok: false, error: 'Unable to generate unique code.' });
    } while (record.vipCodes[code]);

    const result = updateRoomRecord(roomName, (storedRoom) => {
      storedRoom.vipCodes[code] = { maxUses, usesLeft: maxUses };
    });

    if (!result.ok) return callback(result);
    emitVipCodesUpdate(roomName);
    callback({ ok: true, code });
  });

  socket.on('revoke-vip-code', ({ code }, callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return callback({ ok: false, error: 'Not the owner.' });

    const result = updateRoomRecord(roomName, (storedRoom) => {
      delete storedRoom.vipCodes[code];
    });

    if (!result.ok) return callback(result);
    emitVipCodesUpdate(roomName);
    callback({ ok: true });
  });

  socket.on('set-vip-required', ({ required }, callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return callback({ ok: false, error: 'Not the owner.' });

    const result = updateRoomRecord(roomName, (storedRoom) => {
      storedRoom.vipRequired = !!required;
    });

    if (!result.ok) return callback(result);
    callback({ ok: true });
  });

  socket.on('generate-vip-token', (callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return callback({ ok: false, error: 'Not the owner.' });

    const token = issueVipToken(roomName);
    const record = getRoomDirectoryEntry(roomName);
    if (!record) return callback({ ok: false, error: 'Room not found.' });

    const link = `${roomName}?vipToken=${encodeURIComponent(token)}`;
    callback({ ok: true, link });
  });

  socket.on('add-vip-user', ({ userId, userName }, callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return callback({ ok: false, error: 'Not the owner.' });

    const result = updateRoomRecord(roomName, (storedRoom) => {
      if (!storedRoom.vipUsers) storedRoom.vipUsers = [];
      if (!storedRoom.vipUsers.includes(userId)) {
        storedRoom.vipUsers.push(userId);
      }
    });

    if (!result.ok) return callback(result);
    callback({ ok: true });
  });

  socket.on('set-payment-info', ({ enabled, label, url }, callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return callback({ ok: false, error: 'Not the owner.' });

    const paymentEnabled = !!enabled;
    const paymentLabel = normalizePaymentLabel(label);
    const paymentUrl = normalizePaymentUrl(url);

    if (paymentEnabled && !isValidPaymentUrl(paymentUrl)) {
      return callback({ ok: false, error: 'Invalid payment URL.' });
    }

    const result = updateRoomRecord(roomName, (storedRoom) => {
      storedRoom.paymentEnabled = paymentEnabled;
      storedRoom.paymentLabel = paymentLabel;
      storedRoom.paymentUrl = paymentUrl;
    });

    if (!result.ok) return callback(result);
    callback({ ok: true });
  });

  socket.on('get-payment-info', (callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const record = getRoomDirectoryEntry(roomName);
    if (!record) return callback({ ok: false, error: 'Room not found.' });

    if (!record.paymentEnabled) return callback({ ok: false, error: 'Payment not enabled.' });

    callback({
      ok: true,
      enabled: record.paymentEnabled,
      label: record.paymentLabel,
      url: record.paymentUrl
    });
  });

  socket.on('set-turn-config', ({ config }, callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return callback({ ok: false, error: 'Not the owner.' });

    const sanitized = sanitizeTurnConfig(config);
    const result = updateRoomRecord(roomName, (storedRoom) => {
      storedRoom.turnConfig = sanitized;
    });

    if (!result.ok) return callback(result);
    callback({ ok: true, turnConfig: sanitized });
  });

  socket.on('get-turn-config', (callback) => {
    const roomName = requireRoom(socket);
    if (!roomName) return callback({ ok: false, error: 'No active room.' });
    const record = getRoomDirectoryEntry(roomName);
    if (!record) return callback({ ok: false, error: 'Room not found.' });

    const config = record.turnConfig || { enabled: false };
    callback({ ok: true, turnConfig: config });
  });

  socket.on('join-room-as-viewer', ({ room, name, isViewer, vipCode, vipToken }, reply) => {
    if (typeof reply !== 'function') {
      reply = () => {};
    }

    const displayName = name ? String(name).slice(0, 30) : 'Anon';
    const roomName = normalizeRoomName(room);
    if (!roomName) {
      return reply({ ok: false, error: 'Invalid room name.' });
    }

    const directoryEntry = getRoomDirectoryEntry(roomName);
    const viewerMode = !!isViewer;
    const info = getRoomInfo(roomName);

    let vipRooms = null;
    let vipTokenAccepted = false;
    if (viewerMode && vipToken && consumeVipToken(vipToken, roomName)) {
      vipTokenAccepted = true;
      const record = getRoomDirectoryEntry(roomName);
      if (record && !record.vipUsers) record.vipUsers = [];
      if (record && !record.vipUsers.includes(socket.id)) {
        const result = updateRoomRecord(roomName, (storedRoom) => {
          if (!storedRoom.vipUsers.includes(socket.id)) {
            storedRoom.vipUsers.push(socket.id);
          }
        });
        if (result.ok) {
          vipRooms = new Set([roomName]);
        }
      }
    }

    let vipByCode = false;
    if (viewerMode && vipCode && directoryEntry?.vipCodes) {
      const normalized = normalizeVipCode(vipCode);
      const meta = normalized ? directoryEntry.vipCodes[normalized] : null;
      if (meta && meta.usesLeft > 0) {
        let exhausted = false;
        const result = updateRoomRecord(roomName, (storedRoom) => {
          const liveMeta = storedRoom.vipCodes[normalized];
          if (!liveMeta || liveMeta.usesLeft <= 0) {
            exhausted = true;
            return;
          }
          liveMeta.usesLeft -= 1;
        });
        if (result.ok && !exhausted) {
          vipByCode = true;
          emitVipCodesUpdate(roomName);
        }
      }
    }

    const isVip =
      viewerMode && (vipByCode || (vipRooms && vipRooms.has(roomName)) || vipTokenAccepted);
    const vipRequired = directoryEntry ? !!directoryEntry.vipRequired : false;

    if (viewerMode && directoryEntry?.privacy === 'private' && vipRequired && !isVip) {
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

  socket.on('lock-room', (locked) => {
    const roomName = requireRoom(socket);
    if (!roomName) return;
    const info = rooms[roomName];
    if (!requireOwner(info, socket)) return;
    info.locked = !!locked;
    broadcastRoomUpdate(roomName);
  });

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

  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    if (targetId && sdp) relayToTarget('webrtc-offer', targetId, { sdp, from: socket.id });
  });
  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    if (targetId && sdp) relayToTarget('webrtc-answer', targetId, { sdp, from: socket.id });
  });
  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) relayToTarget('webrtc-ice-candidate', targetId, { candidate, from: socket.id });
  });

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

  require('./server-relay-events')(io, socket, treeManager, rooms, roomDirectory);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║        🎙️  REBEL STREAM - FOUNDATION EDITION            ║
║                                                           ║
║        Server running on port ${PORT}                     ║
║        Foundation Registry: ACTIVE                        ║
║        Stripe Integration: ENABLED                        ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
