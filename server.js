// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const {
  createRoom, joinRoom, leaveRoom, removePlayer, toggleReady,
  allReady, getRoomBySocketId, getRoom, getActivePlayers, transferHost,
} = require('./src/room');
const { startGame, handleVote } = require('./src/game');
const { startUndercover, handleDescribe, handleEliminationVote, handleFinalAiVote, callVote } = require('./src/undercover');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 公网地址 API（用于生成分享链接）
app.get('/api/public-url', (req, res) => {
  res.json({ url: process.env.PUBLIC_URL || '' });
});

// AI 诊断端点（排查 AI 调用失败原因）
app.get('/api/ai-health', async (req, res) => {
  const { generateReply } = require('./src/ai');
  const info = {
    provider: process.env.AI_PROVIDER || '(not set)',
    model: process.env.QWEN_MODEL || process.env.DEEPSEEK_MODEL || '(not set)',
    hasQwenKey: !!process.env.QWEN_API_KEY,
    hasDeepseekKey: !!process.env.DEEPSEEK_API_KEY,
    nodeVersion: process.version,
  };

  try {
    const reply = await generateReply('回复"OK"即可', '请回复OK');
    info.aiTest = reply ? reply.slice(0, 100) : '(empty)';
    info.aiOk = true;
  } catch (err) {
    info.aiOk = false;
    info.aiError = err.message;
  }

  res.json(info);
});

