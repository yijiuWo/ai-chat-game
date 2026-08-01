// src/undercover.js
// 谁是卧底 × AI 游戏逻辑
const { generateReply } = require('./ai');
const { getWordPair } = require('./words');
const { clearTimers } = require('./room');

const DESCRIBE_DURATION = 30000;      // 每人 30 秒
const VOTE_DURATION = 30000;          // 投票 30 秒
const RESULT_DURATION = 12000;        // 结果展示 12 秒
const SUBROUNDS_BEFORE_VOTE = 3;      // 3 轮描述后自动投票
const CALL_VOTE_COUNTDOWN = 3000;     // 发起投票倒计时 3 秒
const AI_DESCRIBE_MAX_LEN = 15;       // AI 描述最多 15 字
// 中文 + ASCII 常见标点，AI 描述里一律剥掉
const PUNCT_RE = /[，。！？；：、…—·～「」『』（）《》〈〉【】〔〕“”‘’"'.,!?;:'`~\-_]/g;

// 玩家编号颜色：①蓝 ②红 ③绿 ④金 ⑤紫
const PLAYER_COLORS = [
  { number: 1, color: '#3b82f6', name: '蓝', emoji: '🔵' },
  { number: 2, color: '#ef4444', name: '红', emoji: '🔴' },
  { number: 3, color: '#22c55e', name: '绿', emoji: '🟢' },
  { number: 4, color: '#f59e0b', name: '金', emoji: '🟡' },
  { number: 5, color: '#a855f7', name: '紫', emoji: '🟣' },
];

/**
 * 启动谁是卧底
 */
async function startUndercover(room, io) {
  const wordPair = await getWordPair(false, async (prompt) => {
    return generateReply(prompt, '');
  });
  room.wordPair = wordPair;
  room.mode = 'undercover';
  room.eliminatedPlayers = [];
  room.subRound = 1;
  room.voteRound = 1;

  console.log(`[卧底] ${room.id} 词对: ${wordPair.civilian} / ${wordPair.undercover} (${wordPair.source})`);

  // 分配玩家编号（彩色圆圈 ①~⑤）
  const activePlayers = room.players.filter(p => !p._disconnected);
  const totalNeeded = activePlayers.length + 1;
  const shuffledNumbers = shuffleArray([0, 1, 2, 3, 4]).slice(0, totalNeeded);

  activePlayers.forEach((p, i) => {
    const c = PLAYER_COLORS[shuffledNumbers[i]];
    p.gameName = c.name + c.number + '号';
    p.gameNumber = c.number;
    p.gameColor = c.color;
    p.gameEmoji = c.emoji;
  });

  // AI 也分配编号
  const aiColor = PLAYER_COLORS[shuffledNumbers[shuffledNumbers.length - 1]];
  room.aiPlayer = {
    id: 'ai-player',
    gameName: aiColor.name + aiColor.number + '号',
    gameNumber: aiColor.number,
    gameColor: aiColor.color,
    gameEmoji: aiColor.emoji,
    nickname: aiColor.name + aiColor.number + '号',
    avatar: aiColor.emoji,
  };

  // 随机选卧底
  const allPlayerIds = [...activePlayers.map(p => p.id), room.aiPlayer.id];
  room.undercoverPlayerId = allPlayerIds[Math.floor(Math.random() * allPlayerIds.length)];

  // 分配词语
  room.playerWords = {};
  allPlayerIds.forEach(id => {
    room.playerWords[id] = (id === room.undercoverPlayerId)
      ? wordPair.undercover : wordPair.civilian;
  });

  console.log(`[卧底] ${room.id} 卧底: ${getPlayerDisplay(room, room.undercoverPlayerId).name}`);

  // 通知每个真人他们的词
  room.players.forEach(p => {
    if (!p._disconnected && p.id !== 'ai-player') {
      io.to(p.id).emit('word_assigned', { word: room.playerWords[p.id] });
    }
  });

  const allPlayers = buildPlayerList(room, activePlayers);
  io.to(room.id).emit('game_started', {
    players: allPlayers, mode: 'undercover', totalPlayers: allPlayers.length,
  });

  room.state = 'ROUND_DESCRIBE';
  startSubRound(room, io);
}

/**
 * 开始一轮描述（subRound: 1-3）
 */
function startSubRound(room, io) {
  room.chatHistory = room.chatHistory || [];
  room._voteCallInProgress = false;
  if (room._callVoteTimer) { clearTimeout(room._callVoteTimer); room._callVoteTimer = null; }
  const activeIds = getAllActiveIds(room).filter(id => !room.eliminatedPlayers.includes(id));
  // 首轮首次需要等待玩家从 room.html 跳转过来
  const isFirstEver = room.subRound === 1 && room.voteRound === 1;

  const label = `第 ${room.voteRound} 回合 · 第 ${room.subRound}/${SUBROUNDS_BEFORE_VOTE} 轮`;
  io.to(room.id).emit('round_started', {
    round: room.subRound,
    voteRound: room.voteRound,
    mode: 'undercover',
    totalInRound: activeIds.length,
    label,
  });

  const delay = isFirstEver ? 5000 : 1200;
  setTimeout(() => {
    if (room.subRound > SUBROUNDS_BEFORE_VOTE || !room.state.startsWith('ROUND_')) return;
    const ids = getAllActiveIds(room).filter(id => !room.eliminatedPlayers.includes(id));
    room.describeOrder = shuffleArray(ids);
    room.describeIndex = 0;
    nextTurn(room, io);
  }, delay);
}

/**
 * 推进到下一个发言者
 */
function nextTurn(room, io) {
  if (!room.state.startsWith('ROUND_')) return;

  if (room.describeIndex >= room.describeOrder.length) {
    finishSubRound(room, io);
    return;
  }

  const currentId = room.describeOrder[room.describeIndex];
  const display = getPlayerDisplay(room, currentId);

  io.to(room.id).emit('turn_start', {
    playerId: currentId,
    playerName: display.name,
    playerAvatar: display.avatar,
    gameNumber: display.gameNumber,
    gameColor: display.gameColor,
    index: room.describeIndex + 1,
    total: room.describeOrder.length,
    duration: DESCRIBE_DURATION,
    subRound: room.subRound,
  });

  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    const skipped = getPlayerDisplay(room, currentId);
    io.to(room.id).emit('turn_end', { playerId: currentId, playerName: skipped.name, reason: 'timeout' });
    io.to(room.id).emit('chat_message', {
      id: 'sys-' + Date.now(), senderId: 'system', senderName: '系统', senderAvatar: '⏰',
      content: `${skipped.avatar} ${skipped.name} 超时未发言，自动跳过`,
      timestamp: Date.now(), isSystem: true,
    });
    room.describeIndex++;
    nextTurn(room, io);
  }, DESCRIBE_DURATION);

  if (currentId === 'ai-player') {
    aiDescribe(room, io);
  }
}

