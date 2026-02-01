/**
 * TREE MANAGER - Standalone Module
 * Handles relay network routing without modifying existing code
 */

class TreeManager {
  constructor() {
    this.trees = new Map();
  }

  initializeRoom(roomName, hostSocketId) {
    if (this.trees.has(roomName)) return;

    const tree = {
      host: hostSocketId,
      nodes: new Map(),
      orphans: new Set()
    };

    tree.nodes.set(hostSocketId, {
      socketId: hostSocketId,
      type: 'host',
      capacity: 10,
      children: new Set(),
      parent: null,
      tier: 0,
      lastSeen: Date.now()
    });

    this.trees.set(roomName, tree);
    console.log(`[Tree] Initialized: ${roomName}`);
    return tree;
  }

  calculateCapacity(deviceInfo) {
    const { isMobile, connection, bandwidth } = deviceInfo || {};
    if (isMobile) return 0;
    if (connection === 'ethernet' || (bandwidth && bandwidth > 10000)) return 10;
    if (connection === '4g' || connection === 'wifi') return bandwidth > 5000 ? 5 : 2;
    return 3;
  }

  findBestParent(roomName) {
    const tree = this.trees.get(roomName);
    if (!tree) return null;

    let bestParent = null;
    let bestScore = -Infinity;

    tree.nodes.forEach((node) => {
      const availableSlots = node.capacity - node.children.size;
      if (availableSlots <= 0 || node.tier >= 3) return;
      const score = (1000 - node.tier * 100) + (availableSlots * 10);
      if (score > bestScore) {
        bestScore = score;
        bestParent = node;
      }
    });

    return bestParent;
  }

  addViewer(roomName, viewerSocketId, deviceInfo) {
    const tree = this.trees.get(roomName);
    if (!tree) return null;

    const capacity = this.calculateCapacity(deviceInfo);
    const parent = this.findBestParent(roomName);
    if (!parent) return null;

    const viewerNode = {
      socketId: viewerSocketId,
      type: 'viewer',
      capacity,
      children: new Set(),
      parent: parent.socketId,
      tier: parent.tier + 1,
      lastSeen: Date.now(),
      deviceInfo
    };

    tree.nodes.set(viewerSocketId, viewerNode);
    parent.children.add(viewerSocketId);

    return { parentId: parent.socketId, tier: viewerNode.tier, capacity };
  }

  removeViewer(roomName, viewerSocketId) {
    const tree = this.trees.get(roomName);
    if (!tree) return { orphans: [], parentId: null };

    const node = tree.nodes.get(viewerSocketId);
    if (!node) return { orphans: [], parentId: null };

    const parentId = node.parent || null;
    const orphans = Array.from(node.children);

    if (node.parent) {
      const parent = tree.nodes.get(node.parent);
      if (parent) parent.children.delete(viewerSocketId);
    }

    tree.nodes.delete(viewerSocketId);
    return { orphans, parentId };
  }

  reassignOrphans(roomName, orphans) {
    const assignments = [];

    orphans.forEach(orphanId => {
      const tree = this.trees.get(roomName);
      if (!tree) return;

      const orphanNode = tree.nodes.get(orphanId);
      if (!orphanNode) return;

      const newParent = this.findBestParent(roomName);

      if (newParent) {
        orphanNode.parent = newParent.socketId;
        orphanNode.tier = newParent.tier + 1;
        newParent.children.add(orphanId);
        assignments.push({ childId: orphanId, newParentId: newParent.socketId });
      }
    });

    return assignments;
  }

  destroyRoom(roomName) {
    this.trees.delete(roomName);
  }
}

module.exports = TreeManager;
