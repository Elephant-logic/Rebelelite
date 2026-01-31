/**
 * CHAT HELPER MODULE
 * Reusable chat functions to reduce code duplication
 */

class ChatHelper {
  constructor() {
    this.emojiMap = {
      'smile': '😀',
      'laugh': '😂',
      'thumbs': '👍',
      'fire': '🔥',
      'skull': '💀',
      'heart': '❤️'
    };
  }
  
  /**
   * Append a message to a chat log with auto-scroll
   */
  appendMessage(logElement, userName, message, timestamp = Date.now()) {
    if (!logElement) {
      console.warn('[Chat] Log element not found');
      return;
    }
    
    const line = document.createElement('div');
    line.className = 'chat-line';
    
    const nameEl = document.createElement('strong');
    nameEl.textContent = userName;
    
    const timeEl = document.createElement('small');
    timeEl.textContent = new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    timeEl.style.cssText = 'margin-left: 8px; opacity: 0.6; font-size: 0.75rem;';
    
    const messageEl = document.createElement('span');
    messageEl.textContent = `: ${message}`;
    
    line.appendChild(nameEl);
    line.appendChild(timeEl);
    line.appendChild(messageEl);
    
    logElement.appendChild(line);
    
    // Auto-scroll to bottom
    this.scrollToBottom(logElement);
    
    // Keep only last 100 messages for performance
    this.trimMessages(logElement, 100);
  }
  
  /**
   * Scroll chat to bottom smoothly
   */
  scrollToBottom(element) {
    if (!element) return;
    
    // Use smooth scrolling if supported
    if ('scrollBehavior' in document.documentElement.style) {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: 'smooth'
      });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }
  
  /**
   * Trim old messages to prevent memory issues
   */
  trimMessages(logElement, maxMessages = 100) {
    const messages = logElement.querySelectorAll('.chat-line');
    const excessCount = messages.length - maxMessages;
    
    if (excessCount > 0) {
      for (let i = 0; i < excessCount; i++) {
        messages[i].remove();
      }
    }
  }
  
  /**
   * Clear all messages from a chat log
   */
  clearMessages(logElement) {
    if (logElement) {
      logElement.innerHTML = '';
    }
  }
  
  /**
   * Send a message through socket with validation
   */
  sendMessage(socket, channel, roomName, userName, message) {
    const trimmed = message.trim();
    
    if (!trimmed) {
      console.warn('[Chat] Empty message');
      return false;
    }
    
    if (trimmed.length > 500) {
      window.errorHandler.showWarning('Message too long. Maximum 500 characters.');
      return false;
    }
    
    if (!roomName) {
      window.errorHandler.showError('Not connected to a room.');
      return false;
    }
    
    socket.emit(channel, {
      room: roomName,
      name: userName,
      text: trimmed,
      ts: Date.now()
    });
    
    return true;
  }
  
  /**
   * Setup emoji picker for an input
   */
  setupEmojiPicker(emojiStripElement, inputElement) {
    if (!emojiStripElement || !inputElement) return;
    
    emojiStripElement.querySelectorAll('.emoji').forEach(emojiEl => {
      emojiEl.onclick = () => {
        // Insert emoji at cursor position
        const cursorPos = inputElement.selectionStart;
        const textBefore = inputElement.value.substring(0, cursorPos);
        const textAfter = inputElement.value.substring(cursorPos);
        
        inputElement.value = textBefore + emojiEl.textContent + textAfter;
        
        // Move cursor after emoji
        const newCursorPos = cursorPos + emojiEl.textContent.length;
        inputElement.setSelectionRange(newCursorPos, newCursorPos);
        
        inputElement.focus();
      };
    });
  }
  
  /**
   * Setup auto-complete for @mentions
   */
  setupMentions(inputElement, getUserList) {
    if (!inputElement) return;
    
    let mentionDropdown = null;
    
    inputElement.addEventListener('input', (e) => {
      const text = e.target.value;
      const cursorPos = e.target.selectionStart;
      const textBeforeCursor = text.substring(0, cursorPos);
      
      // Check if @ symbol was typed
      const atMatch = textBeforeCursor.match(/@(\w*)$/);
      
      if (atMatch) {
        const query = atMatch[1].toLowerCase();
        const users = getUserList();
        const matches = users.filter(u => 
          u.name.toLowerCase().startsWith(query)
        );
        
        if (matches.length > 0) {
          this.showMentionDropdown(inputElement, matches, (user) => {
            // Replace @query with @username
            const beforeAt = textBeforeCursor.substring(0, atMatch.index);
            const afterCursor = text.substring(cursorPos);
            inputElement.value = beforeAt + '@' + user.name + ' ' + afterCursor;
            this.hideMentionDropdown();
          });
        } else {
          this.hideMentionDropdown();
        }
      } else {
        this.hideMentionDropdown();
      }
    });
    
    // Hide dropdown on blur
    inputElement.addEventListener('blur', () => {
      setTimeout(() => this.hideMentionDropdown(), 200);
    });
  }
  
  /**
   * Show mention autocomplete dropdown
   */
  showMentionDropdown(inputElement, users, onSelect) {
    this.hideMentionDropdown();
    
    const dropdown = document.createElement('div');
    dropdown.className = 'mention-dropdown';
    dropdown.style.cssText = `
      position: absolute;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 1000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    
    const rect = inputElement.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.top - 210) + 'px';
    dropdown.style.width = rect.width + 'px';
    
    users.forEach(user => {
      const item = document.createElement('div');
      item.textContent = user.name;
      item.style.cssText = `
        padding: 10px;
        cursor: pointer;
        transition: background 0.2s;
      `;
      
      item.onmouseover = () => {
        item.style.background = 'rgba(74, 243, 163, 0.1)';
      };
      item.onmouseout = () => {
        item.style.background = 'transparent';
      };
      
      item.onclick = () => onSelect(user);
      
      dropdown.appendChild(item);
    });
    
    document.body.appendChild(dropdown);
    this.mentionDropdown = dropdown;
  }
  
  /**
   * Hide mention dropdown
   */
  hideMentionDropdown() {
    if (this.mentionDropdown) {
      this.mentionDropdown.remove();
      this.mentionDropdown = null;
    }
  }
  
  /**
   * Filter messages by user (for muting)
   */
  filterMessagesByUser(logElement, userName, hide = true) {
    if (!logElement) return;
    
    const lines = logElement.querySelectorAll('.chat-line');
    lines.forEach(line => {
      const strong = line.querySelector('strong');
      if (strong && strong.textContent === userName) {
        line.style.display = hide ? 'none' : 'block';
      }
    });
  }
  
  /**
   * Export chat history as text
   */
  exportChatHistory(logElement) {
    if (!logElement) return '';
    
    const lines = logElement.querySelectorAll('.chat-line');
    const history = Array.from(lines).map(line => {
      const name = line.querySelector('strong')?.textContent || 'Unknown';
      const time = line.querySelector('small')?.textContent || '';
      const text = line.textContent.replace(name, '').replace(time, '').replace(':', '').trim();
      return `[${time}] ${name}: ${text}`;
    }).join('\n');
    
    return history;
  }
  
  /**
   * Download chat history
   */
  downloadChatHistory(logElement, filename = 'chat-history.txt') {
    const history = this.exportChatHistory(logElement);
    const blob = new Blob([history], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    
    URL.revokeObjectURL(url);
  }
}

// Export singleton instance
window.chatHelper = new ChatHelper();
