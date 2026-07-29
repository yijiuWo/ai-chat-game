// ============================================================================
//  client.js — "谁是卧底 × AI"  game client
// ============================================================================

// ============================================================================
//  State
// ============================================================================
const state = {
  myId: null,              // socket.id
  myWord: null,            // secret word (undercover mode)
  players: [],             // [{id, nickname, avatar, isUndercover?, isAI?}]
  mode: null,              // 'undercover' | 'chat'
  currentRound: 1,
  isMyTurn: false,         // can the local player type right now?
  isVoting: false,         // is the vote overlay open?
  selectedVoteTarget: null,// id of selected vote candidate
  currentSpeakerId: null,  // who is currently describing
  timerInterval: null,     // active countdown interval handle
};

// ============================================================================
//  DOM Refs
// ============================================================================
const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const chatArea          = $('#chat-area');
const chatInput         = $('#chat-input');
const inputBar          = $('#input-bar');
const wordBar           = $('#word-bar');
const wordBarWord       = $('#word-bar-word');
const speakerSpotlight  = $('#speaker-spotlight');
const speakerAvatar     = $('#speaker-avatar');
const speakerName       = $('#speaker-name');
const speakerHint       = $('#speaker-hint');
const timerRingFill     = $('#timer-ring-fill');
const timerRingText     = $('#timer-ring-text');
const roundLabel        = $('#round-label');
const playerCount       = $('#player-count');
const modeBadge         = $('#mode-badge');

const voteOverlay       = $('#vote-overlay');
const voteTitle         = $('#vote-title');
const voteSubtitle      = $('#vote-subtitle');
const voteTimerFill     = $('#vote-timer-fill');
const voteCandidates    = $('#vote-candidates');
const voteCountdown     = $('#vote-countdown');

const eliminateOverlay  = $('#eliminate-overlay');
const eliminateEmoji    = $('#eliminate-emoji');
const eliminateTitle    = $('#eliminate-title');
const eliminateSubtitle = $('#eliminate-subtitle');

const resultPage        = $('#result-page');
const resultEmoji       = $('#result-emoji');
const resultTitle       = $('#result-title');
const resultSubtitle    = $('#result-subtitle');
const revealAi          = $('#reveal-ai');
const revealUndercover  = $('#reveal-undercover');
const revealWords       = $('#reveal-words');
const voteBars          = $('#vote-bars');

// ============================================================================
//  Socket (bootstrapped in game.html)
// ============================================================================
const socket = window.__socket;
const bootstrap = window.__bootstrap;
const roomId    = bootstrap.roomId;
const myNickname = bootstrap.nickname;

socket.on('connect', () => {
  state.myId = socket.id;
});

// Safety rejoin after reconnect
socket.on('disconnect', () => {
  clearTimer();
  hideSpeakerSpotlight();
});

socket.on('reconnect', () => {
  socket.emit('join_game', { roomId, nickname: myNickname });
});

// ============================================================================
//  Error
// ============================================================================
socket.on('error', ({ message }) => {
  // Non-blocking toast-like display
  appendSystemMsg('⚠️ ' + escapeHtml(message));
});

// ============================================================================
//  GAME EVENTS
// ============================================================================

// ---------- game_started ----------
socket.on('game_started', (data) => {
  state.players  = data.players || [];
  state.mode     = data.mode || 'chat';
  state.myWord   = null;
  state.isMyTurn = false;
  state.isVoting = false;
  state.currentRound = 1;
  state.selectedVoteTarget = null;
  clearTimer();
  hideAllOverlays();

  // UI reset
  chatArea.innerHTML = '';
  inputBar.classList.remove('locked');
  inputBar.style.display = 'flex';
  wordBar.style.display = 'none';
  speakerSpotlight.style.display = 'none';
  resultPage.style.display = 'none';
  roundLabel.textContent = '准备中...';
  playerCount.textContent = (data.players || []).length + ' 名玩家';
  modeBadge.textContent = data.mode === 'undercover' ? ' · 谁是卧底' : ' · 自由聊天';
  chatInput.placeholder = '等待游戏开始...';
  chatInput.disabled = true;

  sessionStorage.setItem('players', JSON.stringify(data.players));

  appendSystemMsg('游戏开始！共 ' + (data.totalPlayers || data.players.length) + ' 名玩家');
  if (data.mode === 'undercover') {
    appendSystemMsg('🎭 模式：谁是卧底 — 用一句话描述你的词语，找出卧底！');
  }
});