/**
 * AI 描述自己的词
 */
async function aiDescribe(room, io) {
  const word = room.playerWords['ai-player'];
  const aiName = room.aiPlayer.gameName;

  const prompt = `你正在玩"谁是卧底"游戏。你的名字是【${aiName}】。你的词语是：【${word}】。

这是第 ${room.subRound} 轮描述（共 3 轮）。请用一句很短的话描述这个词：
- 不能直接说出这个词
- 描述要模糊但合理，像真人随口说的
- 不要使用任何标点符号（句号、逗号、问号、省略号等一律不用）
- 控制在 10-15 个字以内，越短越好
- 第1轮给模糊线索，第2-3轮可以稍微具体一点`;

  let description = '';
  try {
    description = sanitizeDescription(await generateReply(prompt, ''));
  } catch { description = ''; }
  if (!description) description = '这个挺常见的';

  if (room.turnTimer) clearTimeout(room.turnTimer);

  const msg = {
    id: 'desc-' + Date.now(), senderId: 'ai-player',
    senderName: aiName, senderAvatar: room.aiPlayer.avatar,
    senderGameNumber: room.aiPlayer.gameNumber, senderGameColor: room.aiPlayer.gameColor,
    content: description || '嗯...我描述的话，就是那种很常见的东西',
    timestamp: Date.now(), isDescription: true,
  };
  room.chatHistory.push(msg);
  io.to(room.id).emit('chat_message', msg);
  io.to(room.id).emit('turn_end', { playerId: 'ai-player', playerName: aiName, reason: 'done' });

  room.describeIndex++;
  setTimeout(() => nextTurn(room, io), 800);
}

/**
 * 处理真人玩家描述
 */