// ===== Socket.IO 事件处理 =====
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // --- 创建房间 ---
  socket.on('create_room', ({ nickname }) => {
    if (!nickname || !nickname.trim()) {
      socket.emit('error', { message: '请输入昵称' });
      return;
    }

    const room = createRoom(socket.id, nickname.trim());
    if (!room) {
      socket.emit('error', { message: '昵称无效' });
      return;
    }

    socket.join(room.id);
    socket.emit('room_created', {
      roomId: room.id,
      players: getActivePlayers(room),
      youAreHost: true,
    });
    console.log(`[房间] ${room.id} 由 ${nickname} 创建`);
  });

  // --- 加入房间 ---
  socket.on('join_room', ({ roomId, nickname }) => {
    if (!nickname || !nickname.trim()) {
      socket.emit('error', { message: '请输入昵称' });
      return;
    }
    if (!roomId) {
      socket.emit('error', { message: '请输入房间号' });
      return;
    }

    const room = joinRoom(roomId.toUpperCase().trim(), socket.id, nickname.trim());
    if (!room) {
      socket.emit('error', { message: '房间不存在、已满员或游戏已开始' });
      return;
    }

    socket.join(room.id);
    socket.emit('room_joined', {
      roomId: room.id,
      players: getActivePlayers(room),
    });

    socket.to(room.id).emit('player_joined', {
      player: getActivePlayers(room)[getActivePlayers(room).length - 1],
    });

    console.log(`[房间] ${nickname} 加入 ${room.id}`);
  });

  // --- 切换准备 ---
  socket.on('toggle_ready', () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;

    const isReady = toggleReady(room.id, socket.id);
    io.to(room.id).emit('ready_update', { playerId: socket.id, isReady });
  });

  // --- 开始游戏 ---
  socket.on('start_game', () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id && !p._disconnected);
    if (!player || !player.isHost) {
      socket.emit('error', { message: '只有房主可以开始游戏' });
      return;
    }

    const activeCount = getActivePlayers(room).length;
    if (activeCount < 3) {
      socket.emit('error', { message: '至少需要 3 个真人玩家' });
      return;
    }

    if (!allReady(room.id)) {
      socket.emit('error', { message: '还有玩家没准备好' });
      return;
    }

    console.log(`[游戏] ${room.id} 开始 — 谁是卧底模式`);
    startUndercover(room, io);
  });

  // --- 加入游戏（从 game.html 重连） ---
  socket.on('join_game', ({ roomId, nickname }) => {
    if (!roomId || !nickname) {
      socket.emit('error', { message: '参数无效' });
      return;
    }

    const normalizedId = roomId.toUpperCase().trim();
    const room = getRoom(normalizedId);
    if (!room) {
      socket.emit('error', { message: '房间不存在' });
      return;
    }

    const player = room.players.find(p => p.nickname === nickname.trim());
    if (!player) {
      socket.emit('error', { message: '无法加入游戏' });
      return;
    }

    const wasDisconnected = player._disconnected;
    const prevSocketId = player.id;
    // 更新发言顺序中的 socket ID（谁是卧底模式）
    if (room.describeOrder) {
      const idx = room.describeOrder.indexOf(prevSocketId);
      if (idx !== -1) room.describeOrder[idx] = socket.id;
    }
    // 更新卧底 ID（如果该玩家是卧底）
    if (room.undercoverPlayerId === prevSocketId) {
      room.undercoverPlayerId = socket.id;
    }
    // 更新 playerWords 的 key（谁是卧底模式）
    if (room.playerWords && room.playerWords[prevSocketId] !== undefined) {
      room.playerWords[socket.id] = room.playerWords[prevSocketId];
      delete room.playerWords[prevSocketId];
    }
    player.id = socket.id;
    player._disconnected = false;
    if (player._disconnectTimer) {
      clearTimeout(player._disconnectTimer);
      player._disconnectTimer = null;
    }

    const hasActiveHost = room.players.some(p => !p._disconnected && p.isHost);
    if (!hasActiveHost) {
      player.isHost = true;
    }
    if (player.isHost) {
      room.ownerSocketId = socket.id;
    }
    socket.join(room.id);
    console.log(`[游戏加入] ${player.nickname} ${wasDisconnected ? '(重连)' : '(首次进入)'} room ${room.id}`);

    // 构建玩家列表
    const activePlayers = getActivePlayers(room);
    const allPlayers = activePlayers.map(p => ({
      id: p.id, nickname: p.gameName || p.nickname, avatar: p.avatar,
      gameNumber: p.gameNumber, gameColor: p.gameColor, gameEmoji: p.gameEmoji,
    }));
    if (room.aiPlayer) {
      allPlayers.push({
        id: room.aiPlayer.id,
        nickname: room.aiPlayer.gameName || room.aiPlayer.nickname,
        avatar: room.aiPlayer.avatar,
        gameNumber: room.aiPlayer.gameNumber,
        gameColor: room.aiPlayer.gameColor,
        gameEmoji: room.aiPlayer.gameEmoji,
      });
    }

    socket.emit('game_started', {
      players: allPlayers,
      mode: room.mode || 'chat',
      totalPlayers: allPlayers.length,
    });

    // 谁是卧底模式：发送个人的词
    if (room.mode === 'undercover' && room.playerWords) {
      const myWord = room.playerWords[prevSocketId] || room.playerWords[socket.id];
      if (myWord) {
        socket.emit('word_assigned', { word: myWord, wordPair: null });
      }
    }

    // 回放最近的聊天记录
    const recentMsgs = room.chatHistory.slice(-50);
    recentMsgs.forEach(msg => {
      socket.emit('chat_message', msg);
    });

    // 根据当前状态发送事件
    if (room.state === 'ROUND_DESCRIBE' && room.mode === 'undercover') {
      // 正在轮流描述中
      const eliminated = room.eliminatedPlayers || [];
      socket.emit('round_started', {
        round: room.describeRound,
        mode: 'undercover',
        totalInRound: allPlayers.length - eliminated.length,
        label: `第 ${room.describeRound} 轮描述`,
      });
      // 通知当前轮到谁
      if (room.describeIndex < (room.describeOrder || []).length) {
        const currentId = room.describeOrder[room.describeIndex];
        const display = getPlayerDisplayStatic(room, currentId);
        socket.emit('turn_start', {
          playerId: currentId,
          playerName: display.name,
          playerAvatar: display.avatar,
          gameNumber: display.gameNumber,
          gameColor: display.gameColor,
          index: room.describeIndex + 1,
          total: room.describeOrder.length,
          duration: 30000,
          subRound: room.subRound,
        });
      }
    } else if (room.state === 'ROUND_VOTE') {
      socket.emit('vote_start', {
        candidates: getVoteCandidates(room),
        duration: 30000,
        type: 'eliminate',
        round: room.describeRound,
      });
      socket.emit('vote_update', {
        voted: room.votes.length,
        total: activePlayers.length,
      });
    } else if (room.state === 'FINAL_AI_VOTE') {
      socket.emit('vote_start', {
        candidates: getAllCandidates(room),
        duration: 30000,
        type: 'final_ai',
        label: '🤖 谁是 AI？',
      });
      socket.emit('vote_update', {
        voted: room.votes.length,
        total: activePlayers.length,
      });
    } else if (room.state === 'RESULT') {
      // 结果阶段，等待自动回到等待室
    } else if (room.state && room.state.startsWith('ROUND_') && room.mode === 'chat') {
      socket.emit('round_started', {
        round: room.currentRound,
        topic: room.currentRound === 1 ? room.topic : null,
        duration: 120000,
      });
    } else if (room.state && (room.state.startsWith('VOTE_') || room.state === 'FINAL_VOTE') && room.mode !== 'undercover') {
      socket.emit('round_ended', { round: room.currentRound });
      socket.emit('vote_start', {
        candidates: allPlayers,
        duration: 30000,
        isFinal: room.state === 'FINAL_VOTE',
      });
      socket.emit('vote_update', {
        voted: room.votes.length,
        total: activePlayers.length,
      });
    }
  });

  // --- 描述提交（谁是卧底） ---
  socket.on('describe_done', ({ content }) => {
    const room = getRoomBySocketId(socket.id);
    if (!room || room.mode !== 'undercover') return;

    handleDescribe(room, socket.id, content, io);
  });

  // --- 聊天消息（自由聊天模式） ---
  socket.on('chat_message', ({ content }) => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;
    if (!room.state.startsWith('ROUND_')) return;
    if (!content || !content.trim()) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const displayName = player.gameName || player.nickname;

    const msg = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      senderId: socket.id,
      senderName: displayName,
      senderGameName: displayName,
      senderAvatar: player.avatar,
      content: content.trim().slice(0, 500),
      timestamp: Date.now(),
    };

    room.chatHistory.push(msg);
    io.to(room.id).emit('chat_message', msg);
  });

  // --- 发起投票（谁是卧底模式中提前投票） ---
  socket.on('call_vote', () => {
    const room = getRoomBySocketId(socket.id);
    if (!room || room.mode !== 'undercover') return;
    callVote(room, socket.id, io);
  });

  // --- 投票 ---
  socket.on('vote', ({ targetId }) => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;

    if (room.mode === 'undercover') {
      if (room.state === 'ROUND_VOTE') {
        handleEliminationVote(room, socket.id, targetId || null, io);
      } else if (room.state === 'FINAL_AI_VOTE') {
        handleFinalAiVote(room, socket.id, targetId || null, io);
      }
    } else {
      handleVote(room, socket.id, targetId || null, io);
    }
  });

  // --- 断线 ---
  socket.on('disconnect', () => {
    console.log(`[断开] ${socket.id}`);

    const result = leaveRoom(socket.id);
    if (!result) return;

    const { room, player, wasOwner } = result;
    if (!room || !player) return;

    io.to(room.id).emit('player_disconnected', {
      playerId: socket.id,
      playerName: player.nickname,
    });

    const disconnectTimer = setTimeout(() => {
      const currentPlayer = room.players.find(p => p.id === socket.id);
      if (!currentPlayer || !currentPlayer._disconnected) return;

      const removeResult = removePlayer(room, socket.id);
      if (!removeResult) return;

      console.log(`[离开] ${removeResult.playerName} 彻底断开 (room ${room.id})`);

      if (removeResult.roomEmpty) {
        console.log('[房间] 已清空（所有活跃玩家均离开）');
      } else {
        io.to(room.id).emit('player_left', {
          playerId: socket.id,
          playerName: removeResult.playerName,
        });

        if (removeResult.wasOwner) {
          const newOwner = room.players.find(p => p.isHost && !p._disconnected);
          if (newOwner) {
            io.to(newOwner.id).emit('you_are_host');
          }
        }
      }
    }, 30000);

    player._disconnectTimer = disconnectTimer;

    if (wasOwner) {
      transferHost(room);
      const newOwner = room.players.find(p => p.isHost && !p._disconnected);
      if (newOwner) {
        io.to(newOwner.id).emit('you_are_host');
      }
    }
  });
});