// ---------- word_assigned (undercover) ----------
socket.on('word_assigned', ({ word }) => {
  state.myWord = word;
  wordBar.style.display = 'block';
  wordBarWord.textContent = word;
  appendSystemMsg('🔖 你的秘密词语已分配');
});

// ---------- round_started ----------
socket.on('round_started', ({ round, voteRound, mode, totalInRound, label }) => {
  state.currentRound = round;
  state.isMyTurn = false;
  clearTimer();
  hideSpeakerSpotlight();
  hideAllOverlays();
  $('#btn-call-vote').style.display = 'none';

  roundLabel.textContent = label || ('第 ' + round + ' 轮描述');
  if (totalInRound) {
    roundLabel.textContent += ' （' + totalInRound + '人）';
  }

  inputBar.style.display = 'flex';
  inputBar.classList.add('locked');
  chatInput.placeholder = '等待轮到你发言...';
  chatInput.disabled = true;

  sessionStorage.setItem('currentRound', round);

  appendSystemMsg('━━━ ' + (label || ('第 ' + round + ' 轮描述')) + ' ━━━');
});

// ---------- turn_start ----------
socket.on('turn_start', ({ playerId, playerName, playerAvatar, index, total, duration, subRound }) => {
  state.currentSpeakerId = playerId;
  state.isMyTurn = (playerId === state.myId);
  clearTimer();

  // 显示"发起投票"按钮（第2轮起可以提前投票）
  if (subRound && subRound >= 2) {
    $('#btn-call-vote').style.display = 'inline-block';
  } else {
    $('#btn-call-vote').style.display = 'none';
  }

  const avatar = playerAvatar || '🎤';
  const name   = playerName || '未知';

  // 优先用事件里的游戏编号，其次查找本地玩家列表
  const gNumber = data.gameNumber;
  const gColor = data.gameColor;
  const speakerCircle = (gNumber != null)
    ? renderPlayerCircle(gNumber, gColor, 40)
    : null;

  // Show speaker spotlight
  speakerSpotlight.style.display = 'flex';
  if (speakerCircle) {
    speakerAvatar.innerHTML = speakerCircle;
  } else {
    speakerAvatar.textContent = avatar;
  }
  if (state.isMyTurn) {
    speakerSpotlight.classList.add('my-turn');
    speakerHint.textContent = '🔥 轮到你了！用一句话描述你的词';
    // 多重提醒
    playTurnSound();
    vibrateTurn();
  } else {
    speakerSpotlight.classList.remove('my-turn');
  }
  speakerAvatar.textContent = avatar;
  speakerName.textContent = name;
  speakerHint.textContent = (index != null && total != null)
    ? '第 ' + index + '/' + total + ' 位 · 正在描述...'
    : '正在描述...';

  // Reset timer ring
  const totalSeconds = Math.ceil((duration || 30000) / 1000);
  timerRingText.textContent = totalSeconds;
  timerRingFill.style.strokeDashoffset = '0';
  timerRingFill.style.stroke = 'var(--accent)';

  // Input
  inputBar.style.display = 'flex';
  if (state.isMyTurn) {
    inputBar.classList.remove('locked');
    chatInput.disabled = false;
    chatInput.placeholder = '用一句话描述你的词（不要直接说出来！）';
    chatInput.value = '';
    chatInput.focus();
  } else {
    inputBar.classList.add('locked');
    chatInput.disabled = true;
    chatInput.placeholder = '等待 ' + name + ' 发言中...';
  }

  // Start countdown
  const durMs = duration || 30000;
  startTimer(durMs, (remainingMs) => {
    const s = Math.ceil(remainingMs / 1000);
    timerRingText.textContent = s;
    updateTimerRing(remainingMs, durMs);

    // Visual urgency under 10s
    if (s <= 10) {
      timerRingFill.style.stroke = s <= 5 ? 'var(--danger)' : 'var(--gold)';
    }
  }, () => {
    // Timeout — auto-submit if it is my turn
    if (state.isMyTurn) {
      socket.emit('describe_done', { content: '' });
      state.isMyTurn = false;
    }
    hideSpeakerSpotlight();
    inputBar.classList.add('locked');
    chatInput.disabled = true;
    chatInput.placeholder = '等待其他人发言...';
    clearTimer();
  });
});

