// Shim server entrypoint for users running `node public/server.js`.
// Redirects to the real server in the repo root to preserve landing/host behavior.

require('../server');
