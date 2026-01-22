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
const roomDirectory = new Map();

function normalizeRoomName(roomName) {
  if (!roomName || typeof roomName !== 'string') return '';
  return roomName.trim().slice(0, 50);
}

function getRoomDirectoryEntry(roomName) {
  const name = normalizeRoomName(roomName);
  if (!name) return null;
  if (!roomDirectory.has(name)) {
    roomDirectory.set(name, {
      name,
      ownerPassword: null,
      public: true,
      live: false,
      viewers: 0,
      title: null
    });
  }
  return roomDirectory.get(name);
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

// Broadcast the latest room state to everyone in the room.
function broadcastRoomUpdate(roomName) {
  const room = rooms[roomName];
  if (!room) return;

  const users = [];
  for (const [id, u] of room.users.entries()) {
    users.push({
      id,
      name: u.name,
      isViewer: u.isViewer,
      requestingCall: u.requestingCall
    });
  }
  return users;
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

  // ======================================================
  // ROOM JOIN + ROLE ASSIGNMENT
  // ======================================================
  socket.on('join-room', ({ room, name, isViewer }) => {
    if (!room || typeof room !== 'string') {
      socket.emit('room-error', 'Invalid room');
      return;
    }

    const roomName = room.trim().slice(0, 50);
    const rawName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;
    const displayName = rawName.slice(0, 30);

    const info = getRoomInfo(roomName);
    const directoryEntry = getRoomDirectoryEntry(roomName);
    if (directoryEntry && !directoryEntry.title) {
      directoryEntry.title = info.streamTitle;
    }

    if (info.locked && info.ownerId && info.ownerId !== socket.id) {
      socket.emit('room-error', 'Room is locked by host');
      socket.disconnect();
      return;
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.name = displayName;
    socket.data.isViewer = !!isViewer;

    if (!info.ownerId && !isViewer) {
      info.ownerId = socket.id;
    }

    info.users.set(socket.id, {
      name: displayName,
      isViewer: !!isViewer,
      requestingCall: false
    });

    socket.emit('role', {
      isHost: info.ownerId === socket.id,
      streamTitle: info.streamTitle
    });

    socket.to(roomName).emit('user-joined', { id: socket.id, name: displayName });
    broadcastRoomUpdate(roomName);
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
      directoryEntry.title = info.streamTitle;
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
      directoryEntry.viewers = Math.max(0, directoryEntry.viewers - 1);
    }

    if (info.ownerId === socket.id) {
      info.ownerId = null;
      if (directoryEntry) {
        directoryEntry.live = false;
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