// ---------- turn_end ----------
socket.on('turn_end', ({ playerId, playerName, reason }) => {
  state.currentSpeakerId = null;
  clearTimer();
  hideSpeakerSpotlight();
  $('#btn-call-vote').style.display = 'none';

  if (reason === 'vote_called') {
    chatInput.placeholder = '投票进行中...';
  } else {
    chatInput.placeholder = '等待下一轮发言...';
  }

  inputBar.classList.add('locked');
  chatInput.disabled = true;
  state.isMyTurn = false;
});

// ---------- chat_message ----------
socket.on('chat_message', (msg) => {
  appendMessage(msg);
});

// ---------- call_vote_started ----------
socket.on('call_vote_started', ({ caller, callerId, countdown }) => {
  clearTimer();
  hideSpeakerSpotlight();
  $('#btn-call-vote').style.display = 'none';
  inputBar.classList.add('locked');
  chatInput.disabled = true;

  // 在聊天区显示倒计时
  const countdownDiv = document.createElement('div');
  countdownDiv.className = 'msg-system';
  countdownDiv.style.cssText = 'background:rgba(239,68,68,0.15);padding:12px 16px;border-radius:8px;font-size:15px;font-weight:700;';
  countdownDiv.id = 'call-vote-countdown-msg';

  const durS = Math.ceil(countdown / 1000);
  countdownDiv.textContent = '🗳️ ' + caller + ' 发起投票 — ' + durS + ' 秒后开始...';
  chatArea.appendChild(countdownDiv);
  chatArea.scrollTop = chatArea.scrollHeight;

  // 倒计时更新
  const start = Date.now();
  const countdownTimer = setInterval(() => {
    const remaining = Math.ceil((countdown - (Date.now() - start)) / 1000);
    const el = document.getElementById('call-vote-countdown-msg');
    if (el && remaining > 0) {
      el.textContent = '🗳️ ' + caller + ' 发起投票 — ' + remaining + ' 秒后开始...';
    }
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      const el2 = document.getElementById('call-vote-countdown-msg');
      if (el2) el2.remove();
    }
  }, 300);

  chatInput.placeholder = '投票即将开始...';
});

