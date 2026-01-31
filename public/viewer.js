/**
 * RELAY VIEWER - Complete Implementation
 * Receives stream from parent, forwards to children, relays data channels
 */

class RelayViewer {
  constructor(socket, getRtcConfig) {
    this.socket = socket;
    this.getRtcConfig = getRtcConfig;
    
    // Parent connection
    this.parentPc = null;
    this.incomingStream = null;
    
    // Child connections
    this.childPeers = new Map();
    
    // Data channels
    this.parentDataChannel = null;
    this.childDataChannels = new Map();
    
    // File relay state
    this.relayBuffer = {
      meta: null,
      chunks: [],
      receivedSize: 0
    };
    
    // Status
    this.mySocketId = null;
    this.parentId = null;
    this.tier = null;
    this.capacity = 0;
    
    // Callbacks
    this.onStatusUpdate = null;
    
    this.init();
  }

  init() {
    this.socket.on('connect', () => {
      this.mySocketId = this.socket.id;
      console.log('[Relay] Connected:', this.mySocketId);
    });

    this.socket.on('parent-assigned', (data) => {
      console.log('[Relay] Parent assigned:', data);
      this.parentId = data.parentId;
      this.tier = data.tier;
      this.capacity = data.capacity;
      this.connectToParent();
      this.updateStatus();
    });

    this.socket.on('child-connecting', (data) => {
      console.log('[Relay] Child connecting:', data.childId);
      this.acceptChild(data.childId);
    });

    this.socket.on('parent-changed', (data) => {
      console.log('[Relay] Parent changed to:', data.newParentId);
      this.handleParentChange(data.newParentId);
    });

    this.socket.on('relay-offer', async (data) => {
      if (data.from === this.parentId) {
        await this.handleParentOffer(data.offer);
      }
    });

    this.socket.on('relay-answer', async (data) => {
      await this.handleChildAnswer(data.from, data.answer);
    });

    this.socket.on('relay-ice', (data) => {
      this.handleIce(data.from, data.candidate, data.forParent);
    });

    this.socket.on('child-disconnected', (data) => {
      this.removeChild(data.childId);
    });
  }

  detectDeviceCapabilities() {
    const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
    
    return {
      isMobile,
      connection: conn.effectiveType || 'unknown',
      bandwidth: conn.downlink ? conn.downlink * 1000 : null
    };
  }

  async connectToParent() {
    console.log('[Relay] Connecting to parent:', this.parentId);
    this.parentPc = new RTCPeerConnection(this.getRtcConfig());

    this.parentPc.ontrack = (event) => {
      console.log('[Relay] Received track from parent:', event.track.kind);
      this.incomingStream = event.streams[0];
      
      // Display locally
      const video = document.getElementById('viewerVideo');
      if (video) {
        video.srcObject = this.incomingStream;
      }
      
      // Forward to children
      this.forwardToChildren();
      this.updateStatus();
    };

    this.parentPc.ondatachannel = (event) => {
      if (event.channel.label === 'relay-data') {
        this.parentDataChannel = event.channel;
        this.setupParentDataChannel();
      }
    });

