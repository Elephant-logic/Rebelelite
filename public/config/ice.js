// REBEL STREAM - SECURE ICE BRIDGE
// NOTE: Do not edit TURN/STUN URLs or credentials unless you intend to
// change deployment infrastructure. App logic expects these constants.
const ICE_SERVERS = [
  {
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  { urls: 'stun:stun.l.google.com:19302' }
];

// Default RTC config helper (not currently used by the app runtime).
const rtcConfig = {
  iceServers: ICE_SERVERS,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle'
};