// ---------- vote_start ----------
socket.on('vote_start', ({ candidates, duration, type, round, label }) => {
  state.isVoting = true;
  state.selectedVoteTarget = null;
  clearTimer();
  hideSpeakerSpotlight();
  inputBar.style.display = 'none';

  const isAiVote = (type === 'final_ai' || type === 'ai_guess');
  const durMs = duration || 30000;
  const durS  = Math.ceil(durMs / 1000);

  // Titles
  if (isAiVote) {
    voteTitle.textContent = '🤖 谁是 AI？';
    voteSubtitle.textContent = '最终投票 — 找出隐藏在玩家中的 AI！';
  } else {
    voteTitle.textContent = '🗳️ 投票淘汰';
    voteSubtitle.textContent = label || ('选出你认为最可疑的人（第 ' + (round || state.currentRound) + ' 轮）');
  }

  // Timer bar
  voteTimerFill.style.width = '100%';
  voteTimerFill.style.background = 'var(--gold)';
  voteCountdown.textContent = '剩余 ' + durS + ' 秒';

  // Candidates
  voteCandidates.innerHTML = '';
  (candidates || []).forEach(c => {
    if (c.id === state.myId) return; // can't vote self
    const circle = (c.gameNumber != null)
      ? renderPlayerCircle(c.gameNumber, c.gameColor, 32)
      : escapeHtml(c.avatar || '👤');
    const div = document.createElement('div');
    div.className = 'vote-candidate';
    div.innerHTML =
      '<span class="candidate-avatar">' + circle + '</span>' +
      '<span class="candidate-name">' + escapeHtml(c.nickname || c.playerName || '?') + '</span>' +
      '<span class="candidate-check">✓</span>';
    div.addEventListener('click', () => {
      $$('.vote-candidate').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      state.selectedVoteTarget = c.id;
      $('#btn-confirm-vote').disabled = false;
    });
    voteCandidates.appendChild(div);
  });

  $('#btn-confirm-vote').disabled = true;
  voteOverlay.style.display = 'flex';

  // Vote countdown
  startTimer(durMs, (remainingMs) => {
    const s = Math.ceil(remainingMs / 1000);
    voteTimerFill.style.width = Math.floor((remainingMs / durMs) * 100) + '%';
    voteCountdown.textContent = '剩余 ' + s + ' 秒';
    if (s <= 10) {
      voteTimerFill.style.background = 'var(--danger)';
    }
  }, () => {
    // Timeout → auto-skip
    socket.emit('vote', { targetId: null });
    voteOverlay.style.display = 'none';
    state.isVoting = false;
    state.selectedVoteTarget = null;
    clearTimer();
  });
});

// ---------- vote_update ----------
socket.on('vote_update', ({ voted, total }) => {
  voteCountdown.textContent = '已投票 ' + (voted || 0) + '/' + (total || 0);
});

// ---------- vote_tick ----------
socket.on('vote_tick', ({ remaining }) => {
  if (remaining != null) {
    voteCountdown.textContent = '剩余 ' + remaining + ' 秒';
  }
});

// ---------- eliminate_result ----------
socket.on('eliminate_result', ({ eliminated, wasUndercover, gameOver, winner, remainingCount, results }) => {
  voteOverlay.style.display = 'none';
  state.isVoting = false;
  state.selectedVoteTarget = null;
  clearTimer();

  const name = (eliminated && (eliminated.nickname || eliminated.name || eliminated.playerName)) || '未知';
  const avatar = (eliminated && eliminated.avatar) || '👤';

  eliminateOverlay.style.display = 'flex';
  eliminateEmoji.textContent = wasUndercover ? '🎭' : '😢';
  eliminateTitle.textContent = name + ' 被淘汰！';

  if (wasUndercover) {
    eliminateTitle.textContent = '🎉 ' + name + ' 被淘汰！';
    eliminateSubtitle.textContent = 'TA 就是卧底！';
    eliminateEmoji.textContent = '🎯';
  } else {
    eliminateSubtitle.textContent = 'TA 不是卧底...游戏继续';
  }

  // If game ended in this elimination
  if (gameOver) {
    eliminateSubtitle.textContent = (winner === 'undercover')
      ? '卧底胜利！成功隐藏到最后'
      : '平民胜利！卧底已被找到';
  }

  // Show vote bar chart in chat
  if (results && results.length) {
    appendVoteBars(results);
  }

  // Auto-dismiss elimination overlay after 3.5s
  setTimeout(() => {
    eliminateOverlay.style.display = 'none';
  }, 3500);
});

