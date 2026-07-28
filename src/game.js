// src/game.js
const { getRandomTopic } = require('./topics');
const { buildSystemPrompt, formatChatHistory, getTypingDelay, pickPersonality, pickGameNames } = require('./prompt');
const { generateReply } = require('./ai');
const { initVote, castVote, allVoted, tallyVotes, determineWinner } = require('./vote');
const { AI_AVATARS, clearTimers } = require('./room');

const ROUND_DURATION = 120000;  // 2 minutes
const VOTE_DURATION = 30000;    // 30 seconds
const RESULT_DURATION = 10000;  // 10 seconds

/**
 * Start the game
 * @param {object} room
 * @param {object} io - Socket.IO Server
 */
function startGame(room, io) {
  // 随机选择 AI 性格
  room.aiPersonality = pickPersonality();
  console.log(`[AI性格] ${room.aiPersonality.label}`);

  // 给所有人（含 AI）分配随机游戏匿名
  const activePlayers = room.players.filter(p => !p._disconnected);
  const totalNeeded = activePlayers.length + 1; // +1 for AI
  const gameNames = pickGameNames(totalNeeded);

  // 真人玩家分配匿名
  activePlayers.forEach((p, i) => {
    p.gameName = gameNames[i];
    p.gameAvatar = p.avatar; // 头像保留
  });

  // AI 分配匿名和头像
  const aiAvatar = AI_AVATARS[Math.floor(Math.random() * AI_AVATARS.length)];
  room.aiPlayer = {
    id: 'ai-player',
    gameName: gameNames[gameNames.length - 1],
    avatar: aiAvatar,
  };
  // 保存一份 nickname 给内部用（日志等）
  room.aiPlayer.nickname = room.aiPlayer.gameName;

  room.topic = getRandomTopic();
  room.chatHistory = [];
  room.currentRound = 1;
  room.state = 'ROUND_1';

  // 发给所有人的玩家列表（用游戏匿名）
  const allPlayers = [
    ...activePlayers.map(p => ({
      id: p.id,
      nickname: p.gameName,
      avatar: p.avatar,
    })),
    { id: room.aiPlayer.id, nickname: room.aiPlayer.gameName, avatar: room.aiPlayer.avatar },
  ];

  io.to(room.id).emit('game_started', { players: allPlayers });
  startRound(room, io);
}

/**
 * Start a chat round
 * @param {object} room
 * @param {object} io
 */
function startRound(room, io) {
  const topic = room.currentRound === 1 ? room.topic : null;

  io.to(room.id).emit('round_started', {
    round: room.currentRound,
    topic,
    duration: ROUND_DURATION,
  });

  if (topic) {
    const systemMsg = {
      id: 'system-topic',
      senderId: 'system',
      senderName: '系统',
      senderAvatar: '📢',
      content: `💬 本轮话题：${topic}`,
      timestamp: Date.now(),
      isSystem: true,
    };
    room.chatHistory.push(systemMsg);
    io.to(room.id).emit('chat_message', systemMsg);
  }

  let remaining = ROUND_DURATION / 1000;
  room.roundTimer = setInterval(() => {
    remaining--;

    if (remaining === 30 || remaining === 10) {
      io.to(room.id).emit('chat_message', {
        id: 'sys-' + Date.now(),
        senderId: 'system',
        senderName: '系统',
        senderAvatar: '⏰',
        content: `剩余 ${remaining} 秒`,
        timestamp: Date.now(),
        isSystem: true,
      });
    }

    if (remaining <= 0) {
      clearInterval(room.roundTimer);
      room.roundTimer = null;
      endRound(room, io);
    }
  }, 1000);

  scheduleAiSpeak(room, io);
}

/**
 * Schedule AI to speak at appropriate times
 * Personality-specific intervals
 * @param {object} room
 * @param {object} io
 */
function scheduleAiSpeak(room, io) {
  if (!room.state.startsWith('ROUND_')) return;

  const personality = room.aiPersonality || { minInterval: 3000, maxInterval: 6000 };

  const lastHumanMsg = [...room.chatHistory].reverse().find(
    m => m.senderId !== 'ai-player' && !m.isSystem
  );
  const timeSinceLastHuman = lastHumanMsg ? Date.now() - lastHumanMsg.timestamp : Infinity;
  const timeSinceAiLast = Date.now() - (room.aiLastSpeakTime || 0);

  let delay;
  if (timeSinceLastHuman > 8000 && timeSinceAiLast > personality.minInterval) {
    // 没人说话一段时间了，AI 可以开话题
    delay = personality.minInterval + Math.random() * (personality.maxInterval - personality.minInterval);
  } else if (
    room.chatHistory.filter(m => m.senderId === 'ai-player').length < 2 &&
    timeSinceAiLast > 10000
  ) {
    // AI 还没怎么发言，强制来一句
    delay = 2000 + Math.random() * 3000;
  } else {
    // 正常间隔
    delay = personality.minInterval + Math.random() * (personality.maxInterval - personality.minInterval);
  }

  room.aiSpeakTimer = setTimeout(() => {
    aiSpeak(room, io);
  }, delay);
}

/**
 * Make the AI speak
 * NOTE: No typing indicator is emitted — it would reveal the AI
 * @param {object} room
 * @param {object} io
 */
