// src/vote.js

/**
 * 初始化新一轮投票（清空上轮票数）
 * @param {object} room
 * @param {number} round - 当前轮次
 */
function initVote(room, round) {
  room.votes = [];
  room._voteRound = round;
}

/**
 * 记录一张投票
 * @param {object} room
 * @param {string} voterId - 投票人 socket ID
 * @param {string|null} targetId - 投给谁（null = 弃票）
 * @param {number} round - 当前轮次
 * @returns {{ success: boolean, error?: string }}
 */
function castVote(room, voterId, targetId, round) {
  // 验证轮次是否匹配
  if (room._voteRound !== round) {
    return { success: false, error: '投票轮次不匹配' };
  }

  // 验证投票人是否是真人玩家
  const voter = room.players.find(p => p.id === voterId);
  if (!voter) {
    return { success: false, error: '无效的投票人' };
  }

  // 验证投票目标（弃票允许 null）
  if (targetId !== null) {
    const validTargets = [
      ...room.players.map(p => p.id),
      room.aiPlayer ? room.aiPlayer.id : null,
    ].filter(Boolean);
    if (!validTargets.includes(targetId)) {
      return { success: false, error: '无效的投票目标' };
    }
    if (targetId === voterId) {
      return { success: false, error: '不能投票给自己' };
    }
  }

  if (room.votes.find(v => v.voterId === voterId)) {
    return { success: false, error: '你已经投过票了' };
  }

  room.votes.push({ voterId, targetId, round });
  return { success: true };
}

/**
 * 检查是否所有活跃真人都投完票
 * @param {object} room
 * @returns {boolean}
 */
function allVoted(room) {
  const activeHumans = room.players.filter(p => p.id !== 'ai-player' && !p._disconnected);
  return activeHumans.length > 0 && room.votes.length >= activeHumans.length;
}

/**
 * 统计投票结果
 * @param {object} room
 * @returns {Array<{ targetId: string|null, targetName: string, targetAvatar: string, votes: number }>}
 */
function tallyVotes(room) {
  const counts = new Map();

  for (const vote of room.votes) {
    if (vote.targetId === null) continue;
    counts.set(vote.targetId, (counts.get(vote.targetId) || 0) + 1);
  }

  const allTargets = [
    ...room.players.map(p => ({ id: p.id, name: p.gameName || p.nickname, avatar: p.avatar })),
  ];
  if (room.aiPlayer) {
    allTargets.push({ id: room.aiPlayer.id, name: room.aiPlayer.gameName || room.aiPlayer.nickname, avatar: room.aiPlayer.avatar });
  }

  return allTargets.map(t => ({
    targetId: t.id,
    targetName: t.name,
    targetAvatar: t.avatar,
    votes: counts.get(t.id) || 0,
  }));
}

/**
 * 判定最终投票的胜负
 * @param {object} room
 * @returns {{ winner: 'human'|'ai', aiPlayer: object, topCandidate: object|null }}
 */
function determineWinner(room) {
  if (!room.aiPlayer) {
    return { winner: 'ai', aiPlayer: null, topCandidate: null };
  }

  const results = tallyVotes(room);

  let maxVotes = 0;
  let topCandidates = [];

  for (const r of results) {
    if (r.votes > maxVotes) {
      maxVotes = r.votes;
      topCandidates = [r];
    } else if (r.votes === maxVotes && maxVotes > 0) {
      topCandidates.push(r);
    }
  }

  // 平票或无人投票 → AI 赢
  if (topCandidates.length !== 1 || maxVotes === 0) {
    return { winner: 'ai', aiPlayer: room.aiPlayer, topCandidate: null };
  }

  const top = topCandidates[0];

  // 得票最高的是 AI → 人类赢
  if (top.targetId === room.aiPlayer.id) {
    return { winner: 'human', aiPlayer: room.aiPlayer, topCandidate: top };
  }

  // 得票最高的是真人 → AI 赢
  return { winner: 'ai', aiPlayer: room.aiPlayer, topCandidate: top };
}

module.exports = { initVote, castVote, allVoted, tallyVotes, determineWinner };
