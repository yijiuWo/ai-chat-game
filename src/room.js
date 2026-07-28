// src/room.js

/** @type {Map<string, object>} 内存中存储所有活跃房间 */
const rooms = new Map();

// AI 的昵称和头像池
const AI_NAMES = ['深海咸鱼', '深夜哲学家', '吃瓜群众', '路过的一只', '不想上班'];
const AI_AVATARS = ['🐟', '🦉', '🐸', '🐰', '🐼'];

// 真人玩家的头像池
const PLAYER_AVATARS = ['😺', '🐶', '🐱', '🐨', '🦊', '🐯', '🐻', '🐮'];

/**
 * 生成 6 位房间号（排除容易混淆的 0/O/1/I）
 * @returns {string}
 */
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  if (rooms.has(id)) return generateRoomId();
  return id;
}

/**
 * 创建新房间
 * @param {string} socketId - 房主 socket ID
 * @param {string} nickname - 房主昵称
 * @returns {object} 房间对象
 */
function createRoom(socketId, nickname) {
  if (!nickname || typeof nickname !== 'string') return null;
  nickname = nickname.replace(/<[^>]*>/g, '');
  nickname = nickname.trim().slice(0, 12);
  if (!nickname) return null;

  const roomId = generateRoomId();
  const assignedAvatar = PLAYER_AVATARS[Math.floor(Math.random() * PLAYER_AVATARS.length)];

  const room = {
    id: roomId,
    players: [{
      id: socketId,
      nickname,
      avatar: assignedAvatar,
      isReady: false,
      isHost: true,
    }],
    aiPlayer: null,
    state: 'WAITING',
    currentRound: 0,
    topic: null,
    chatHistory: [],
    votes: [],
    roundTimer: null,
    aiSpeakTimer: null,
    ownerSocketId: socketId,
  };

  rooms.set(roomId, room);
  return room;
}

/**
 * 加入已有房间
 * @param {string} roomId - 房间号
 * @param {string} socketId - 玩家 socket ID
 * @param {string} nickname - 玩家昵称
 * @returns {object|null} 房间对象，失败返回 null
 */
function joinRoom(roomId, socketId, nickname) {
  roomId = typeof roomId === 'string' ? roomId.toUpperCase() : roomId;

  if (!nickname || typeof nickname !== 'string') return null;
  nickname = nickname.replace(/<[^>]*>/g, '');
  nickname = nickname.trim().slice(0, 12);
  if (!nickname) return null;

  const room = rooms.get(roomId);
  if (!room) return null;

  // 取消待删除定时器（有人回来了）
  if (room._deleteTimer) {
    clearTimeout(room._deleteTimer);
    room._deleteTimer = null;
  }

  if (room.state !== 'WAITING') return null;

  // 同一 socket ID 已在房间内
  if (room.players.find(p => p.id === socketId)) return room;

  // 检查是否有同昵称的玩家（不限于断线状态：页面跳转时新旧 socket
  // 切换存在竞态，新 socket 可能在旧 disconnect 事件之前到达）
  const reconnected = room.players.find(
    p => p.nickname === nickname
  );
  if (reconnected) {
    // 无缝恢复：更新 socket ID，清除断线标记和定时器
    reconnected.id = socketId;
    reconnected._disconnected = false;
    if (reconnected._disconnectTimer) {
      clearTimeout(reconnected._disconnectTimer);
      reconnected._disconnectTimer = null;
    }
    // 如果房间没有活跃房主，让重连者当房主
    const hasActiveHost = room.players.some(p => !p._disconnected && p.isHost);
    if (!hasActiveHost) {
      reconnected.isHost = true;
      room.ownerSocketId = socketId;
    }
    console.log(`[重连] ${nickname} 恢复连接 (room ${roomId})`);
    return room;
  }

  // 计算活跃玩家数（不含已断线的）
  const activePlayers = room.players.filter(p => !p._disconnected);
  if (activePlayers.length >= 4) return null;

  const usedAvatars = new Set(room.players.map(p => p.avatar));
  const available = PLAYER_AVATARS.filter(a => !usedAvatars.has(a));
  const avatar = available[Math.floor(Math.random() * available.length)];

  room.players.push({
    id: socketId,
    nickname,
    avatar,
    isReady: false,
    isHost: false,
  });

  return room;
}

/**
 * 玩家离开房间（断线时调用）
 *
 * 不立即移除，而是标记 _disconnected。
 * 调用者（server.js）应设置 30s 定时器来真正移除，
 * 期间同昵称重连可通过 joinRoom 无缝恢复。
 *
 * @param {string} socketId
 * @returns {{ room: object|null, player: object|null, wasOwner: boolean }|null}
 */