    this.parentPc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('relay-ice', {
          to: this.parentId,
          candidate: e.candidate,
          forParent: true
        });
      }
    };

    this.parentPc.onconnectionstatechange = () => {
      console.log('[Relay] Parent connection state:', this.parentPc.connectionState);
      this.updateStatus();
    };
  }

  async handleParentOffer(offer) {
    try {
      await this.parentPc.setRemoteDescription(offer);
      const answer = await this.parentPc.createAnswer();
      await this.parentPc.setLocalDescription(answer);
      
      this.socket.emit('relay-answer', {
        to: this.parentId,
        answer: this.parentPc.localDescription
      });

      console.log('[Relay] Sent answer to parent');
    } catch (err) {
      console.error('[Relay] Error handling parent offer:', err);
    }
  }

  async acceptChild(childId) {
    if (this.childPeers.has(childId)) {
      console.warn('[Relay] Child already exists:', childId);
      return;
    }

    console.log('[Relay] Accepting child:', childId);
    const pc = new RTCPeerConnection(this.getRtcConfig());
    this.childPeers.set(childId, pc);

    // Forward stream
    if (this.incomingStream) {
      this.incomingStream.getTracks().forEach(track => {
        pc.addTrack(track, this.incomingStream);
        console.log('[Relay] Added track to child:', track.kind);
      });
    }

    // Create data channel
    const dc = pc.createDataChannel('relay-data');
    this.childDataChannels.set(childId, dc);
    this.setupChildDataChannel(dc, childId);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('relay-ice', {
          to: childId,
          candidate: e.candidate,
          forParent: false
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[Relay] Child', childId, 'state:', pc.connectionState);
      this.updateStatus();
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      this.socket.emit('relay-offer', {
        to: childId,
        offer: pc.localDescription
      });

      this.updateStatus();
    } catch (err) {
      console.error('[Relay] Error creating offer for child:', err);
      this.childPeers.delete(childId);
    }
  }

  async handleChildAnswer(childId, answer) {
    const pc = this.childPeers.get(childId);
    if (pc) {
      try {
        await pc.setRemoteDescription(answer);
        console.log('[Relay] Set remote description for child:', childId);
      } catch (err) {
        console.error('[Relay] Error setting remote description:', err);
      }
    }
  }

  handleIce(from, candidate, forParent) {
    const pc = forParent ? this.parentPc : this.childPeers.get(from);
    if (pc && candidate) {
      pc.addIceCandidate(candidate).catch(err => {
        console.error('[Relay] ICE error:', err);
      });
    }
  }

  forwardToChildren() {
    if (!this.incomingStream) return;

    this.childPeers.forEach((pc, childId) => {
      const senders = pc.getSenders();
      
      this.incomingStream.getTracks().forEach(track => {
        const exists = senders.find(s => s.track?.id === track.id);
        if (!exists) {
          pc.addTrack(track, this.incomingStream);
          console.log('[Relay] Forwarded track to child:', childId, track.kind);
        }
      });
    });
  }

  setupParentDataChannel() {
    console.log('[Relay] Parent data channel established');

    this.parentDataChannel.onmessage = (event) => {
      const data = event.data;

      // Metadata
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'meta') {
            this.relayBuffer.meta = parsed;
            this.broadcastToChildren(data);
            console.log('[Relay] File incoming:', parsed.name);
            return;
          }
        } catch (e) {}
      }

      // Binary chunk - relay immediately
      if (data instanceof ArrayBuffer) {
        this.relayBuffer.chunks.push(data);
        this.relayBuffer.receivedSize += data.byteLength;
        
        // Forward to children without waiting
        this.broadcastToChildren(data);

        // Check if complete
        if (this.relayBuffer.meta && 
            this.relayBuffer.receivedSize >= this.relayBuffer.meta.size) {
          this.assembleFile();
        }
      }
    };

    this.parentDataChannel.onclose = () => {
      console.log('[Relay] Parent data channel closed');
    };
  }

  setupChildDataChannel(dc, childId) {
    dc.onopen = () => {
      console.log('[Relay] Data channel opened for child:', childId);
    };

    dc.onclose = () => {
      console.log('[Relay] Data channel closed for child:', childId);
      this.childDataChannels.delete(childId);
    };

    dc.onerror = (err) => {
      console.error('[Relay] Data channel error for child:', childId, err);
    };
  }

  broadcastToChildren(data) {
    this.childDataChannels.forEach((dc, childId) => {
      if (dc.readyState === 'open') {
        try {
          dc.send(data);
        } catch (err) {
          console.error('[Relay] Error sending to child:', childId, err);
        }
      }
    });
  }

  assembleFile() {
    const blob = new Blob(this.relayBuffer.chunks, { 
      type: this.relayBuffer.meta.mime 
    });
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.relayBuffer.meta.name;
    a.click();
    
    URL.revokeObjectURL(url);
    
    console.log('[Relay] File assembled:', this.relayBuffer.meta.name);
    
    // Reset buffer
    this.relayBuffer = { meta: null, chunks: [], receivedSize: 0 };
  }

  async handleParentChange(newParentId) {
    console.log('[Relay] Changing parent from', this.parentId, 'to', newParentId);
    
    if (this.parentPc) {
      this.parentPc.close();
      this.parentPc = null;
    }

    this.parentId = newParentId;
    this.incomingStream = null;
    
    await this.connectToParent();
    this.updateStatus();
  }

  removeChild(childId) {
    const pc = this.childPeers.get(childId);
    if (pc) {
      pc.close();
      this.childPeers.delete(childId);
      this.childDataChannels.delete(childId);
      console.log('[Relay] Removed child:', childId);
      this.updateStatus();
    }
  }

  joinRoom(roomName, viewerName) {
    const deviceInfo = this.detectDeviceCapabilities();
    
    console.log('[Relay] Joining room:', roomName, 'with device info:', deviceInfo);
    
    this.socket.emit('join-room-relay', {
      room: roomName,
      name: viewerName,
      deviceInfo
    });
  }

  getStatus() {
    return {
      socketId: this.mySocketId,
      parentId: this.parentId,
      tier: this.tier,
      capacity: this.capacity,
      childCount: this.childPeers.size,
      hasStream: !!this.incomingStream,
      parentConnected: this.parentPc?.connectionState === 'connected'
    };
  }

  updateStatus() {
    const status = this.getStatus();
    
    if (this.onStatusUpdate) {
      this.onStatusUpdate(status);
    }
  }

  destroy() {
    if (this.parentPc) {
      this.parentPc.close();
    }

    this.childPeers.forEach(pc => pc.close());
    this.childPeers.clear();
    this.childDataChannels.clear();
  }
}

window.RelayViewer = RelayViewer;
