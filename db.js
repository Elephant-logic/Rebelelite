// ======================================================
// DATABASE LAYER - SQLite Persistence
// ======================================================
// This module provides persistent storage for room data,
// replacing the in-memory storage. API remains the same.

const Database = require('better-sqlite3');
const path = require('path');

// Database file location (configurable via env)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'rebel.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // Better concurrent performance

// ======================================================
// SCHEMA INITIALIZATION
// ======================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    roomName TEXT PRIMARY KEY,
    ownerPassword TEXT,
    privacy TEXT DEFAULT 'public',
    isLive INTEGER DEFAULT 0,
    vipRequired INTEGER DEFAULT 0,
    createdAt INTEGER,
    title TEXT,
    viewers INTEGER DEFAULT 0,
    paymentEnabled INTEGER DEFAULT 0,
    paymentLabel TEXT DEFAULT '',
    paymentUrl TEXT DEFAULT '',
    turnEnabled INTEGER DEFAULT 0,
    turnHost TEXT DEFAULT '',
    turnPort INTEGER,
    turnTlsPort INTEGER,
    turnUsername TEXT DEFAULT '',
    turnPassword TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS vip_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomName TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    maxUses INTEGER DEFAULT 1,
    usesLeft INTEGER DEFAULT 1,
    createdAt INTEGER,
    FOREIGN KEY (roomName) REFERENCES rooms(roomName) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS vip_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomName TEXT NOT NULL,
    userName TEXT NOT NULL,
    addedAt INTEGER,
    FOREIGN KEY (roomName) REFERENCES rooms(roomName) ON DELETE CASCADE,
    UNIQUE(roomName, userName)
  );

  CREATE INDEX IF NOT EXISTS idx_vip_codes_room ON vip_codes(roomName);
  CREATE INDEX IF NOT EXISTS idx_vip_users_room ON vip_users(roomName);
