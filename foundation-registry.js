/**
 * FOUNDATION ROOM REGISTRY
 * Manages permanent room ownership (2,000 lifetime rooms)
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class FoundationRegistry {
  constructor(registryPath = './data/foundation-registry.json') {
    this.registryPath = registryPath;
    this.registry = {
      rooms: {},
      totalSold: 0,
      limit: parseInt(process.env.FOUNDATION_ROOM_LIMIT) || 2000,
      price: parseInt(process.env.FOUNDATION_ROOM_PRICE) || 2999
    };
    this.loaded = false;
  }

  /**
   * Initialize and load registry from disk
   */
  async init() {
    try {
      // Ensure data directory exists
      const dir = path.dirname(this.registryPath);
      await fs.mkdir(dir, { recursive: true });

      // Try to load existing registry
      try {
        const data = await fs.readFile(this.registryPath, 'utf8');
        this.registry = JSON.parse(data);
        console.log(`[Registry] Loaded ${this.registry.totalSold} foundation rooms`);
      } catch (err) {
        // File doesn't exist yet - use defaults
        console.log('[Registry] Creating new registry');
        await this.save();
      }

      this.loaded = true;
    } catch (err) {
      console.error('[Registry] Init error:', err);
      throw err;
    }
  }

  /**
   * Save registry to disk
   */
  async save() {
    try {
      await fs.writeFile(
        this.registryPath,
        JSON.stringify(this.registry, null, 2),
        'utf8'
      );
    } catch (err) {
      console.error('[Registry] Save error:', err);
      throw err;
    }
  }

  /**
   * Hash password for secure storage
   */
  hashPassword(password) {
    return crypto
      .createHash('sha256')
      .update(password)
      .digest('hex');
  }

  /**
   * Check if room name is available for purchase
   */
  isAvailable(roomName) {
    if (!this.loaded) return false;
    if (this.registry.totalSold >= this.registry.limit) return false;
    return !this.registry.rooms[roomName];
  }

  /**
   * Check if room is a foundation room
   */
  isFoundationRoom(roomName) {
    return !!this.registry.rooms[roomName];
  }

  /**
   * Verify password for a foundation room
   */
  verifyPassword(roomName, password) {
    const room = this.registry.rooms[roomName];
    if (!room) return false;

    const hashedInput = this.hashPassword(password);
    return hashedInput === room.passwordHash;
  }

  /**
   * Purchase a foundation room
   */
  async purchase(roomName, password, purchaserEmail, stripeSessionId) {
    if (!this.isAvailable(roomName)) {
      throw new Error('Room name is not available');
    }

    // Validate room name
    if (!/^[a-z0-9-]{3,32}$/.test(roomName)) {
      throw new Error('Invalid room name format');
    }

    // Create room entry
    this.registry.rooms[roomName] = {
      passwordHash: this.hashPassword(password),
      purchasedAt: new Date().toISOString(),
      purchaserEmail,
      stripeSessionId,
      isFoundationMember: true
    };

    this.registry.totalSold++;

    await this.save();

    console.log(`[Registry] Purchased: ${roomName} (${this.registry.totalSold}/${this.registry.limit})`);

    return {
      success: true,
      roomName,
      totalSold: this.registry.totalSold,
      remaining: this.registry.limit - this.registry.totalSold
    };
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      totalSold: this.registry.totalSold,
      limit: this.registry.limit,
      remaining: this.registry.limit - this.registry.totalSold,
      price: this.registry.price,
      percentSold: Math.round((this.registry.totalSold / this.registry.limit) * 100)
    };
  }

  /**
   * Get room info (without password)
   */
  getRoomInfo(roomName) {
    const room = this.registry.rooms[roomName];
    if (!room) return null;

    return {
      roomName,
      isFoundationMember: room.isFoundationMember,
      purchasedAt: room.purchasedAt
    };
  }

  /**
   * List all foundation rooms (admin only)
   */
  listAll() {
    return Object.keys(this.registry.rooms).map(roomName => ({
      roomName,
      purchasedAt: this.registry.rooms[roomName].purchasedAt,
      email: this.registry.rooms[roomName].purchaserEmail
    }));
  }
}

module.exports = FoundationRegistry;
