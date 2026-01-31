/**
 * SERVER RELAY EVENTS - Add-On Module for YOUR Server
 * Adds relay network without breaking existing functionality
 * 
 * Usage: Add this ONE line inside io.on('connection', (socket) => { ... }):
 * require('./server-relay-events')(io, socket, treeManager, rooms, roomDirectory);
 */

module.exports = function(io, socket, treeManager, rooms, roomDirectory) {
  
  // Relay network - viewer joins via tree
  socket.on('join-room-relay', ({ room, name, deviceInfo }) => {
    const roomName = room;
    console.log(`[Relay] Join request: ${name} -> ${roomName}`);
    
    // Check if room exists
    const info = rooms[roomName];
    if (!info) {
      socket.emit('error-message', 'Room not found');
      return;
    }

    // Initialize tree if not already done (when first relay viewer joins)
    if (!treeManager.trees.has(roomName)) {
      const hostId = info.ownerId;
      if (hostId) {
        treeManager.initializeRoom(roomName, hostId);
        console.log(`[Relay] Initialized tree for ${roomName} with host ${hostId}`);
      } else {
        socket.emit('error-message', 'Host not found');
        return;
      }
    }

    // Add viewer to tree
    const assignment = treeManager.addViewer(roomName, socket.id, deviceInfo);
    
    if (!assignment) {
      socket.emit('error-message', 'No available relay slots. Try again later.');
      return;
    }

    // Join socket.io room
    socket.join(roomName);
    
    // Store in room state
    info.users.set(socket.id, {
      name,
      isViewer: true,
      isRelay: true,
      tier: assignment.tier,
      capacity: assignment.capacity
    });

    // Update socket data
    socket.data.room = roomName;
    socket.data.name = name;
    socket.data.isViewer = true;
    socket.data.isRelay = true;

    // Update viewer count in directory
    const directoryEntry = roomDirectory.rooms[roomName];
    if (directoryEntry) {
      directoryEntry.viewers = (directoryEntry.viewers || 0) + 1;
    }

    // Tell viewer their parent assignment
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

    console.log(`[Relay] ${socket.id} (${name}) -> parent: ${assignment.parentId} (Tier ${assignment.tier})`);

    // Broadcast user joined
    socket.to(roomName).emit('user-joined', {
      id: socket.id,
      name
    });
  });

  // Relay WebRTC signaling
  socket.on('relay-offer', ({ to, offer }) => {
    io.to(to).emit('relay-offer', { from: socket.id, offer });
  });

  socket.on('relay-answer', ({ to, answer }) => {
    io.to(to).emit('relay-answer', { from: socket.id, answer });
  });

  socket.on('relay-ice', ({ to, candidate, forParent }) => {
    io.to(to).emit('relay-ice', { 
      from: socket.id, 
      candidate, 
      forParent 
    });
  });

  // Intercept disconnect to handle relay cleanup
  const originalListeners = socket.listeners('disconnect');
  
  // Remove existing disconnect listeners temporarily
  socket.removeAllListeners('disconnect');
  
  // Add our relay cleanup, then restore original listeners
  socket.on('disconnect', () => {
    // Handle relay cleanup first
    if (socket.data.isRelay && socket.data.room) {
      const roomName = socket.data.room;
      
      // Remove from tree and get orphans
      const { orphans } = treeManager.removeViewer(roomName, socket.id);
      
      if (orphans.length > 0) {
        // Reassign orphans to new parents
        const assignments = treeManager.reassignOrphans(roomName, orphans);
        
        assignments.forEach(({ childId, newParentId }) => {
          // Tell orphan about new parent
          io.to(childId).emit('parent-changed', { 
            newParentId 
          });
          
          // Tell new parent to accept child
          io.to(newParentId).emit('child-connecting', { 
            childId 
          });
        });

        console.log(`[Relay] Reassigned ${assignments.length} orphans after ${socket.id} disconnect`);
      }

      // Update viewer count
      const directoryEntry = roomDirectory.rooms[roomName];
      if (directoryEntry) {
        directoryEntry.viewers = Math.max(0, (directoryEntry.viewers || 0) - 1);
      }
    }

    // Call original disconnect handlers
    originalListeners.forEach(listener => listener.call(socket));
  });
};