// ---------- ai_reveal ----------
socket.on('ai_reveal', ({ aiPlayer, undercoverPlayer, wordPair, guessedCorrectly, topTarget, results }) => {
  hideAllOverlays();
  clearTimer();
  inputBar.style.display = 'none';
  speakerSpotlight.style.display = 'none';
  wordBar.style.display = 'none';

  resultPage.style.display = 'block';
  resultPage.scrollIntoView({ behavior: 'smooth' });

  const aiName  = aiPlayer  ? (aiPlayer.nickname || aiPlayer.name || aiPlayer.playerName || '?') : '?';
  const aiAv    = aiPlayer  ? (aiPlayer.avatar || '🤖') : '🤖';
  const ucName  = undercoverPlayer ? (undercoverPlayer.nickname || undercoverPlayer.name || undercoverPlayer.playerName || '?') : '?';
  const ucAv    = undercoverPlayer ? (undercoverPlayer.avatar || '🎭') : '🎭';

  // Result emoji & title
  if (guessedCorrectly) {
    resultEmoji.textContent = '🎉';
    resultTitle.textContent = '人类胜利！';
    resultSubtitle.textContent = '成功找到了 AI — ' + aiName;
  } else {
    resultEmoji.textContent = '🤖';
    resultTitle.textContent = 'AI 胜利！';

    let sub = aiName + ' 成功隐藏了自己的身份';
    if (topTarget) {
      sub += '，大家误以为 ' + (topTarget.nickname || topTarget.playerName || topTarget.name || '?') + ' 是 AI';
    }
    resultSubtitle.textContent = sub;
  }

  // Reveal card
  revealAi.textContent = aiAv + ' ' + aiName;
  revealUndercover.textContent = ucAv + ' ' + ucName;

  if (wordPair) {
    const civilianWord = wordPair.civilian || wordPair.civilianWord || '?';
    const undercoverWord = wordPair.undercover || wordPair.undercoverWord || '?';
    revealWords.innerHTML =
      '<span style="color:var(--success);">' + escapeHtml(civilianWord) + '</span>' +
      ' <span style="color:var(--text-muted);">/</span> ' +
      '<span style="color:var(--danger);">' + escapeHtml(undercoverWord) + '</span>' +
      ' <span class="text-xs text-muted" style="display:block;margin-top:2px;">平民词 / 卧底词</span>';
  } else {
    revealWords.textContent = '—';
  }

  // Vote result bars
  voteBars.innerHTML = '';
  if (results && results.length) {
    const maxVotes = Math.max(1, ...results.map(r => r.votes || 0));
    results.forEach(r => {
      const pct = Math.round(((r.votes || 0) / maxVotes) * 100);
      const isTop = (r.votes || 0) === maxVotes && maxVotes > 0;
      const circle = (r.gameNumber != null)
        ? renderPlayerCircle(r.gameNumber, r.gameColor, 20)
        : escapeHtml(r.avatar || '👤');
      const row = document.createElement('div');
      row.className = 'vote-bar-row';
      row.innerHTML =
        '<span class="vote-bar-label">' + circle + ' ' + escapeHtml(r.name || r.nickname || r.playerName || '?') + '</span>' +
        '<div class="vote-bar-track">' +
          '<div class="vote-bar-fill' + (isTop ? ' top' : '') + '" style="width:' + pct + '%;"></div>' +
        '</div>' +
        '<span class="vote-bar-count">' + (r.votes || 0) + '票</span>';
      voteBars.appendChild(row);
    });
  }

  // Back to lobby button
  $('#btn-back-lobby').onclick = () => {
    window.location.href = '/room.html?room=' + roomId;
  };
});

// ---------- back_to_lobby ----------
socket.on('back_to_lobby', () => {
  window.location.href = '/room.html?room=' + roomId;
});

// ============================================================================
//  USER ACTIONS
// ============================================================================

// Send / describe button
$('#btn-send').addEventListener('click', () => {
  sendTurnContent();
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTurnContent();
  }
});