function leaveRoom(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.find(p => p.id === socketId);
    if (!player) continue;

    const wasOwner = player.isHost;
    player._disconnected = true;
    player._disconnectedAt = Date.now();

    console.log(`[断线] ${player.nickname} (${socketId}) 断开，等待重连`);
    return { room, player, wasOwner };
  }
  return null;
}

/**
 * 从房间中彻底移除玩家（宽限期过后调用）
 * @param {object} room
 * @param {string} socketId
 * @returns {{ wasOwner: boolean, playerName: string, roomEmpty: boolean }|null}
 */
function removePlayer(room, socketId) {
  const idx = room.players.findIndex(p => p.id === socketId);
  if (idx === -1) return null;

  const player = room.players[idx];
  const wasOwner = player.isHost;
  const playerName = player.nickname;
  room.players.splice(idx, 1);

  const activePlayers = room.players.filter(p => !p._disconnected);
  if (activePlayers.length === 0) {
    clearTimers(room);
    room._deleteTimer = setTimeout(() => {
      rooms.delete(room.id);
    }, 5000);
    return { wasOwner, playerName, roomEmpty: true };
  }

  if (wasOwner) {
    transferHost(room);
  }

  return { wasOwner, playerName, roomEmpty: false };
}

/**
 * 转移房主给第一个活跃玩家
 */
function transferHost(room) {
  // 清除所有玩家的房主标记
  room.players.forEach(p => { p.isHost = false; });
  const firstActive = room.players.find(p => !p._disconnected);
  if (firstActive) {
    firstActive.isHost = true;
    room.ownerSocketId = firstActive.id;
  }
}

/**
 * 切换准备状态
 * @param {string} roomId
 * @param {string} socketId
 * @returns {boolean} 新的准备状态
 */
function toggleReady(roomId, socketId) {
  roomId = typeof roomId === 'string' ? roomId.toUpperCase() : roomId;
  const room = rooms.get(roomId);
  if (!room) return false;
  if (room.state !== 'WAITING') return false;

  const player = room.players.find(p => p.id === socketId);
  if (!player) return false;

  player.isReady = !player.isReady;
  return player.isReady;
}

/**
 * 检查是否所有活跃玩家都已准备
 * @param {string} roomId
 * @returns {boolean}
 */
function allReady(roomId) {
  roomId = typeof roomId === 'string' ? roomId.toUpperCase() : roomId;
  const room = rooms.get(roomId);
  if (!room) return false;
  if (room.state !== 'WAITING') return false;
  const active = room.players.filter(p => !p._disconnected);
  return active.length >= 3 && active.every(p => p.isReady);
}

/**
 * 通过 socket ID 查找玩家所在房间
 * @param {string} socketId
 * @returns {object|null}
 */
function getRoomBySocketId(socketId) {
  for (const room of rooms.values()) {
    if (room.players.find(p => p.id === socketId)) return room;
  }
  return null;
}

/**
 * 通过房间号查找房间
 * @param {string} roomId
 * @returns {object|undefined}
 */
function getRoom(roomId) {
  roomId = typeof roomId === 'string' ? roomId.toUpperCase() : roomId;
  return rooms.get(roomId);
}

/**
 * 清理房间的所有定时器
 * @param {object} room
 */
function clearTimers(room) {
  if (room.roundTimer) { clearInterval(room.roundTimer); room.roundTimer = null; }
  if (room.aiSpeakTimer) { clearTimeout(room.aiSpeakTimer); room.aiSpeakTimer = null; }
  if (room.resultTimer) { clearTimeout(room.resultTimer); room.resultTimer = null; }
  if (room._deleteTimer) { clearTimeout(room._deleteTimer); room._deleteTimer = null; }
  // 清理所有玩家的断线定时器
  (room.players || []).forEach(p => {
    if (p._disconnectTimer) { clearTimeout(p._disconnectTimer); p._disconnectTimer = null; }
  });
}

/**
 * 获取房间的活跃玩家（不含已断线但还在宽限期内的）
 * @param {object} room
 * @returns {Array}
 */
function getActivePlayers(room) {
  return room.players.filter(p => !p._disconnected);
}

module.exports = {
  createRoom, joinRoom, leaveRoom, removePlayer, toggleReady,
  allReady, getRoomBySocketId, getRoom, clearTimers,
  getActivePlayers, transferHost,
  AI_NAMES, AI_AVATARS,
};
