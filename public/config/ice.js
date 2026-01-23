// REBEL STREAM - ICE CONFIG
// NOTE: STUN defaults remain the same. TURN is optional and must be provided per-room by the host.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

function isValidTurnConfig(config) {
  if (!config || !config.enabled) return false;
  const host = String(config.host || '').trim();
  const port = Number(config.port);
  const username = String(config.username || '').trim();
  const password = String(config.password || '').trim();
  if (!host || !Number.isFinite(port) || port <= 0) return false;
  if (!username || !password) return false;
  return true;
}

function normalizeTurnConfig(config) {
  if (!config) return null;
  return {
    enabled: !!config.enabled,
    host: String(config.host || '').trim(),
    port: Number(config.port),
    tlsPort: config.tlsPort ? Number(config.tlsPort) : null,
    username: String(config.username || '').trim(),
    password: String(config.password || '').trim()
  };
}

function getIceServers(turnConfig) {
  const baseServers = Array.isArray(ICE_SERVERS) && ICE_SERVERS.length
    ? ICE_SERVERS
    : [{ urls: 'stun:stun.l.google.com:19302' }];
  const servers = baseServers.map((server) => ({ ...server }));
  const normalizedTurn = normalizeTurnConfig(turnConfig);
  if (!isValidTurnConfig(normalizedTurn)) {
    return servers;
  }
  const host = normalizedTurn.host;
  const port = normalizedTurn.port;
  servers.push(
    {
      urls: `turn:${host}:${port}?transport=udp`,
      username: normalizedTurn.username,
      credential: normalizedTurn.password
    },
    {
      urls: `turn:${host}:${port}?transport=tcp`,
      username: normalizedTurn.username,
      credential: normalizedTurn.password
    }
  );
  if (normalizedTurn.tlsPort && Number.isFinite(normalizedTurn.tlsPort)) {
    servers.push({
      urls: `turns:${host}:${normalizedTurn.tlsPort}?transport=tcp`,
      username: normalizedTurn.username,
      credential: normalizedTurn.password
    });
  }
  return servers;
}

// Default RTC config helper (not currently used by the app runtime).
const rtcConfig = {
  iceServers: getIceServers(),
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle'
};