function sendTurnContent() {
  const content = chatInput.value.trim();
  if (!state.isMyTurn) return;   // only when it IS your turn
  if (state.isVoting) return;

  // In undercover mode, emit describe_done
  if (state.mode === 'undercover') {
    socket.emit('describe_done', { content: content || '' });
    state.isMyTurn = false;
    chatInput.value = '';
    chatInput.disabled = true;
    inputBar.classList.add('locked');
    chatInput.placeholder = '等待其他人发言...';
  } else {
    // Chat mode — emit regular chat_message
    if (!content) return;
    socket.emit('chat_message', { content });
    chatInput.value = '';
  }
}

// Confirm vote button
$('#btn-confirm-vote').addEventListener('click', () => {
  if (!state.isVoting) return;
  socket.emit('vote', { targetId: state.selectedVoteTarget || null });
  voteOverlay.style.display = 'none';
  state.isVoting = false;
  state.selectedVoteTarget = null;
  clearTimer();
});

// Skip vote button
$('#btn-skip-vote').addEventListener('click', () => {
  if (!state.isVoting) return;
  socket.emit('vote', { targetId: null });
  voteOverlay.style.display = 'none';
  state.isVoting = false;
  state.selectedVoteTarget = null;
  clearTimer();
});

// Call vote button (early vote)
$('#btn-call-vote').addEventListener('click', () => {
  socket.emit('call_vote');
  $('#btn-call-vote').style.display = 'none';
});

// Leave button
$('#btn-leave').addEventListener('click', () => {
  if (confirm('确定要离开游戏吗？')) {
    window.location.href = '/room.html?room=' + roomId;
  }
});

// ============================================================================
//  HELPER FUNCTIONS
// ============================================================================

/**
 * 播放提示音（Web Audio API 生成短促"叮"声）
 */
function playTurnSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch(e) { /* 静默失败 */ }
}

/**
 * 手机震动提醒
 */
function vibrateTurn() {
  try {
    if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  } catch(e) { /* 静默失败 */ }
}

/**
 * 渲染玩家编号圆圈
 * @param {number} num - 编号 1-5
 * @param {string} color - CSS 颜色
 * @param {number} size - 圆圈大小 px
 * @returns {string} HTML
 */
function renderPlayerCircle(num, color, size) {
  size = size || 28;
  const font = size > 30 ? '16px' : '12px';
  return '<span style="display:inline-flex;align-items:center;justify-content:center;' +
    'width:' + size + 'px;height:' + size + 'px;border-radius:50%;' +
    'background:' + (color || '#666') + ';color:#fff;font-weight:700;' +
    'font-size:' + font + ';flex-shrink:0;">' + (num || '?') + '</span>';
}

/**
 * 根据 senderId 从玩家列表查找编号和颜色
 */
function getPlayerBadge(senderId) {
  const p = state.players.find(p => p.id === senderId);
  if (p && p.gameNumber) {
    return renderPlayerCircle(p.gameNumber, p.gameColor, 28);
  }
  return null;
}

/**
 * XSS-safe HTML escaping
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Append a chat message bubble.  ALWAYS auto-scrolls.
 */
function appendMessage(msg) {
  if (!msg) return;

  // System message
  if (msg.isSystem) {
    appendSystemMsg(msg.content);
    return;
  }

  const isSelf = (msg.senderId === state.myId);
  const wrapper = document.createElement('div');
  wrapper.className = 'msg ' + (isSelf ? 'msg-self' : 'msg-other');

  const bubbleClass = msg.isDescription ? ' desc' : '';

  // 优先用彩色编号圆圈，其次用 emoji 头像
  const badge = getPlayerBadge(msg.senderId);
  const avatarHtml = badge
    ? badge
    : '<span class="msg-avatar-text">' + escapeHtml(msg.senderAvatar || '👤') + '</span>';

  wrapper.innerHTML =
    '<div class="msg-avatar">' + avatarHtml + '</div>' +
    '<div class="msg-body">' +
      '<div class="msg-name">' + escapeHtml(msg.senderName || '?') + '</div>' +
      '<div class="msg-bubble' + bubbleClass + '">' + escapeHtml(msg.content || '') + '</div>' +
    '</div>';

  chatArea.appendChild(wrapper);

  // ★ AUTO-SCROLL — critical, ensure it happens every time
  chatArea.scrollTop = chatArea.scrollHeight;
}

