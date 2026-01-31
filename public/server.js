/**
 * REBEL STREAM - DECENTRALIZED RELAY SERVER
 * Complete server implementation with tree-based P2P relay network
 */

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve static files
app.use(express.static('public'));
app.use(express.json());

/**
 * TREE MANAGER - Capacity-Based Routing & Self-Healing
 */
class TreeManager {
  constructor() {
    this.trees = new Map(); // roomName -> tree structure
  }

  initializeRoom(roomName, hostSocketId) {
    const tree = {
      host: hostSocketId,
      nodes: new Map(),
      orphans: new Set()
    };
    
    tree.nodes.set(hostSocketId, {
      socketId: hostSocketId,
      type: 'host',
      capacity: 10,
      children: new Set(),
      parent: null,
      tier: 0,
      lastSeen: Date.now()
    });
    
    this.trees.set(roomName, tree);
    console.log(`[Tree] Initialized room: ${roomName}`);
    return tree;
  }

  calculateCapacity(deviceInfo) {
    const { isMobile, connection, bandwidth } = deviceInfo || {};
    
    // Mobile devices: no relay capacity
    if (isMobile) {
      return 0;
    }
    
    // Cellular connections
    if (connection === 'cellular' || connection === '3g' || connection === '2g') {
      return 0;
    }
    
    // High-speed connections
    if (connection === 'ethernet' || (bandwidth && bandwidth > 10000)) {
      return 10;
    }
    
    // Medium-speed (WiFi, 4G)
    if (connection === '4g' || connection === 'wifi') {
      if (bandwidth && bandwidth > 5000) {
        return 5;
      }
      return 2;
    }
    
    // Default for unknown
    return 3;
  }

  findBestParent(roomName) {
    const tree = this.trees.get(roomName);
    if (!tree) return null;

    let bestParent = null;
    let bestScore = -Infinity;

    tree.nodes.forEach((node) => {
      const availableSlots = node.capacity - node.children.size;
      
      // Skip nodes with no capacity
      if (availableSlots <= 0) return;
      
      // Prevent trees from getting too deep (max tier 3)
      if (node.tier >= 3) return;
      
      // Scoring: Prefer lower tiers, then more free slots
      const score = (1000 - node.tier * 100) + (availableSlots * 10);
      
      if (score > bestScore) {
        bestScore = score;
        bestParent = node;
      }
    });

    return bestParent;
  }

  addViewer(roomName, viewerSocketId, deviceInfo) {
    const tree = this.trees.get(roomName);
    if (!tree) {
      console.error(`[Tree] Room not found: ${roomName}`);
      return null;
    }

    const capacity = this.calculateCapacity(deviceInfo);
    const parent = this.findBestParent(roomName);

    if (!parent) {
      console.error(`[Tree] No available parent in ${roomName}`);
      return null;
    }

    const viewerNode = {
      socketId: viewerSocketId,
      type: 'viewer',
      capacity,
      children: new Set(),
      parent: parent.socketId,
      tier: parent.tier + 1,
      lastSeen: Date.now(),
      deviceInfo
    };

    tree.nodes.set(viewerSocketId, viewerNode);
    parent.children.add(viewerSocketId);

    console.log(`[Tree] Added ${viewerSocketId} as child of ${parent.socketId} (Tier ${viewerNode.tier}, Capacity ${capacity})`);

    return {
      parentId: parent.socketId,
      tier: viewerNode.tier,
      capacity
    };
  }

  removeViewer(roomName, viewerSocketId) {
    const tree = this.trees.get(roomName);
    if (!tree) return { orphans: [] };

    const node = tree.nodes.get(viewerSocketId);
    if (!node) return { orphans: [] };

    const orphans = Array.from(node.children);
    
    if (node.parent) {
      const parent = tree.nodes.get(node.parent);
      if (parent) {
        parent.children.delete(viewerSocketId);
      }
    }

    tree.nodes.delete(viewerSocketId);

    console.log(`[Tree] Removed ${viewerSocketId}, orphaned ${orphans.length} children`);

    return {
      orphans,
      parentId: node.parent,
      tier: node.tier
    };
  }

