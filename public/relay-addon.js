/**
 * RELAY ADDON - Client Side
 * Only activates when ?relay=true is in URL
 * Completely separate from existing viewer logic
 */

(function() {
  'use strict';

  // Check if relay mode is enabled
  const params = new URLSearchParams(window.location.search);
  if (params.get('relay') !== 'true') {
    console.log('[Relay] Not enabled. Add ?relay=true to URL to activate.');
    return; // Exit immediately if not relay mode
  }

  console.log('[Relay] Mode ENABLED');

  class RelayViewer {
    constructor(socket, getRtcConfig) {
      this.socket = socket;
      this.getRtcConfig = getRtcConfig;
      this.parentPc = null;
      this.incomingStream = null;
      this.childPeers = new Map();
      this.childDataChannels = new Map();
      this.parentId = null;
      this.tier = null;
      this.capacity = 0;
      this.init();
    }

    init() {
      this.socket.on('parent-assigned', (data) => {
        this.parentId = data.parentId;
        this.tier = data.tier;
        this.capacity = data.capacity;
        this.connectToParent();
        console.log(`[Relay] Assigned to parent ${this.parentId} (Tier ${this.tier})`);
      });

      this.socket.on('child-connecting', (data) => {
        this.acceptChild(data.childId);
      });

      this.socket.on('parent-changed', (data) => {
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
    }

    detectDeviceCapabilities() {
      const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent);
      const conn = navigator.connection || {};
      return {
        isMobile,
        connection: conn.effectiveType || 'unknown',
        bandwidth: conn.downlink ? conn.downlink * 1000 : null
      };
    }

    async connectToParent() {
      this.parentPc = new RTCPeerConnection(this.getRtcConfig());

      this.parentPc.ontrack = (event) => {
        console.log('[Relay] Received stream from parent');
        this.incomingStream = event.streams[0];
        const video = document.getElementById('viewerVideo');
        if (video) video.srcObject = this.incomingStream;
        this.forwardToChildren();
      };

      this.parentPc.onicecandidate = (e) => {
        if (e.candidate) {
          this.socket.emit('relay-ice', {
            to: this.parentId,
            candidate: e.candidate,
            forParent: true
          });
        }
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
        console.error('[Relay] Error:', err);
      }
    }

    async acceptChild(childId) {
      console.log('[Relay] Accepting child:', childId);
      const pc = new RTCPeerConnection(this.getRtcConfig());
      this.childPeers.set(childId, pc);

      if (this.incomingStream) {
        this.incomingStream.getTracks().forEach(track => {
          pc.addTrack(track, this.incomingStream);
        });
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          this.socket.emit('relay-ice', {
            to: childId,
            candidate: e.candidate,
            forParent: false
          });
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('relay-offer', {
          to: childId,
          offer: pc.localDescription
        });
      } catch (err) {
        console.error('[Relay] Error creating offer:', err);
      }
    }

    async handleChildAnswer(childId, answer) {
      const pc = this.childPeers.get(childId);
      if (pc) {
        await pc.setRemoteDescription(answer);
      }
    }

    handleIce(from, candidate, forParent) {
      const pc = forParent ? this.parentPc : this.childPeers.get(from);
      if (pc && candidate) {
        pc.addIceCandidate(candidate).catch(console.error);
      }
    }

    forwardToChildren() {
      if (!this.incomingStream) return;
      this.childPeers.forEach((pc) => {
        const senders = pc.getSenders();
        this.incomingStream.getTracks().forEach(track => {
          const exists = senders.find(s => s.track?.id === track.id);
          if (!exists) pc.addTrack(track, this.incomingStream);
        });
      });
    }

    async handleParentChange(newParentId) {
      console.log('[Relay] Parent changed to:', newParentId);
      if (this.parentPc) this.parentPc.close();
      this.parentId = newParentId;
      await this.connectToParent();
    }

    joinRoom(roomName, viewerName) {
      const deviceInfo = this.detectDeviceCapabilities();
      this.socket.emit('join-room-relay', {
        room: roomName,
        name: viewerName,
        deviceInfo
      });
      console.log('[Relay] Joining:', roomName, 'as', viewerName);
    }
  }

  // Initialize relay viewer when join button is clicked
  window.addEventListener('DOMContentLoaded', () => {
    const joinBtn = document.getElementById('joinRoomBtn');
    if (!joinBtn) return;

    // Override join button to use relay mode
    const originalOnClick = joinBtn.onclick;
    joinBtn.onclick = function(e) {
      e.preventDefault();
      
      const roomName = params.get('room');
      const viewerName = document.getElementById('viewerNameInput')?.value;
      
      if (!roomName || !viewerName) {
        document.getElementById('joinStatus').textContent = 'Enter your name';
        return;
      }

      // Create relay viewer
      const relay = new RelayViewer(socket, getRtcConfig);
      relay.joinRoom(roomName, viewerName);

      // Hide join panel
      setTimeout(() => {
        document.getElementById('viewerJoinPanel')?.classList.add('hidden');
        const status = document.getElementById('viewerStatus');
        if (status) {
          status.textContent = 'RELAY MODE';
          status.classList.add('live');
        }
      }, 1000);
    };
  });

})();