async function aiSpeak(room, io) {
  if (!room.state.startsWith('ROUND_')) return;

  const personality = room.aiPersonality || { minInterval: 3000, maxInterval: 6000, maxMessages: 5 };
  const maxMsgs = personality.maxMessages || 5;

  const aiMsgsThisRound = room.chatHistory.filter(
    m => m.senderId === 'ai-player' && m.timestamp > Date.now() - ROUND_DURATION
  );
  if (aiMsgsThisRound.length >= maxMsgs) {
    scheduleAiSpeak(room, io);
    return;
  }

  // 打字延迟（模拟思考，但不广播 typing）
  const typingDelay = getTypingDelay(personality);
  await new Promise(resolve => setTimeout(resolve, typingDelay));

  if (!room.state.startsWith('ROUND_')) return;

  const activePlayers = room.players.filter(p => !p._disconnected);
  const systemPrompt = buildSystemPrompt(
    personality,
    activePlayers.length,
    room.currentRound,
    room.topic,
    room.aiPlayer.gameName
  );
  const userPrompt = formatChatHistory(room.chatHistory);
  const replyText = await generateReply(systemPrompt, userPrompt);

  if (replyText) {
    const msg = {
      id: 'ai-' + Date.now(),
      senderId: room.aiPlayer.id,
      senderName: room.aiPlayer.gameName,
      senderGameName: room.aiPlayer.gameName,
      senderAvatar: room.aiPlayer.avatar,
      content: replyText,
      timestamp: Date.now(),
    };
    room.chatHistory.push(msg);
    room.aiLastSpeakTime = Date.now();
    io.to(room.id).emit('chat_message', msg);
  }

  scheduleAiSpeak(room, io);
}

/**
 * End current round, enter voting phase
 * @param {object} room
 * @param {object} io
 */
function endRound(room, io) {
  clearInterval(room.roundTimer);
  room.roundTimer = null;
  if (room.aiSpeakTimer) { clearTimeout(room.aiSpeakTimer); room.aiSpeakTimer = null; }

  io.to(room.id).emit('round_ended', { round: room.currentRound });

  const isLastRound = room.currentRound >= 3;
  const voteState = isLastRound ? 'FINAL_VOTE' : `VOTE_${room.currentRound}`;
  room.state = voteState;

  initVote(room, room.currentRound);

  const activePlayers = room.players.filter(p => !p._disconnected);
  const allPlayers = [
    ...activePlayers.map(p => ({
      id: p.id, nickname: p.gameName, avatar: p.avatar,
    })),
    { id: room.aiPlayer.id, nickname: room.aiPlayer.gameName, avatar: room.aiPlayer.avatar },
  ];

  io.to(room.id).emit('vote_start', {
    candidates: allPlayers,
    duration: VOTE_DURATION,
    isFinal: isLastRound,
  });

  let voteRemaining = VOTE_DURATION / 1000;
  room.roundTimer = setInterval(() => {
    voteRemaining--;
    if (voteRemaining <= 0) {
      clearInterval(room.roundTimer);
      room.roundTimer = null;
      endVote(room, io);
    }
  }, 1000);
}

/**
 * Handle a player's vote
 * @param {object} room
 * @param {string} voterId
 * @param {string|null} targetId
 * @param {object} io
 */
function handleVote(room, voterId, targetId, io) {
  if (room.state.startsWith('RESULT_') || (!room.state.startsWith('VOTE_') && room.state !== 'FINAL_VOTE')) return;

  const result = castVote(room, voterId, targetId, room.currentRound);
  if (!result.success) return;

  const activeHumans = room.players.filter(p => !p._disconnected).length;
  io.to(room.id).emit('vote_update', {
    voted: room.votes.length,
    total: activeHumans,
  });

  if (allVoted(room)) {
    clearInterval(room.roundTimer);
    room.roundTimer = null;
    endVote(room, io);
  }
}

/**
 * End voting phase
 * @param {object} room
 * @param {object} io
 */
function endVote(room, io) {
  clearInterval(room.roundTimer);
  room.roundTimer = null;

  const isFinal = room.state === 'FINAL_VOTE';

  if (isFinal) {
    const result = determineWinner(room);

    room.state = 'RESULT';

    io.to(room.id).emit('game_result', {
      winner: result.winner,
      aiPlayer: {
        nickname: room.aiPlayer.gameName,
        avatar: room.aiPlayer.avatar,
      },
      topCandidate: result.topCandidate ? {
        name: result.topCandidate.targetName,
        votes: result.topCandidate.votes,
      } : null,
      voteDetails: tallyVotes(room),
    });

    room.resultTimer = setTimeout(() => {
      resetToWaiting(room, io);
    }, RESULT_DURATION);
  } else {
    const results = tallyVotes(room);

    room.state = 'RESULT_' + room.currentRound;

    io.to(room.id).emit('suspicion_result', {
      results: results.map(r => ({
        name: r.targetName,
        avatar: r.targetAvatar,
        votes: r.votes,
      })),
    });

    room.resultTimer = setTimeout(() => {
      room.currentRound++;
      room.state = `ROUND_${room.currentRound}`;
      startRound(room, io);
    }, 5000);
  }
}

/**
 * Reset room to waiting state
 * @param {object} room
 * @param {object} io
 */
function resetToWaiting(room, io) {
  clearTimers(room);
  room.state = 'WAITING';
  room.currentRound = 0;
  room.topic = null;
  room.chatHistory = [];
  room.votes = [];
  room.aiPlayer = null;
  room.aiPersonality = null;

  // 清除游戏匿名
  room.players.forEach(p => {
    p.isReady = false;
    delete p.gameName;
    delete p.gameAvatar;
  });

  io.to(room.id).emit('back_to_lobby');
}

module.exports = { startGame, startRound, handleVote };
