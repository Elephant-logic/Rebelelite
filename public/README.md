# Rebel Stream - P2P Live Streaming Platform

## 🚀 Overview

Rebel Stream is a peer-to-peer live streaming platform built with WebRTC, Socket.IO, and HTML5 Canvas. It enables real-time video streaming, chat, file sharing, and interactive overlays without requiring media servers.

## ✨ Features

### Core Features
- **P2P Live Streaming**: Direct browser-to-browser video streaming using WebRTC
- **Multi-Layout Mixer**: Solo, Guest, Picture-in-Picture, Split-screen layouts
- **Real-time Chat**: Public stream chat and private room chat
- **File Transfer**: Arcade system for P2P file sharing
- **HTML Overlays**: Dynamic graphics and text overlays on stream
- **Screen Sharing**: Share your screen alongside camera
- **VIP Access**: Code-based and username-based access control
- **Payment Integration**: Tip/donation button support

### Technical Features
- Auto-reconnection with exponential backoff
- Bitrate adaptation for network conditions
- ICE/TURN server support for NAT traversal
- Audio mixing from multiple sources
- Connection diagnostics and stats
- Mobile-responsive design

## 📋 Requirements

- Node.js 16+ (for server)
- Modern browser with WebRTC support (Chrome 88+, Firefox 85+, Safari 14+)
- HTTPS connection (required for camera/mic access)

## 🛠️ Installation

### 1. Clone the repository
```bash
git clone https://github.com/yourusername/rebel-stream.git
cd rebel-stream
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure ICE servers (optional)
Edit `config/ice.js`:
```javascript
function getIceServers(turnConfig) {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];
  
  if (turnConfig?.enabled) {
    servers.push({
      urls: `turn:${turnConfig.host}:${turnConfig.port}`,
      username: turnConfig.username,
      credential: turnConfig.password
    });
  }
  
  return servers;
}
```

### 4. Start the server
```bash
npm start
```

### 5. Open in browser
Navigate to `https://localhost:3000` (or your configured port)

## 📖 API Documentation

### Socket.IO Events

#### Client → Server

##### `join-room`
Join or create a room.
```javascript
socket.emit('join-room', {
  room: 'room-name',
  name: 'Display Name',
  role: 'host' | 'guest',
  password: 'optional-host-password'
});
```

**Response**: `join-ack` event with room data

##### `public-chat`
Send message to stream chat.
```javascript
socket.emit('public-chat', {
  room: 'room-name',
  name: 'username',
  text: 'message',
  ts: Date.now()
});
```

##### `private-chat`
Send message to room chat (guests only).
```javascript
socket.emit('private-chat', {
  room: 'room-name',
  name: 'username',
  text: 'message',
  ts: Date.now()
});
```

##### `webrtc-offer`
Send WebRTC offer to peer.
```javascript
socket.emit('webrtc-offer', {
  to: 'socket-id',
  offer: RTCSessionDescription
});
```

##### `webrtc-answer`
Send WebRTC answer to peer.
```javascript
socket.emit('webrtc-answer', {
  to: 'socket-id',
  answer: RTCSessionDescription
});
```

##### `ice-candidate`
Send ICE candidate to peer.
```javascript
socket.emit('ice-candidate', {
  to: 'socket-id',
  candidate: RTCIceCandidate
});
```

##### `ring-user`
Request to call another user.
```javascript
socket.emit('ring-user', 'socket-id');
```

##### `end-call`
End active call with peer.
```javascript
socket.emit('end-call', { to: 'socket-id' });
```

##### `kick-user`
Remove user from room (host only).
```javascript
socket.emit('kick-user', 'socket-id');
```

##### `promote-to-host`
Transfer host privileges (host only).
```javascript
socket.emit('promote-to-host', { targetId: 'socket-id' });
```

##### `set-privacy`
Update room privacy settings (host only).
```javascript
socket.emit('set-privacy', {
  isPrivate: true,
  allowedGuests: ['username1', 'username2']
});
```

##### `add-vip-user`
Add VIP user (host only).
```javascript
socket.emit('add-vip-user', { userName: 'username' }, (response) => {
  console.log(response.ok, response.error);
});
```

##### `generate-vip-code`
Generate shareable VIP code (host only).
```javascript
socket.emit('generate-vip-code', { uses: 10 }, (response) => {
  console.log(response.code);
});
```

##### `set-stream-title`
Update stream title (host only).
```javascript
socket.emit('set-stream-title', { title: 'My Stream' });
```

##### `set-slug`
Set custom URL slug (host only).
```javascript
socket.emit('set-slug', { slug: 'my-show' });
```

##### `set-payment`
Configure payment button (host only).
```javascript
socket.emit('set-payment', {
  enabled: true,
  label: 'Tip the host',
  url: 'https://payment.link'
});
```

##### `set-turn`
Configure TURN server (host only).
```javascript
socket.emit('set-turn', {
  enabled: true,
  host: 'turn.example.com',
  port: '3478',
  tlsPort: '5349',
  username: 'user',
  password: 'pass'
});
```

#### Server → Client