// ===== 辅助函数 =====

function getPlayerDisplayStatic(room, playerId) {
  if (playerId === 'ai-player' && room.aiPlayer) {
    return {
      name: room.aiPlayer.gameName || room.aiPlayer.nickname, avatar: room.aiPlayer.avatar,
      gameNumber: room.aiPlayer.gameNumber, gameColor: room.aiPlayer.gameColor,
    };
  }
  const p = room.players.find(p => p.id === playerId);
  if (p) return {
    name: p.gameName || p.nickname, avatar: p.avatar,
    gameNumber: p.gameNumber, gameColor: p.gameColor,
  };
  return { name: '未知', avatar: '❓' };
}

function getPlayerInfo(room, playerId) {
  if (playerId === 'ai-player' && room.aiPlayer) {
    return {
      name: room.aiPlayer.gameName || room.aiPlayer.nickname,
      avatar: room.aiPlayer.avatar,
      gameNumber: room.aiPlayer.gameNumber,
      gameColor: room.aiPlayer.gameColor,
    };
  }
  const p = room.players.find(p => p.id === playerId);
  if (p) return {
    name: p.gameName || p.nickname,
    avatar: p.avatar,
    gameNumber: p.gameNumber,
    gameColor: p.gameColor,
  };
  return { name: '未知', avatar: '❓' };
}

function getVoteCandidates(room) {
  const eliminated = room.eliminatedPlayers || [];
  const activeIds = room.players.filter(p => !p._disconnected).map(p => p.id);
  if (room.aiPlayer) activeIds.push(room.aiPlayer.id);
  return activeIds
    .filter(id => !eliminated.includes(id))
    .map(id => {
      const info = getPlayerInfo(room, id);
      return {
        id,
        nickname: info.name,
        avatar: info.avatar,
        gameNumber: info.gameNumber,
        gameColor: info.gameColor,
      };
    });
}

function getAllCandidates(room) {
  const ids = room.players.filter(p => !p._disconnected).map(p => p.id);
  if (room.aiPlayer) ids.push(room.aiPlayer.id);
  return ids.map(id => {
    const info = getPlayerInfo(room, id);
    return {
      id,
      nickname: info.name,
      avatar: info.avatar,
      gameNumber: info.gameNumber,
      gameColor: info.gameColor,
    };
  });
}

// ===== 启动 =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 服务器已启动: http://localhost:${PORT}`);
});
