/**
 * ERROR HANDLER MODULE
 * Centralized error handling with user-friendly messages and auto-recovery
 */

class ErrorHandler {
  constructor() {
    this.errorContainer = null;
    this.init();
  }
  
  /**
   * Initialize error display container
   */
  init() {
    // Create error notification container if it doesn't exist
    if (!document.getElementById('errorNotifications')) {
      const container = document.createElement('div');
      container.id = 'errorNotifications';
      container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10000;
        max-width: 400px;
      `;
      document.body.appendChild(container);
      this.errorContainer = container;
    }
  }
  
  /**
   * Show error notification to user
   */
  showError(message, type = 'error', duration = 5000, actions = []) {
    const notification = document.createElement('div');
    notification.className = `error-notification error-${type}`;
    notification.style.cssText = `
      background: ${type === 'error' ? '#ff4b6a' : type === 'warning' ? '#ffb84d' : '#4af3a3'};
      color: ${type === 'success' ? '#000' : '#fff'};
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: slideIn 0.3s ease-out;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;
    
    const messageEl = document.createElement('div');
    messageEl.textContent = message;
    messageEl.style.fontWeight = '600';
    notification.appendChild(messageEl);
    
    // Add action buttons if provided
    if (actions.length > 0) {
      const actionsContainer = document.createElement('div');
      actionsContainer.style.cssText = 'display: flex; gap: 8px;';
      
      actions.forEach(action => {
        const btn = document.createElement('button');
        btn.textContent = action.label;
        btn.style.cssText = `
          background: rgba(255,255,255,0.2);
          border: 1px solid rgba(255,255,255,0.3);
          color: inherit;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 600;
        `;
        btn.onclick = () => {
          action.callback();
          notification.remove();
        };
        actionsContainer.appendChild(btn);
      });
      
      notification.appendChild(actionsContainer);
    }
    
    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      position: absolute;
      top: 8px;
      right: 8px;
      background: none;
      border: none;
      color: inherit;
      font-size: 18px;
      cursor: pointer;
      opacity: 0.7;
    `;
    closeBtn.onclick = () => notification.remove();
    notification.appendChild(closeBtn);
    
    this.errorContainer.appendChild(notification);
    
    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-in';
        setTimeout(() => notification.remove(), 300);
      }, duration);
    }
  }
  
  /**
   * Handle WebRTC connection errors
   */
  handleWebRTCError(error, peerId) {
    console.error('[WebRTC Error]', error, peerId);
    
    const errorMessages = {
      'NotFoundError': 'Camera or microphone not found. Please check your devices.',
      'NotAllowedError': 'Camera/microphone access denied. Please allow access and try again.',
      'NotReadableError': 'Camera/microphone is already in use by another application.',
      'OverconstrainedError': 'Camera/microphone does not support the requested settings.',
      'TypeError': 'Browser does not support required features. Please use a modern browser.',
      'failed': 'Connection failed. Checking network...',
      'disconnected': 'Connection lost. Attempting to reconnect...'
    };
    
    const message = errorMessages[error.name] || errorMessages[error] || 'An unknown error occurred.';
    
    this.showError(message, 'error', 0, [
      {
        label: 'Retry',
        callback: () => {
          // Trigger reconnection
          if (window.retryConnection) {
            window.retryConnection(peerId);
          }
        }
      },
      {
        label: 'Dismiss',
        callback: () => {}
      }
    ]);
  }
  
  /**
   * Handle Socket.IO errors
   */
  handleSocketError(error) {
    console.error('[Socket Error]', error);
    
    this.showError(
      'Connection to server lost. Reconnecting...',
      'warning',
      0,
      [
        {
          label: 'Reconnect Now',
          callback: () => {
            if (window.reconnectSocket) {
              window.reconnectSocket();
            }
          }
        }
      ]
    );
  }
  
  /**
   * Handle media device errors
   */
  handleMediaError(error) {
    console.error('[Media Error]', error);
    
    let message = 'Could not access camera/microphone.';
    let actions = [];
    
    if (error.name === 'NotAllowedError') {
      message = 'Camera/microphone access denied. Please check your browser permissions.';
      actions = [
        {
          label: 'Help',
          callback: () => {
            window.open('https://support.google.com/chrome/answer/2693767', '_blank');
          }
        }
      ];
    } else if (error.name === 'NotFoundError') {
      message = 'No camera or microphone found. Please connect a device.';
    } else if (error.name === 'NotReadableError') {
      message = 'Camera/microphone is in use. Please close other apps and try again.';
      actions = [
        {
          label: 'Retry',
          callback: () => {
            if (window.retryMedia) {
              window.retryMedia();
            }
          }
        }
      ];
    }
    
    this.showError(message, 'error', 0, actions);
  }
  
  /**
   * Success message
   */
  showSuccess(message, duration = 3000) {
    this.showError(message, 'success', duration);
  }
  
  /**
   * Warning message
   */
  showWarning(message, duration = 5000) {
    this.showError(message, 'warning', duration);
  }
}

// Add CSS animation
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

// Export singleton instance
window.errorHandler = new ErrorHandler();
