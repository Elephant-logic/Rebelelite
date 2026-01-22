# Rebel Stream

Refactored host/viewer WebRTC streaming app with chat, file sharing, and the arcade side-loader. This refactor keeps behavior, signaling, and UI intact while organizing the code for future features.

## Requirements
- Node.js 18+
- NPM

## Setup
```bash
npm install
```

## Run
```bash
npm start
```

The server runs on `http://localhost:9100`.

## Usage
1. Open `http://localhost:9100/index.html` for the host.
2. Enter a Room ID and your name, then **Join Room**.
3. Share the generated viewer link (or QR) with viewers.
4. Viewers open `view.html?room=YOUR_ROOM` and join.

## Project Structure
- `server.js` — Socket.IO signaling + room management.
- `public/app.js` — Host application logic (mixer, chat, calls, viewer broadcast).
- `public/viewer.js` — Viewer application logic (stream playback, chat, on-stage calls).
- `public/config/ice.js` — TURN/STUN configuration (do not modify unless changing infra).

## Notes
- This refactor intentionally preserves event names, TURN/ICE config, and handshake flow.
- UI layout and CSS are unchanged.