function handleDescribe(room, socketId, content, io) {
  if (!room.state.startsWith('ROUND_')) return;
  const currentId = room.describeOrder[room.describeIndex];
  if (currentId !== socketId) return;
  if (!content || !content.trim()) return;

  const player = room.players.find(p => p.id === socketId);
  if (!player) return;

  if (room.turnTimer) clearTimeout(room.turnTimer);

  const displayName = player.gameName || player.nickname;
  const msg = {
    id: 'desc-' + Date.now(), senderId: socketId,
    senderName: displayName, senderAvatar: player.gameEmoji || player.avatar,
    senderGameNumber: player.gameNumber, senderGameColor: player.gameColor,
    content: content.trim().slice(0, 200),
    timestamp: Date.now(), isDescription: true,
  };
  room.chatHistory.push(msg);
  io.to(room.id).emit('chat_message', msg);
  io.to(room.id).emit('turn_end', { playerId: socketId, playerName: displayName, reason: 'done' });

  room.describeIndex++;
  setTimeout(() => nextTurn(room, io), 600);
}

/**
 * 一轮描述结束 → 判断是否投票
 */
function finishSubRound(room, io) {
  if (room.subRound >= SUBROUNDS_BEFORE_VOTE) {
    // 3 轮描述完成，自动进入投票
    io.to(room.id).emit('chat_message', {
      id: 'sys-' + Date.now(), senderId: 'system', senderName: '系统', senderAvatar: '🗳️',
      content: `${SUBROUNDS_BEFORE_VOTE} 轮描述完成，进入投票！`,
      timestamp: Date.now(), isSystem: true,
    });
    setTimeout(() => startEliminationVote(room, io), 1000);
  } else {
    // 继续下一轮描述
    room.subRound++;
    io.to(room.id).emit('chat_message', {
      id: 'sys-' + Date.now(), senderId: 'system', senderName: '系统', senderAvatar: '📢',
      content: `进入第 ${room.subRound}/${SUBROUNDS_BEFORE_VOTE} 轮描述`,
      timestamp: Date.now(), isSystem: true,
    });
    setTimeout(() => startSubRound(room, io), 1500);
  }
}

/**
 * 玩家主动发起投票（提前投票）
 */
function callVote(room, socketId, io) {
  if (!room.state.startsWith('ROUND_')) return;
  if (room.subRound < 2) {
    io.to(socketId).emit('error', { message: '至少完成 1 轮描述后才能发起投票' });
    return;
  }
  // 本轮已有人发起过投票
  if (room._voteCallInProgress) {
    io.to(socketId).emit('error', { message: '已经有人发起投票了，请等待' });
    return;
  }

  const player = room.players.find(p => p.id === socketId);
  const name = player ? (player.gameName || player.nickname) : '有人';

  room._voteCallInProgress = true;

  // 停止当前发言
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  io.to(room.id).emit('turn_end', { playerId: null, playerName: '', reason: 'vote_called' });

  // 广播倒计时
  io.to(room.id).emit('call_vote_started', {
    caller: name,
    callerId: socketId,
    countdown: CALL_VOTE_COUNTDOWN,
  });
  io.to(room.id).emit('chat_message', {
    id: 'sys-' + Date.now(), senderId: 'system', senderName: '系统', senderAvatar: '🗳️',
    content: `${name} 发起了投票！${CALL_VOTE_COUNTDOWN / 1000} 秒后开始...`,
    timestamp: Date.now(), isSystem: true,
  });

  // 3 秒后进入投票
  room._callVoteTimer = setTimeout(() => {
    room._voteCallInProgress = false;
    startEliminationVote(room, io);
  }, CALL_VOTE_COUNTDOWN);
}

/**
 * 淘汰投票
 */
function startEliminationVote(room, io) {
  room.state = 'ROUND_VOTE';
  room.votes = [];
  room._voteRound = room.voteRound;
  room._voteCallInProgress = false;
  if (room._callVoteTimer) { clearTimeout(room._callVoteTimer); room._callVoteTimer = null; }

  const activeIds = getAllActiveIds(room).filter(id => !room.eliminatedPlayers.includes(id));
  const candidates = activeIds.map(id => {
    const d = getPlayerDisplay(room, id);
    return { id, nickname: d.name, avatar: d.avatar, gameNumber: d.gameNumber, gameColor: d.gameColor };
  });

  io.to(room.id).emit('vote_start', {
    candidates, duration: VOTE_DURATION, type: 'eliminate', round: room.voteRound,
  });

  let remaining = VOTE_DURATION / 1000;
  room.voteTimer = setInterval(() => {
    remaining--;
    io.to(room.id).emit('vote_tick', { remaining });
    if (remaining <= 0) { clearInterval(room.voteTimer); room.voteTimer = null; finishEliminationVote(room, io); }
  }, 1000);
}