##### `join-ack`
Confirmation of room join.
```javascript
socket.on('join-ack', (data) => {
  // data: { room, ownerId, isPrivate, streamTitle, slug, ... }
});
```

##### `room-update`
Room state changed (users joined/left, settings updated).
```javascript
socket.on('room-update', (data) => {
  // data: { users, ownerId, isPrivate, ... }
});
```

##### `public-chat`
New public chat message.
```javascript
socket.on('public-chat', (data) => {
  // data: { name, text, ts }
});
```

##### `private-chat`
New private chat message.
```javascript
socket.on('private-chat', (data) => {
  // data: { name, text, ts }
});
```

##### `viewer-join`
New viewer connected.
```javascript
socket.on('viewer-join', (data) => {
  // data: { socketId }
});
```

##### `viewer-left`
Viewer disconnected.
```javascript
socket.on('viewer-left', (data) => {
  // data: { socketId }
});
```

##### `ring-you`
Incoming call request.
```javascript
socket.on('ring-you', (data) => {
  // data: { from, fromName }
});
```

##### `call-offer`
WebRTC call offer received.
```javascript
socket.on('call-offer', (data) => {
  // data: { from, offer }
});
```

##### `call-answer`
WebRTC call answer received.
```javascript
socket.on('call-answer', (data) => {
  // data: { from, answer }
});
```

##### `call-ice`
ICE candidate for call.
```javascript
socket.on('call-ice', (data) => {
  // data: { from, candidate }
});
```

##### `error-message`
Server error notification.
```javascript
socket.on('error-message', (message) => {
  console.error('Server error:', message);
});
```

### JavaScript Modules

#### StateManager
Centralized state management.

```javascript
// Get state value
const userName = stateManager.get('userName');

// Set state value
stateManager.set('userName', 'NewName');

// Subscribe to changes
stateManager.subscribe('userName', (newValue, oldValue) => {
  console.log('Name changed:', oldValue, '->', newValue);
});

// Update multiple values
stateManager.update({
  joined: true,
  iAmHost: true
});
```

#### ErrorHandler
User-friendly error messages.

```javascript
// Show error
errorHandler.showError('Connection failed', 'error');

// Show success
errorHandler.showSuccess('Settings saved!');

// Show error with actions
errorHandler.showError('Connection lost', 'error', 0, [
  { label: 'Retry', callback: () => reconnect() },
  { label: 'Cancel', callback: () => {} }
]);

// Handle specific errors
errorHandler.handleMediaError(error);
errorHandler.handleWebRTCError(error, peerId);
errorHandler.handleSocketError(error);
```

#### ConnectionManager
Auto-reconnection logic.

```javascript
// Create manager
const connManager = createConnectionManager(socket);

// Register peer connection
connManager.registerPeerConnection(id, pc, 'viewer');

// Add reconnection callback
connManager.onReconnect(() => {
  console.log('Reconnected!');
  rejoinRoom();
});

// Check network status
if (connManager.checkNetworkStatus()) {
  // Network is available
}
```

#### ChatHelper
Reusable chat functions.

```javascript
// Append message
chatHelper.appendMessage(logElement, 'User', 'Hello!');

// Send message
chatHelper.sendMessage(socket, 'public-chat', roomName, userName, message);

// Setup emoji picker
chatHelper.setupEmojiPicker(emojiStripElement, inputElement);

// Export chat history
const history = chatHelper.exportChatHistory(logElement);

// Download chat
chatHelper.downloadChatHistory(logElement);
```

## 🎨 Theming

The app uses CSS custom properties for easy theming:

```css
:root {
  --bg: #050814;
  --panel: #101524;
  --accent: #4af3a3;
  --danger: #ff4b6a;
  --text: #f5f7ff;
  --muted: #9ba3c0;
  --border: #262d44;
}
```

## 📱 Mobile Support

- Touch-optimized UI with 44px minimum tap targets
- Responsive layouts for phone, tablet, landscape
- Smooth scrolling and momentum
- Safe area insets for notched devices
- Prevents double-tap zoom

## 🔒 Security Considerations

- Always use HTTPS in production
- Implement rate limiting on server
- Validate all user inputs
- Use secure WebSocket connections (wss://)
- Don't expose TURN credentials in client code
- Implement CSRF protection for room creation

## 🧪 Testing

### Unit Tests
```bash
npm test
```

### Integration Tests
```bash
npm run test:integration
```

### Browser Compatibility Tests
```bash
npm run test:browsers
```

## 🐛 Troubleshooting

### Camera/Mic Access Issues
- Ensure HTTPS is enabled
- Check browser permissions
- Close other apps using camera/mic

### Connection Failures
- Verify STUN/TURN servers are accessible
- Check firewall settings
- Test with different networks

### Audio Issues
- Check browser autoplay policies
- Ensure audio tracks are enabled
- Verify audio constraints

## 📄 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📧 Support

- Documentation: https://docs.rebelstream.io
- Issues: https://github.com/yourusername/rebel-stream/issues
- Discord: https://discord.gg/rebelstream

## 🙏 Acknowledgments

- WebRTC Working Group
- Socket.IO team
- Contributors and testers