/**
 * Append a centered system message.
 */
function appendSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = text || '';
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

/**
 * Append vote-bar chart (used in eliminate_result).
 */
function appendVoteBars(results) {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-system';
  wrapper.style.padding = '12px 16px';
  wrapper.style.textAlign = 'left';

  const maxVotes = Math.max(1, ...results.map(r => r.votes || 0));
  let html = '<b style="font-size:12px;">📊 投票结果</b>';

  results.forEach(r => {
    const pct = Math.round(((r.votes || 0) / maxVotes) * 100);
    const isTop = (r.votes || 0) === maxVotes && maxVotes > 0;
    const circle = (r.gameNumber != null)
      ? renderPlayerCircle(r.gameNumber, r.gameColor, 20)
      : escapeHtml(r.avatar || r.targetAvatar || '👤');
    html +=
      '<div class="vote-bar-row" style="margin-top:6px;">' +
        '<span class="vote-bar-label" style="width:60px;">' + circle + ' ' + escapeHtml(r.nickname || r.playerName || r.name || r.targetName || '?') + '</span>' +
        '<div class="vote-bar-track">' +
          '<div class="vote-bar-fill' + (isTop ? ' top' : '') + '" style="width:' + pct + '%;"></div>' +
        '</div>' +
        '<span class="vote-bar-count">' + (r.votes || 0) + '票</span>' +
      '</div>';
  });

  wrapper.innerHTML = html;
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
}

// ============================================================================
//  TIMER HELPERS
// ============================================================================

/**
 * Generic countdown timer.  Calls onTick(remainingMs) every ~200ms,
 * and onEnd() once when elapsed.  Stores handle in state.timerInterval.
 */
function startTimer(durationMs, onTick, onEnd) {
  clearTimer();
  const start = Date.now();
  const total = durationMs;

  const tick = () => {
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, total - elapsed);

    if (onTick) onTick(remaining);

    if (remaining <= 0) {
      clearTimer();
      if (onEnd) onEnd();
    }
  };

  tick(); // immediate first tick
  state.timerInterval = setInterval(tick, 200);
}

/**
 * Clear any running timer.
 */
function clearTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

/**
 * Update the SVG timer ring stroke-dashoffset.
 * circumference = 2 * PI * 19 ≈ 119.38
 */
function updateTimerRing(remainingMs, totalMs) {
  const CIRCUMFERENCE = 119.38;
  const progress = Math.max(0, Math.min(1, remainingMs / totalMs));
  const offset = CIRCUMFERENCE * (1 - progress);
  timerRingFill.style.strokeDashoffset = String(offset);
}

// ============================================================================
//  OVERLAY HELPERS
// ============================================================================

function hideAllOverlays() {
  voteOverlay.style.display = 'none';
  eliminateOverlay.style.display = 'none';
  resultPage.style.display = 'none';
}

function hideSpeakerSpotlight() {
  speakerSpotlight.style.display = 'none';
  speakerSpotlight.classList.remove('my-turn');
  clearTimer();
}

// ============================================================================
//  EDGE CASES & SAFETY
// ============================================================================

// Prevent leaving page mid-game accidentally
window.addEventListener('beforeunload', (e) => {
  if (state.isMyTurn || state.isVoting) {
    // Modern browsers ignore custom messages but showing the dialog protects state
    e.preventDefault();
    e.returnValue = '';
  }
});

// Handle page visibility change — pause/resume timers if needed
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Page hidden — the server timers will handle timeouts;
    // nothing to do client-side since server is authoritative.
  }
});
