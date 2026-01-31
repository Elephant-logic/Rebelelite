/**
 * STATE MANAGER MODULE
 * Centralized state management with validation and change notifications
 */

class StateManager {
  constructor() {
    this.state = {
      // Connection
      currentRoom: null,
      userName: 'User',
      myId: null,
      joined: false,
      
      // Roles
      iAmHost: false,
      wasHost: false,
      currentOwnerId: null,
      
      // Users
      latestUserList: [],
      mutedUsers: new Set(),
      
      // Privacy & VIP
      isPrivateMode: false,
      allowedGuests: [],
      vipUsers: [],
      vipCodes: [],
      vipRequired: false,
      
      // Media
      localStream: null,
      screenStream: null,
      isScreenSharing: false,
      isStreaming: false,
      
      // Mixer
      mixerLayout: 'SOLO',
      activeGuestId: null,
      audioContext: null,
      audioDestination: null,
      audioAnalysers: {},
      
      // Overlay
      overlayActive: false,
      overlayImage: new Image(),
      currentRawHTML: '',
      overlayFields: [],
      overlayFieldValues: {},
      overlayObjectUrls: {},
      overlayContainer: null,
      overlayVideoElements: [],
      overlayRenderCount: 0,
      
      // Files
      activeToolboxFile: null,
      
      // Config
      turnConfig: {
        enabled: false,
        host: '',
        port: '',
        tlsPort: '',
        username: '',
        password: ''
      }
    };
    
    this.listeners = {};
  }
  
  /**
   * Get a state value
   */
  get(key) {
    return this.state[key];
  }
  
  /**
   * Set a state value and notify listeners
   */
  set(key, value) {
    const oldValue = this.state[key];
    this.state[key] = value;
    this.notify(key, value, oldValue);
  }
  
  /**
   * Update multiple state values at once
   */
  update(updates) {
    Object.keys(updates).forEach(key => {
      this.set(key, updates[key]);
    });
  }
  
  /**
   * Subscribe to state changes
   */
  subscribe(key, callback) {
    if (!this.listeners[key]) {
      this.listeners[key] = [];
    }
    this.listeners[key].push(callback);
    
    // Return unsubscribe function
    return () => {
      this.listeners[key] = this.listeners[key].filter(cb => cb !== callback);
    };
  }
  
  /**
   * Notify listeners of state change
   */
  notify(key, newValue, oldValue) {
    if (this.listeners[key]) {
      this.listeners[key].forEach(callback => {
        callback(newValue, oldValue);
      });
    }
  }
  
  /**
   * Reset state to initial values
   */
  reset() {
    this.state.joined = false;
    this.state.iAmHost = false;
    this.state.currentRoom = null;
    this.state.latestUserList = [];
    this.state.mutedUsers = new Set();
    this.notify('reset', true, false);
  }
}

// Export singleton instance
window.stateManager = new StateManager();
