const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 9100;

const app = express();
const server = http.createServer(app);

// FIX: Increased buffer to 50MB for large arcade transfers
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e7, 
  pingTimeout: 10000,     
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state
const rooms = Object.create(null);

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

  io.to(roomName).emit('room-update', {
    users,
    ownerId: room.ownerId,
    locked: room.locked,
    streamTitle: room.streamTitle
  });
}

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.name = null;

  socket.on('join-room', ({ room, name, isViewer }) => {
    if (!room || typeof room !== 'string') {
      socket.emit('room-error', 'Invalid room');
      return;
    }

    const roomName = room.trim().slice(0, 50); 
    const rawName = (name && String(name).trim()) || `User-${socket.id.slice(0, 4)}`;
    const displayName = rawName.slice(0, 30); 

    const info = getRoomInfo(roomName);

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

  socket.on('request-to-call', () => {
    const roomName = socket.data.room;
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
    const roomName = socket.data.room;
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
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;
    info.locked = !!locked;
    broadcastRoomUpdate(roomName);
  });

  socket.on('update-stream-title', (title) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;
    info.streamTitle = (title || 'Untitled Stream').slice(0, 100);
    broadcastRoomUpdate(roomName);
  });

  socket.on('kick-user', (targetId) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const info = rooms[roomName];
    if (!info || info.ownerId !== socket.id) return;

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
    if (targetId && sdp) io.to(targetId).emit('webrtc-offer', { sdp, from: socket.id });
  });
  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    if (targetId && sdp) io.to(targetId).emit('webrtc-answer', { sdp, from: socket.id });
  });
  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) io.to(targetId).emit('webrtc-ice-candidate', { candidate, from: socket.id });
  });

  socket.on('ring-user', (targetId) => {
    if (targetId) io.to(targetId).emit('ring-alert', { from: socket.data.name, fromId: socket.id });
  });
  socket.on('call-offer', ({ targetId, offer }) => {
    if (targetId && offer) io.to(targetId).emit('incoming-call', { from: socket.id, name: socket.data.name, offer });
  });
  socket.on('call-answer', ({ targetId, answer }) => {
    if (targetId && answer) io.to(targetId).emit('call-answer', { from: socket.id, answer });
  });
  socket.on('call-ice', ({ targetId, candidate }) => {
    if (targetId && candidate) io.to(targetId).emit('call-ice', { from: socket.id, candidate });
  });
  socket.on('call-end', ({ targetId }) => {
    if (targetId) io.to(targetId).emit('call-end', { from: socket.id });
  });

  socket.on('public-chat', ({ room, name, text, fromViewer }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !text) return;
    const info = rooms[roomName];
    io.to(roomName).emit('public-chat', {
      name: (name || socket.data.name || 'Anon').slice(0,30),
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
      name: (name || socket.data.name || 'Anon').slice(0,30),
      text: String(text).slice(0, 500),
      ts: Date.now()
    });
  });

  socket.on('file-share', ({ room, name, fileName, fileType, fileData }) => {
    const roomName = room || socket.data.room;
    if (!roomName || !fileName || !fileData) return;
    io.to(roomName).emit('file-share', {
      name: (name || socket.data.name).slice(0,30),
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

    if (info.ownerId === socket.id) {
      info.ownerId = null;
    }

    socket.to(roomName).emit('user-left', { id: socket.id });
    if (info.users.size === 0) delete rooms[roomName];
    else broadcastRoomUpdate(roomName);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rebel Secure Server running on ${PORT}`);
});