  reassignOrphans(roomName, orphans) {
    const assignments = [];

    orphans.forEach(orphanId => {
      const tree = this.trees.get(roomName);
      if (!tree) return;

      const orphanNode = tree.nodes.get(orphanId);
      if (!orphanNode) return;

      const newParent = this.findBestParent(roomName);
      
      if (newParent) {
        orphanNode.parent = newParent.socketId;
        orphanNode.tier = newParent.tier + 1;
        newParent.children.add(orphanId);

        assignments.push({
          childId: orphanId,
          newParentId: newParent.socketId,
          tier: orphanNode.tier
        });

        console.log(`[Tree] Reassigned ${orphanId} to ${newParent.socketId} (Tier ${orphanNode.tier})`);
      } else {
        console.error(`[Tree] Could not reassign orphan ${orphanId}`);
        tree.orphans.add(orphanId);
      }
    });

    return assignments;
  }

  getTreeStats(roomName) {
    const tree = this.trees.get(roomName);
    if (!tree) return null;

    const stats = {
      totalNodes: tree.nodes.size,
      totalOrphans: tree.orphans.size,
      tiers: {},
      capacityUsage: {},
      avgTier: 0
    };

    let totalTier = 0;

    tree.nodes.forEach((node, socketId) => {
      stats.tiers[node.tier] = (stats.tiers[node.tier] || 0) + 1;
      totalTier += node.tier;

      const usage = node.capacity > 0 
        ? Math.round((node.children.size / node.capacity) * 100) 
        : 0;

      stats.capacityUsage[socketId] = {
        used: node.children.size,
        total: node.capacity,
        percentage: usage,
        tier: node.tier
      };
    });

    stats.avgTier = stats.totalNodes > 0 ? (totalTier / stats.totalNodes).toFixed(2) : 0;

    return stats;
  }

  exportTree(roomName) {
    const tree = this.trees.get(roomName);
    if (!tree) return null;

    const buildNode = (socketId) => {
      const node = tree.nodes.get(socketId);
      if (!node) return null;

      return {
        id: socketId.substring(0, 8),
        type: node.type,
        tier: node.tier,
        capacity: node.capacity,
        childCount: node.children.size,
        children: Array.from(node.children).map(childId => buildNode(childId)).filter(Boolean)
      };
    };

    return buildNode(tree.host);
  }

  destroyRoom(roomName) {
    this.trees.delete(roomName);
    console.log(`[Tree] Destroyed room: ${roomName}`);
  }
}

const treeManager = new TreeManager();

/**
 * ROOM MANAGEMENT
 */
const rooms = new Map(); // roomName -> { host, users, claimed, password, settings }

