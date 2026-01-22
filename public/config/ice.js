// REBEL STREAM - SECURE ICE BRIDGE
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

const rtcConfig = {
  iceServers: ICE_SERVERS,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle'
};
