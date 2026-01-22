# Rebel WAN Final

Hybrid WebRTC + Socket.io messenger with:

- 1:1 audio/video calls
- text chat
- emojis
- file send (base64 relay)
- WAN-ready ICE config (STUN + demo TURN)
- Render-compatible Node server

## Structure

- `server/server.js` – signalling server + static hosting
- `server/package.json` – Node dependencies + start script
- `public/` – client files (index.html, app.js, style.css, etc.)
- `config/ice.js` – ICE servers (loaded by index.html)
- `Procfile` – for platforms that use it (Heroku-style)

## Run locally

```bash
cd server
npm install
node server.js