/**
 * SOCKET.IO EVENT HANDLERS
 */
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // ===== ROOM CREATION & CLAIMING =====
  
  socket.on('claim-room', ({ name, password, privacy }, callback) => {
    if (rooms.has(name)) {
      callback({ ok: false, error: 'Room name already taken' });
      return;
    }

    rooms.set(name, {
      host: socket.id,
      users: new Map(),
      claimed: true,
      password: password,
      isPublic: privacy === 'public',
      settings: {
        streamTitle: '',
        slug: '',
        isPrivate: false,
        allowedGuests: [],
        vipUsers: [],
        vipCodes: [],
        vipRequired: false
      }
    });

    treeManager.initializeRoom(name, socket.id);

    callback({ ok: true });
    console.log(`[Room] Claimed: ${name} by ${socket.id}`);
  });

  socket.on('enter-host-room', ({ roomName, password }, callback) => {
    const room = rooms.get(roomName);
    
    if (!room) {
      // Create unclaimed room
      rooms.set(roomName, {
        host: socket.id,
        users: new Map(),
        claimed: false,
        password: null,
        isPublic: true,
        settings: {
          streamTitle: '',
          slug: '',
          isPrivate: false,
          allowedGuests: [],
          vipUsers: [],
          vipCodes: [],
          vipRequired: false
        }
      });

      treeManager.initializeRoom(roomName, socket.id);

      callback({ ok: true });
      return;
    }

    // Check password for claimed rooms
    if (room.claimed && room.password && room.password !== password) {
      callback({ ok: false, error: 'Incorrect password' });
      return;
    }

    callback({ ok: true });
  });

  // ===== RELAY NETWORK - JOIN ROOM =====
  
  socket.on('join-room-relay', ({ room, name, deviceInfo }) => {
    const roomData = rooms.get(room);
    if (!roomData) {
      socket.emit('error-message', 'Room not found');
      return;
    }

    // Add viewer to tree
    const assignment = treeManager.addViewer(room, socket.id, deviceInfo);
    
    if (!assignment) {
      socket.emit('error-message', 'No available relay slots. Tree may be too deep or full.');
      return;
    }

    // Join socket.io room
    socket.join(room);
    
    roomData.users.set(socket.id, {
      name,
      isViewer: true,
      ...assignment
    });

    // Tell viewer who their parent is
    socket.emit('parent-assigned', {
      parentId: assignment.parentId,
      tier: assignment.tier,
      capacity: assignment.capacity
    });

    // Tell parent to accept this child
    io.to(assignment.parentId).emit('child-connecting', {
      childId: socket.id,
      childName: name
    });

    // Broadcast tree stats
    const stats = treeManager.getTreeStats(room);
    io.to(room).emit('tree-stats', stats);

    console.log(`[Relay] ${socket.id} (${name}) joined ${room} via parent ${assignment.parentId} (Tier ${assignment.tier})`);
  });

  // ===== LEGACY JOIN (for hosts and non-relay guests) =====
  
  socket.on('join-room', ({ room, name, role, password }) => {
    const roomData = rooms.get(room);
    
    if (!roomData) {
      socket.emit('error-message', 'Room not found');
      return;
    }

    // Check if trying to join as host
    const isHost = role === 'host' || socket.id === roomData.host;

    if (isHost && roomData.claimed && roomData.password !== password) {
      socket.emit('error-message', 'Incorrect host password');
      return;
    }

    socket.join(room);
    
    roomData.users.set(socket.id, {
      name,
      isViewer: !isHost,
      isHost: isHost
    });

    socket.emit('join-ack', {
      room,
      ownerId: roomData.host,
      ...roomData.settings,
      users: Array.from(roomData.users.entries()).map(([id, user]) => ({
        id,
        name: user.name,
        isViewer: user.isViewer
      }))
    });

    io.to(room).emit('room-update', {
      ownerId: roomData.host,
      users: Array.from(roomData.users.entries()).map(([id, user]) => ({
        id,
        name: user.name,
        isViewer: user.isViewer
      }))
    });

    console.log(`[Join] ${socket.id} (${name}) joined ${room} as ${isHost ? 'host' : 'guest'}`);
  });

  // ===== RELAY SIGNALING =====
  
  socket.on('relay-offer', ({ to, offer }) => {
    io.to(to).emit('relay-offer', {
      from: socket.id,
      offer
    });
  });

  socket.on('relay-answer', ({ to, answer }) => {
    io.to(to).emit('relay-answer', {
      from: socket.id,
      answer
    });
  });

  socket.on('relay-ice', ({ to, candidate, forParent }) => {
    io.to(to).emit('relay-ice', {
      from: socket.id,
      candidate,
      forParent
    });
  });

  // ===== LEGACY WEBRTC SIGNALING =====
  
  socket.on('webrtc-offer', ({ to, offer }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ===== CALL MODE SIGNALING =====
  
  socket.on('call-offer', ({ to, offer }) => {
    io.to(to).emit('call-offer', { from: socket.id, offer });
  });

  socket.on('call-answer', ({ to, answer }) => {
    io.to(to).emit('call-answer', { from: socket.id, answer });
  });

  socket.on('call-ice', ({ to, candidate }) => {
    io.to(to).emit('call-ice', { from: socket.id, candidate });
  });

  socket.on('ring-user', (targetId) => {
    const user = Array.from(rooms.values())
      .flatMap(room => Array.from(room.users.entries()))
      .find(([id]) => id === socket.id);
    
    io.to(targetId).emit('ring-you', {
      from: socket.id,
      fromName: user ? user[1].name : 'Unknown'
    });
  });

  socket.on('end-call', ({ to }) => {
    io.to(to).emit('end-call', { from: socket.id });
  });

  // ===== CHAT =====
  
  socket.on('public-chat', ({ room, name, text, ts }) => {
    io.to(room).emit('public-chat', { name, text, ts: ts || Date.now() });
  });

  socket.on('private-chat', ({ room, name, text, ts }) => {
    io.to(room).emit('private-chat', { name, text, ts: ts || Date.now() });
  });

  // ===== ROOM SETTINGS =====
  
  socket.on('set-stream-title', ({ title }, callback) => {
    rooms.forEach((roomData, roomName) => {
      if (roomData.host === socket.id) {
        roomData.settings.streamTitle = title;
        if (callback) callback({ ok: true });
      }
    });
  });

  socket.on('set-slug', ({ slug }, callback) => {
    rooms.forEach((roomData, roomName) => {
      if (roomData.host === socket.id) {
        roomData.settings.slug = slug;
        if (callback) callback({ ok: true });
      }
    });
  });

  socket.on('set-public-room', ({ isPublic }, callback) => {
    rooms.forEach((roomData, roomName) => {
      if (roomData.host === socket.id) {
        roomData.isPublic = isPublic;
        if (callback) callback({ ok: true });
      }
    });
  });

  // ===== VIP SYSTEM =====
  
  socket.on('add-vip-user', ({ userName }, callback) => {
    rooms.forEach((roomData, roomName) => {
      if (roomData.host === socket.id) {
        if (!roomData.settings.vipUsers.includes(userName)) {
          roomData.settings.vipUsers.push(userName);
        }
        if (callback) callback({ ok: true });
      }
    });
  });

  socket.on('generate-vip-code', ({ uses }, callback) => {
    rooms.forEach((roomData, roomName) => {
      if (roomData.host === socket.id) {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        roomData.settings.vipCodes.push({ code, uses: uses || 1 });
        if (callback) callback({ ok: true, code });
      }
    });
  });

  // ===== PUBLIC ROOMS LIST =====
  
  socket.on('get-public-rooms', () => {
    const publicRooms = Array.from(rooms.entries())
      .filter(([name, data]) => data.isPublic)
      .map(([name, data]) => ({
        name,
        title: data.settings.streamTitle || name,
        viewers: data.users.size,
        slug: data.settings.slug
      }));
    
    socket.emit('public-rooms', publicRooms);
  });

  // ===== TREE VISUALIZATION =====
  
  socket.on('get-tree-structure', ({ room }) => {
    const tree = treeManager.exportTree(room);
    const stats = treeManager.getTreeStats(room);
    socket.emit('tree-structure', { tree, stats });
  });

  // ===== DISCONNECT HANDLING =====
  
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);

    rooms.forEach((roomData, roomName) => {
      if (roomData.users.has(socket.id)) {
        // Remove from tree and get orphans
        const { orphans } = treeManager.removeViewer(roomName, socket.id);
        
        // Reassign orphans to new parents
        if (orphans.length > 0) {
          const assignments = treeManager.reassignOrphans(roomName, orphans);
          
          assignments.forEach(({ childId, newParentId, tier }) => {
            // Tell orphan about new parent
            io.to(childId).emit('parent-changed', {
              newParentId,
              tier
            });
            
            // Tell new parent to accept child
            io.to(newParentId).emit('child-connecting', {
              childId
            });
          });

          console.log(`[Relay] Reassigned ${assignments.length} orphans after ${socket.id} disconnect`);
        }

        // Remove from room users
        roomData.users.delete(socket.id);

        // If host disconnected, destroy room
        if (socket.id === roomData.host) {
          console.log(`[Room] Host disconnected, destroying room: ${roomName}`);
          treeManager.destroyRoom(roomName);
          rooms.delete(roomName);
          io.to(roomName).emit('host-disconnected');
        } else {
          // Broadcast updated user list
          io.to(roomName).emit('room-update', {
            ownerId: roomData.host,
            users: Array.from(roomData.users.entries()).map(([id, user]) => ({
              id,
              name: user.name,
              isViewer: user.isViewer
            }))
          });

          // Broadcast tree stats
          const stats = treeManager.getTreeStats(roomName);
          if (stats) {
            io.to(roomName).emit('tree-stats', stats);
          }
        }
      }
    });
  });

  socket.on('leave-room', () => {
    rooms.forEach((roomData, roomName) => {
      if (roomData.users.has(socket.id)) {
        roomData.users.delete(socket.id);
        socket.leave(roomName);
        
        const { orphans } = treeManager.removeViewer(roomName, socket.id);
        
        if (orphans.length > 0) {
          const assignments = treeManager.reassignOrphans(roomName, orphans);
          assignments.forEach(({ childId, newParentId }) => {
            io.to(childId).emit('parent-changed', { newParentId });
            io.to(newParentId).emit('child-connecting', { childId });
          });
        }
      }
    });
  });
});

/**
 * HTTP ROUTES
 */
app.get('/api/rooms', (req, res) => {
  const publicRooms = Array.from(rooms.entries())
    .filter(([name, data]) => data.isPublic)
    .map(([name, data]) => ({
      name,
      title: data.settings.streamTitle || name,
      viewers: data.users.size,
      slug: data.settings.slug
    }));
  
  res.json({ rooms: publicRooms });
});

app.get('/api/tree/:room', (req, res) => {
  const tree = treeManager.exportTree(req.params.room);
  const stats = treeManager.getTreeStats(req.params.room);
  res.json({ tree, stats });
});

/**
 * START SERVER
 */
const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║   REBEL STREAM - DECENTRALIZED RELAY SERVER   ║
║   Running on port ${PORT}                        ║
║   Mode: Tree-Based P2P Relay Network          ║
╚═══════════════════════════════════════════════╝
  `);
});

module.exports = { app, io, treeManager };
