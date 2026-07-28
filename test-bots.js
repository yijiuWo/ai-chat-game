// test-bots.js — 创建虚拟玩家测试谁是卧底
const io = require('socket.io-client');

const ROOM_ID = process.argv[2];
const NICKNAME = process.argv[3] || '测试员';

if (!ROOM_ID) {
  console.log('用法: node test-bots.js <ROOM_ID> [nickname]');
  process.exit(1);
}

const BOT_DESCRIPTIONS = [
  '这个东西嘛，圆圆的，吃起来挺甜的',
  '我觉得这个还挺常见的，家家都有',
  '怎么说呢，就是那种…很日常的东西',
  '颜色挺好看的，用起来也方便',
  '反正就是很实用，不会踩雷的那种',
  'emmm这个我还挺喜欢的，推荐给你们',
  '就那种很经典的东西，大家应该都认识',
  '不好描述但是你们都懂的哈哈哈',
  '我感觉这个跟另一个东西有点像但又不一样',
  '挺有意思的，每次看到都会想买',
];

const socket = io('http://localhost:3002');
let state = { myWord: null, isMyTurn: false };

socket.on('connect', () => {
  console.log(`[${NICKNAME}] 已连接 ${socket.id}`);
  socket.emit('join_room', { roomId: ROOM_ID, nickname: NICKNAME });
});

socket.on('room_joined', ({ roomId, players }) => {
  console.log(`[${NICKNAME}] 加入房间 ${roomId}，当前 ${players.length} 人`);
  // 自动准备
  socket.emit('toggle_ready');
  console.log(`[${NICKNAME}] 已准备`);
});

socket.on('game_started', ({ players, mode, totalPlayers }) => {
  console.log(`[${NICKNAME}] 游戏开始！模式=${mode}，${totalPlayers}人`);
});

socket.on('word_assigned', ({ word }) => {
  state.myWord = word;
  console.log(`[${NICKNAME}] 我的词: ${word}`);
});

socket.on('turn_start', ({ playerId, playerName, duration }) => {
  if (playerId === socket.id) {
    state.isMyTurn = true;
    const desc = BOT_DESCRIPTIONS[Math.floor(Math.random() * BOT_DESCRIPTIONS.length)];
    console.log(`[${NICKNAME}] 轮到我发言了！→ "${desc}"`);
    // 随机等待1-3秒后发言
    const delay = 1000 + Math.random() * 2000;
    setTimeout(() => {
      socket.emit('describe_done', { content: desc });
      console.log(`[${NICKNAME}] 已发言`);
      state.isMyTurn = false;
    }, delay);
  } else {
    console.log(`[${NICKNAME}] 轮到 ${playerName} 发言`);
  }
});

socket.on('vote_start', ({ candidates, type }) => {
  console.log(`[${NICKNAME}] 投票开始 (${type})，候选: ${candidates.map(c => c.nickname).join(', ')}`);
  // 随机投一个人
  const others = candidates.filter(c => c.id !== socket.id);
  if (others.length > 0) {
    const target = others[Math.floor(Math.random() * others.length)];
    setTimeout(() => {
      socket.emit('vote', { targetId: target.id });
      console.log(`[${NICKNAME}] 投给了 ${target.nickname}`);
    }, 1000 + Math.random() * 3000);
  }
});

socket.on('eliminate_result', ({ eliminated, wasUndercover, gameOver, winner }) => {
  console.log(`[${NICKNAME}] ${eliminated?.name || '无人'} 被淘汰 ${wasUndercover ? '(是卧底!)' : ''} ${gameOver ? `游戏结束: ${winner}` : ''}`);
});

socket.on('ai_reveal', ({ aiPlayer, undercoverPlayer, wordPair }) => {
  console.log(`[${NICKNAME}] AI是: ${aiPlayer?.name}, 卧底是: ${undercoverPlayer?.name}`);
  console.log(`[${NICKNAME}] 词对: ${wordPair?.civilian} / ${wordPair?.undercover}`);
});

socket.on('back_to_lobby', () => {
  console.log(`[${NICKNAME}] 回到等待室`);
});

socket.on('error', ({ message }) => {
  console.log(`[${NICKNAME}] 错误: ${message}`);
});

socket.on('disconnect', () => {
  console.log(`[${NICKNAME}] 断开连接`);
});
