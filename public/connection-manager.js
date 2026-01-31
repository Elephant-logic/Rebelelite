/**
 * CONNECTION MANAGER MODULE
 * Handles WebSocket and WebRTC reconnection logic with exponential backoff
 */

class ConnectionManager {
  constructor(socket) {
    this.socket = socket;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000; // Start with 1 second
    this.maxReconnectDelay = 30000; // Max 30 seconds
    this.reconnectTimer = null;
    this.isReconnecting = false;
    
    this.peerConnections = new Map(); // Track all peer connections
    this.reconnectionCallbacks = [];
    
    this.init();
  }
  
  /**
   * Initialize connection monitoring
   */
  init() {
    // Monitor socket connection
    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      
      if (reason === 'io server disconnect') {
        // Server initiated disconnect - don't auto-reconnect
        window.errorHandler.showError(
          'Disconnected by server. Please refresh to reconnect.',
          'error',
          0
        );
      } else {
        // Network issue - auto-reconnect
        this.handleSocketDisconnect();
      }
    });
    
    this.socket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error);
      this.handleSocketDisconnect();
    });
    
    this.socket.on('reconnect', (attemptNumber) => {
      console.log('[Socket] Reconnected after', attemptNumber, 'attempts');
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      window.errorHandler.showSuccess('Reconnected successfully!');
      
      // Trigger callbacks
      this.reconnectionCallbacks.forEach(cb => cb());
    });
    
    this.socket.on('reconnect_attempt', (attemptNumber) => {
      console.log('[Socket] Reconnect attempt', attemptNumber);
    });
    
    this.socket.on('reconnect_failed', () => {
      console.error('[Socket] Reconnection failed');
      window.errorHandler.showError(
        'Unable to reconnect. Please refresh the page.',
        'error',
        0,
        [
          {
            label: 'Refresh',
            callback: () => window.location.reload()
          }
        ]
      );
    });
  }
  
  /**
   * Handle socket disconnection
   */
  handleSocketDisconnect() {
    if (this.isReconnecting) return;
    
    this.isReconnecting = true;
    this.reconnectAttempts = 0;
    
    window.errorHandler.showWarning(
      'Connection lost. Reconnecting...',
      0
    );
    
    this.attemptSocketReconnect();
  }
  
  /**
   * Attempt to reconnect socket with exponential backoff
   */
  attemptSocketReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.isReconnecting = false;
      window.errorHandler.showError(
        'Failed to reconnect after multiple attempts.',
        'error',
        0,
        [
          {
            label: 'Refresh Page',
            callback: () => window.location.reload()
          },
          {
            label: 'Keep Trying',
            callback: () => {
              this.reconnectAttempts = 0;
              this.attemptSocketReconnect();
            }
          }
        ]
      );
      return;
    }
    
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    
    console.log(`[Socket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      
      if (!this.socket.connected) {
        this.socket.connect();
      }
      
      // Check if connected after attempt
      setTimeout(() => {
        if (!this.socket.connected) {
          this.attemptSocketReconnect();
        } else {
          this.isReconnecting = false;
          this.reconnectAttempts = 0;
        }
      }, 1000);
    }, delay);
  }
  
  /**
   * Register a peer connection for monitoring
   */
  registerPeerConnection(id, pc, type = 'viewer') {
    this.peerConnections.set(id, { pc, type, reconnectAttempts: 0 });
    
    // Monitor connection state
    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] ${id} connection state:`, pc.connectionState);
      
      if (pc.connectionState === 'failed') {
        this.handlePeerConnectionFailure(id);
      } else if (pc.connectionState === 'disconnected') {
        // Wait a bit before considering it failed
        setTimeout(() => {
          if (pc.connectionState === 'disconnected') {
            this.handlePeerConnectionFailure(id);
          }
        }, 5000);
      } else if (pc.connectionState === 'connected') {
        const conn = this.peerConnections.get(id);
        if (conn && conn.reconnectAttempts > 0) {
          window.errorHandler.showSuccess(`Reconnected to ${type}: ${id}`);
          conn.reconnectAttempts = 0;
        }
      }
    };
    
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ${id} ICE state:`, pc.iceConnectionState);
    };
  }
  
  /**
   * Handle peer connection failure
   */
  handlePeerConnectionFailure(id) {
    const conn = this.peerConnections.get(id);
    if (!conn) return;
    
    console.error(`[WebRTC] Connection failed for ${id}`);
    
    // Auto-retry for viewers, ask host for call peers
    if (conn.type === 'viewer') {
      this.retryPeerConnection(id);
    } else {
      window.errorHandler.showError(
        `Connection to ${id} failed.`,
        'error',
        0,
        [
          {
            label: 'Retry',
            callback: () => this.retryPeerConnection(id)
          },
          {
            label: 'Ignore',
            callback: () => this.removePeerConnection(id)
          }
        ]
      );
    }
  }
  
  /**
   * Retry peer connection
   */
  async retryPeerConnection(id) {
    const conn = this.peerConnections.get(id);
    if (!conn) return;
    
    if (conn.reconnectAttempts >= 3) {
      window.errorHandler.showError(
        `Failed to reconnect to ${id} after 3 attempts.`,
        'error',
        5000
      );
      this.removePeerConnection(id);
      return;
    }
    
    conn.reconnectAttempts++;
    console.log(`[WebRTC] Retrying connection to ${id} (attempt ${conn.reconnectAttempts})`);
    
    // Close old connection
    conn.pc.close();
    
    // Trigger new connection based on type
    if (conn.type === 'viewer' && window.createViewerPeer) {
      await window.createViewerPeer(id);
    } else if (conn.type === 'call' && window.ringUser) {
      window.ringUser(id);
    }
  }
  
  /**
   * Remove peer connection
   */
  removePeerConnection(id) {
    const conn = this.peerConnections.get(id);
    if (conn) {
      conn.pc.close();
      this.peerConnections.delete(id);
    }
  }
  
  /**
   * Add callback to run after reconnection
   */
  onReconnect(callback) {
    this.reconnectionCallbacks.push(callback);
  }
  
  /**
   * Check network status
   */
  checkNetworkStatus() {
    if (!navigator.onLine) {
      window.errorHandler.showError(
        'No internet connection detected.',
        'error',
        0
      );
      return false;
    }
    return true;
  }
  
  /**
   * Clean up
   */
  destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.peerConnections.forEach((conn) => {
      conn.pc.close();
    });
    this.peerConnections.clear();
  }
}

// Export factory function
window.createConnectionManager = (socket) => new ConnectionManager(socket);
