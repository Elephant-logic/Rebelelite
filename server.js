require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

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
const FoundationRegistry = require('./foundation-registry');
const StripeHandler = require('./stripe-handler');

const treeManager = new TreeManager();
const foundationRegistry = new FoundationRegistry();
const stripeHandler = new StripeHandler(foundationRegistry);

// Initialize Foundation Registry
(async () => {
  await foundationRegistry.init();
  console.log('[Foundation] Registry initialized');
  
  const status = foundationRegistry.getStatus();
  console.log(`[Foundation] ${status.totalSold}/${status.limit} rooms sold (${status.remaining} remaining)`);
})();

// Static file serving
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

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

// API: Get tree visualization
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

// Persistent room registry
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
    isFoundationRoom: false
  };
}

// Socket.IO Connection Handler
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Send current foundation status on connection
  socket.emit('foundation-update', foundationRegistry.getStatus());

  // --- CLAIM ROOM (Legacy - still works for non-foundation rooms) ---
  socket.on('claim-room', ({ name, password, privacy }, callback) => {
    const roomName = normalizeRoomName(name);

    if (!roomName) {
      return callback({ ok: false, error: 'Invalid room name' });
    }

    // Check if it's already a foundation room
    if (foundationRegistry.isFoundationRoom(roomName)) {
      return callback({ 
        ok: false, 
        error: 'This is a Foundation Room. Purchase required.' 
      });
    }

    if (roomDirectory.rooms[roomName]) {
      return callback({ ok: false, error: 'Room name already claimed' });
    }

    const record = buildRoomRecord({ roomName, ownerPassword: password, privacy });
    roomDirectory.rooms[roomName] = record;

    console.log(`[Registry] Claimed: ${roomName}`);
    callback({ ok: true });
  });

  // --- ENTER HOST ROOM (Modified with Foundation check) ---
  socket.on('enter-host-room', ({ roomName, password }, callback) => {
    const normalized = normalizeRoomName(roomName);

    if (!normalized) {
      return callback({ ok: false, error: 'Invalid room name' });
    }

    // Check if it's a Foundation Room
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

    // Not a Foundation Room - use legacy logic
    let record = roomDirectory.rooms[normalized];

    if (!record) {
      // Room doesn't exist - create it
      record = buildRoomRecord({ 
        roomName: normalized, 
        ownerPassword: password, 
        privacy: 'public' 
      });
      roomDirectory.rooms[normalized] = record;
      console.log(`[Registry] Created guest room: ${normalized}`);
      return callback({ ok: true, isFoundationRoom: false });
    }

    // Room exists - check password
    if (record.ownerPassword && record.ownerPassword !== password) {
      return callback({ 
        ok: false, 
        error: 'Incorrect room password',
        isFoundationRoom: false
      });
    }

    callback({ ok: true, isFoundationRoom: false });
  });

  // --- GET PUBLIC ROOMS ---
  socket.on('get-public-rooms', () => {
    const publicRooms = [];
    for (const roomName in roomDirectory.rooms) {
      const record = roomDirectory.rooms[roomName];
      if (record.privacy === 'public' && record.isLive) {
        publicRooms.push({
          name: roomName,
          title: record.title || null,
          viewers: record.viewers || 0,
          isFoundationRoom: record.isFoundationRoom || false
        });
      }
    }
    socket.emit('public-rooms', publicRooms);
  });

  // --- ROOM MANAGEMENT ---
  socket.on('create-room', ({ room, ownerPassword, privacy, userName }) => {
    const roomName = normalizeRoomName(room);
    if (!roomName) return socket.emit('error-message', 'Invalid room name');

    let record = roomDirectory.rooms[roomName];

    if (!record) {
      record = buildRoomRecord({ roomName, ownerPassword, privacy });
      roomDirectory.rooms[roomName] = record;

      if (foundationRegistry.isFoundationRoom(roomName)) {
        record.isFoundationRoom = true;
      }
    }

    if (!rooms[roomName]) {
      rooms[roomName] = {
        ownerId: socket.id,
        users: new Map(),
        record
      };
    }

    const info = rooms[roomName];
    const wasPreviousOwner = info.ownerId && info.ownerId !== socket.id;

    if (wasPreviousOwner) {
      const oldOwnerSocket = io.sockets.sockets.get(info.ownerId);
      if (oldOwnerSocket && oldOwnerSocket.data.room === roomName) {
        return socket.emit('error-message', 'A host is already live in this room');
      }
    }

    info.ownerId = socket.id;
    socket.data.room = roomName;
    socket.data.name = userName;
    socket.data.isHost = true;
    socket.join(roomName);

    record.isLive = true;

    info.users.set(socket.id, {
      name: userName,
      isHost: true
    });

    socket.emit('room-created', { 
      room: roomName,
      isFoundationRoom: record.isFoundationRoom || false
    });

    console.log(`[Room] Created: ${roomName} by ${userName} (Foundation: ${record.isFoundationRoom})`);
  });

  // --- RELAY NETWORK EVENTS ---
  require('./server-relay-events')(io, socket, treeManager, rooms, roomDirectory);

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const roomName = socket.data.room;

    if (!roomName) return;

    const info = rooms[roomName];
    if (!info) return;

    const wasOwner = info.ownerId === socket.id;
    info.users.delete(socket.id);

    if (wasOwner) {
      console.log(`[Room] Host left: ${roomName}`);
      const record = roomDirectory.rooms[roomName];
      if (record) record.isLive = false;

      io.to(roomName).emit('host-left');

      if (info.users.size === 0) {
        // Don't delete Foundation Room records
        if (!record || !record.isFoundationRoom) {
          delete rooms[roomName];
          console.log(`[Room] Destroyed: ${roomName}`);
        }
      }
    } else {
      socket.to(roomName).emit('user-left', { id: socket.id });
    }
  });
});

// Start server
server.listen(PORT, () => {
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