`);

// ======================================================
// PREPARED STATEMENTS
// ======================================================
const stmts = {
  getRoom: db.prepare('SELECT * FROM rooms WHERE roomName = ?'),

  createRoom: db.prepare(`
    INSERT INTO rooms (roomName, ownerPassword, privacy, isLive, vipRequired, createdAt, title, viewers,
                       paymentEnabled, paymentLabel, paymentUrl, turnEnabled, turnHost, turnPort, turnTlsPort, turnUsername, turnPassword)
    VALUES (?, ?, ?, 0, 0, ?, NULL, 0, 0, '', '', 0, '', NULL, NULL, '', '')
  `),

  updateRoom: db.prepare(`
    UPDATE rooms SET
      ownerPassword = COALESCE(?, ownerPassword),
      privacy = COALESCE(?, privacy),
      isLive = COALESCE(?, isLive),
      vipRequired = COALESCE(?, vipRequired),
      title = COALESCE(?, title),
      viewers = COALESCE(?, viewers),
      paymentEnabled = COALESCE(?, paymentEnabled),
      paymentLabel = COALESCE(?, paymentLabel),
      paymentUrl = COALESCE(?, paymentUrl),
      turnEnabled = COALESCE(?, turnEnabled),
      turnHost = COALESCE(?, turnHost),
      turnPort = COALESCE(?, turnPort),
      turnTlsPort = COALESCE(?, turnTlsPort),
      turnUsername = COALESCE(?, turnUsername),
      turnPassword = COALESCE(?, turnPassword)
    WHERE roomName = ?
  `),

  deleteRoom: db.prepare('DELETE FROM rooms WHERE roomName = ?'),

  listPublicLiveRooms: db.prepare(`
    SELECT roomName, viewers, title, isLive FROM rooms
    WHERE privacy = 'public' AND isLive = 1
  `),

  // VIP Codes
  getVipCodes: db.prepare('SELECT code, maxUses, usesLeft FROM vip_codes WHERE roomName = ?'),
  getVipCode: db.prepare('SELECT * FROM vip_codes WHERE code = ?'),
  getVipCodeByRoom: db.prepare('SELECT * FROM vip_codes WHERE roomName = ? AND code = ?'),

  createVipCode: db.prepare(`
    INSERT INTO vip_codes (roomName, code, maxUses, usesLeft, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `),

  updateVipCodeUses: db.prepare('UPDATE vip_codes SET usesLeft = usesLeft - 1 WHERE code = ? AND usesLeft > 0'),
  deleteVipCode: db.prepare('DELETE FROM vip_codes WHERE roomName = ? AND code = ?'),

  // VIP Users
  getVipUsers: db.prepare('SELECT userName FROM vip_users WHERE roomName = ?'),
  addVipUser: db.prepare('INSERT OR IGNORE INTO vip_users (roomName, userName, addedAt) VALUES (?, ?, ?)'),
  removeVipUser: db.prepare('DELETE FROM vip_users WHERE roomName = ? AND userName = ?'),
};

// ======================================================
// DATABASE API
// ======================================================

function rowToRoomRecord(row) {
  if (!row) return null;
  return {
    roomName: row.roomName,
    ownerPassword: row.ownerPassword,
    privacy: row.privacy,
    isLive: !!row.isLive,
    vipRequired: !!row.vipRequired,
    createdAt: row.createdAt,
    title: row.title,
    viewers: row.viewers || 0,
    paymentEnabled: !!row.paymentEnabled,
    paymentLabel: row.paymentLabel || '',
    paymentUrl: row.paymentUrl || '',
    turnConfig: {
      enabled: !!row.turnEnabled,
      host: row.turnHost || '',
      port: row.turnPort || '',
      tlsPort: row.turnTlsPort || '',
      username: row.turnUsername || '',
      password: row.turnPassword || ''
    },
    // These are loaded separately
    vipCodes: {},
    vipUsers: []
  };
}

function loadVipData(roomName, record) {
  // Load VIP codes
  const codes = stmts.getVipCodes.all(roomName);
  record.vipCodes = {};
  for (const c of codes) {
    record.vipCodes[c.code] = { maxUses: c.maxUses, usesLeft: c.usesLeft };
  }

  // Load VIP users
  const users = stmts.getVipUsers.all(roomName);
  record.vipUsers = users.map(u => u.userName);

  return record;
}

// ======================================================
// EXPORTED FUNCTIONS (match existing API)
// ======================================================

function getRoomRecord(roomName) {
  if (!roomName) return null;
  const row = stmts.getRoom.get(roomName);
  if (!row) return null;
  const record = rowToRoomRecord(row);
  return loadVipData(roomName, record);
}

function createRoomRecord({ roomName, ownerPassword, privacy }) {
  if (!roomName) return { ok: false, error: 'Invalid room name.' };

  const existing = stmts.getRoom.get(roomName);
  if (existing) return { ok: false, error: 'Room already exists.' };

  try {
    stmts.createRoom.run(
      roomName,
      ownerPassword || null,
      privacy === 'private' ? 'private' : 'public',
      Date.now()
    );
    return { ok: true, room: getRoomRecord(roomName) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function updateRoomRecord(roomName, updater) {
  if (!roomName) return { ok: false, error: 'Invalid room name.' };

  const record = getRoomRecord(roomName);
  if (!record) return { ok: false, error: 'Room not found.' };

  // Apply updater to get changes
  updater(record);

  // Save changes to database
  try {
    stmts.updateRoom.run(
      record.ownerPassword,
      record.privacy,
      record.isLive ? 1 : 0,
      record.vipRequired ? 1 : 0,
      record.title,
      record.viewers,
      record.paymentEnabled ? 1 : 0,
      record.paymentLabel,
      record.paymentUrl,
      record.turnConfig?.enabled ? 1 : 0,
      record.turnConfig?.host,
      record.turnConfig?.port || null,
      record.turnConfig?.tlsPort || null,
      record.turnConfig?.username,
      record.turnConfig?.password,
      roomName
    );

    // Handle VIP codes changes
    // Note: VIP codes are managed separately via dedicated functions

    return { ok: true, room: record };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function listPublicRooms() {
  const rows = stmts.listPublicLiveRooms.all();
  return rows.map(row => ({
    name: row.roomName,
    viewers: row.viewers || 0,
    title: row.title || null,
    live: !!row.isLive
  }));
}

// VIP Code management
function addVipCode(roomName, code, maxUses) {
  try {
    stmts.createVipCode.run(roomName, code, maxUses, maxUses, Date.now());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function decrementVipCode(code) {
  const result = stmts.updateVipCodeUses.run(code);
  return result.changes > 0;
}

function deleteVipCode(roomName, code) {
  stmts.deleteVipCode.run(roomName, code);
  return { ok: true };
}

function getVipCodeByCode(code) {
  return stmts.getVipCode.get(code);
}

function listVipCodes(record) {
  if (!record || !record.vipCodes) return [];
  return Object.entries(record.vipCodes).map(([code, meta]) => ({
    code,
    maxUses: meta.maxUses,
    usesLeft: meta.usesLeft,
    used: Math.max(0, meta.maxUses - meta.usesLeft)
  }));
}

// VIP User management
function addVipUser(roomName, userName) {
  try {
    stmts.addVipUser.run(roomName, userName, Date.now());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function removeVipUser(roomName, userName) {
  stmts.removeVipUser.run(roomName, userName);
  return { ok: true };
}

// Cleanup on exit
process.on('exit', () => db.close());
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

module.exports = {
  getRoomRecord,
  createRoomRecord,
  updateRoomRecord,
  listPublicRooms,
  addVipCode,
  decrementVipCode,
  deleteVipCode,
  getVipCodeByCode,
  listVipCodes,
  addVipUser,
  removeVipUser,
  db // Export for direct access if needed
};