function handleEliminationVote(room, voterId, targetId, io) {
  if (room.state !== 'ROUND_VOTE') return;
  const { castVote, allVoted } = require('./vote');
  const result = castVote(room, voterId, targetId, room.voteRound);
  if (!result.success) return;

  const activeHumans = room.players.filter(p => !p._disconnected && p.id !== 'ai-player');
  io.to(room.id).emit('vote_update', { voted: room.votes.length, total: activeHumans.length });

  if (allVoted(room)) { clearInterval(room.voteTimer); room.voteTimer = null; finishEliminationVote(room, io); }
}

function finishEliminationVote(room, io) {
  if (room.voteTimer) { clearInterval(room.voteTimer); room.voteTimer = null; }
  const { tallyVotes } = require('./vote');
  const results = tallyVotes(room);

  let maxVotes = 0, topTargets = [];
  results.forEach(r => {
    if (r.votes > maxVotes) { maxVotes = r.votes; topTargets = [r]; }
    else if (r.votes === maxVotes && maxVotes > 0) topTargets.push(r);
  });

  let eliminated;
  if (topTargets.length === 1 && maxVotes > 0) {
    eliminated = topTargets[0];
    room.eliminatedPlayers.push(eliminated.targetId);
  } else {
    eliminated = null;
  }

  const wasUndercover = eliminated && eliminated.targetId === room.undercoverPlayerId;
  const remainingCount = getAllActiveIds(room).filter(id => !room.eliminatedPlayers.includes(id)).length;

  let gameOver = false, winner = null;
  if (wasUndercover) { gameOver = true; winner = 'civilian'; }
  else if (remainingCount <= 2 && !room.eliminatedPlayers.includes(room.undercoverPlayerId)) {
    gameOver = true; winner = 'undercover';
  }

  const eliminatedDisplay = eliminated
    ? { id: eliminated.targetId, name: eliminated.targetName, avatar: eliminated.targetAvatar, gameNumber: eliminated.gameNumber, gameColor: eliminated.gameColor, votes: eliminated.votes }
    : null;

  io.to(room.id).emit('eliminate_result', {
    eliminated: eliminatedDisplay, wasUndercover, gameOver, winner, remainingCount,
    results: results.map(r => ({ name: r.targetName, avatar: r.targetAvatar, gameNumber: r.gameNumber, gameColor: r.gameColor, votes: r.votes })),
  });

  if (gameOver) {
    setTimeout(() => startFinalAiVote(room, io), 4000);
  } else {
    room.voteRound++;
    room.subRound = 1;
    room.state = 'ROUND_DESCRIBE';
    setTimeout(() => startSubRound(room, io), 5000);
  }
}

/**
 * 最终猜 AI
 */
function startFinalAiVote(room, io) {
  room.state = 'FINAL_AI_VOTE';
  room.votes = [];
  room._voteRound = 999;

  const candidates = getAllActiveIds(room).map(id => {
    const d = getPlayerDisplay(room, id);
    return { id, nickname: d.name, avatar: d.avatar, gameNumber: d.gameNumber, gameColor: d.gameColor };
  });

  io.to(room.id).emit('vote_start', {
    candidates, duration: VOTE_DURATION, type: 'final_ai', label: '🤖 谁是 AI？',
  });

  let remaining = VOTE_DURATION / 1000;
  room.voteTimer = setInterval(() => {
    remaining--;
    io.to(room.id).emit('vote_tick', { remaining });
    if (remaining <= 0) { clearInterval(room.voteTimer); room.voteTimer = null; revealAi(room, io); }
  }, 1000);
}

function handleFinalAiVote(room, voterId, targetId, io) {
  if (room.state !== 'FINAL_AI_VOTE') return;
  const { castVote, allVoted } = require('./vote');
  const result = castVote(room, voterId, targetId, 999);
  if (!result.success) return;

  const activeHumans = room.players.filter(p => !p._disconnected && p.id !== 'ai-player');
  io.to(room.id).emit('vote_update', { voted: room.votes.length, total: activeHumans.length });

  if (allVoted(room)) { clearInterval(room.voteTimer); room.voteTimer = null; revealAi(room, io); }
}

function revealAi(room, io) {
  if (room.voteTimer) { clearInterval(room.voteTimer); room.voteTimer = null; }
  const { tallyVotes } = require('./vote');
  const results = tallyVotes(room);

  let maxVotes = 0, topTarget = null;
  results.forEach(r => { if (r.votes > maxVotes) { maxVotes = r.votes; topTarget = r; } });

  const guessedCorrectly = topTarget && topTarget.targetId === room.aiPlayer.id;

  io.to(room.id).emit('ai_reveal', {
    aiPlayer: { id: room.aiPlayer.id, name: room.aiPlayer.gameName, avatar: room.aiPlayer.avatar, realName: 'AI' },
    undercoverPlayer: {
      id: room.undercoverPlayerId,
      name: getPlayerDisplay(room, room.undercoverPlayerId).name,
      avatar: getPlayerDisplay(room, room.undercoverPlayerId).avatar,
      realName: getRealNickname(room, room.undercoverPlayerId),
    },
    wordPair: { civilian: room.wordPair.civilian, undercover: room.wordPair.undercover },
    guessedCorrectly,
    topTarget: topTarget ? { name: topTarget.targetName, votes: topTarget.votes } : null,
    results: results.map(r => ({
      id: r.targetId, name: r.targetName, avatar: r.targetAvatar,
      gameNumber: r.gameNumber, gameColor: r.gameColor, votes: r.votes,
      realName: getRealNickname(room, r.targetId),
    })),
  });

  // 立即重置房间状态
  clearTimers(room);
  room.state = 'WAITING';
  room.subRound = 0;
  room.voteRound = 0;
  room.wordPair = null;
  room.undercoverPlayerId = null;
  room.playerWords = null;
  room.eliminatedPlayers = [];
  room.chatHistory = [];
  room.votes = [];
  room.describeOrder = [];
  room.describeIndex = 0;
  room.mode = null;

  room.players.forEach(p => { p.isReady = false; delete p.gameName; delete p.gameNumber; delete p.gameColor; delete p.gameEmoji; delete p.gameAvatar; });

  // ★ 确保游戏结束后始终有人是房主
  const hasHost = room.players.some(p => p.isHost);
  if (!hasHost) {
    const first = room.players[0];
    if (first) { first.isHost = true; room.ownerSocketId = first.id; }
  }

  room.resultTimer = setTimeout(() => {
    room.aiPlayer = null;
    io.to(room.id).emit('back_to_lobby');
  }, RESULT_DURATION);
}

// ===== Helpers =====
function shuffleArray(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

function getPlayerDisplay(room, playerId) {
  if (playerId === 'ai-player' && room.aiPlayer) return {
    name: room.aiPlayer.gameName || room.aiPlayer.nickname, avatar: room.aiPlayer.avatar,
    gameNumber: room.aiPlayer.gameNumber, gameColor: room.aiPlayer.gameColor,
  };
  const p = room.players.find(p => p.id === playerId);
  if (p) return {
    name: p.gameName || p.nickname, avatar: p.avatar,
    gameNumber: p.gameNumber, gameColor: p.gameColor,
  };
  return { name: '未知', avatar: '❓' };
}

/**
 * 清洗 AI 描述：去掉所有标点、合并空白、限制字数
 * @param {string} text
 * @param {number} maxLen - 最大字数
 * @returns {string}
 */
function sanitizeDescription(text, maxLen = AI_DESCRIBE_MAX_LEN) {
  if (!text) return '';
  return text.replace(PUNCT_RE, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * 取玩家填写的真实昵称（AI 返回 'AI'）
 * @param {object} room
 * @param {string} playerId
 * @returns {string}
 */
function getRealNickname(room, playerId) {
  if (playerId === 'ai-player') return 'AI';
  const p = room.players.find(p => p.id === playerId);
  return p ? (p.nickname || '') : '';
}

function getAllActiveIds(room) {
  const ids = room.players.filter(p => !p._disconnected).map(p => p.id);
  if (room.aiPlayer) ids.push(room.aiPlayer.id);
  return ids;
}

function buildPlayerList(room, activePlayers) {
  const list = activePlayers.map(p => ({
    id: p.id, nickname: p.gameName || p.nickname, avatar: p.avatar,
    gameNumber: p.gameNumber, gameColor: p.gameColor, gameEmoji: p.gameEmoji,
  }));
  if (room.aiPlayer) list.push({
    id: room.aiPlayer.id, nickname: room.aiPlayer.gameName || room.aiPlayer.nickname, avatar: room.aiPlayer.avatar,
    gameNumber: room.aiPlayer.gameNumber, gameColor: room.aiPlayer.gameColor, gameEmoji: room.aiPlayer.gameEmoji,
  });
  return list;
}

module.exports = {
  startUndercover, handleDescribe, handleEliminationVote, handleFinalAiVote, callVote,
};
