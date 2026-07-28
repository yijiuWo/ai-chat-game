// src/words.js
// 谁是卧底词库：预设词对 + AI 生成

/**
 * 预设词对（平民词 / 卧底词）
 * 两个词同类别、相似但不同，保证混淆度
 */
const WORD_PAIRS = [
  { civilian: '苹果', undercover: '梨子', category: '水果' },
  { civilian: '橘子', undercover: '橙子', category: '水果' },
  { civilian: '西瓜', undercover: '哈密瓜', category: '水果' },
  { civilian: '冰箱', undercover: '冰柜', category: '家电' },
  { civilian: '空调', undercover: '风扇', category: '家电' },
  { civilian: '洗衣机', undercover: '烘干机', category: '家电' },
  { civilian: '饺子', undercover: '馄饨', category: '食物' },
  { civilian: '面包', undercover: '蛋糕', category: '食物' },
  { civilian: '火锅', undercover: '麻辣烫', category: '食物' },
  { civilian: '可乐', undercover: '雪碧', category: '饮品' },
  { civilian: '咖啡', undercover: '奶茶', category: '饮品' },
  { civilian: '口红', undercover: '唇膏', category: '化妆品' },
  { civilian: '香水', undercover: '花露水', category: '日用品' },
  { civilian: '被子', undercover: '毯子', category: '家居' },
  { civilian: '电梯', undercover: '扶梯', category: '交通' },
  { civilian: '地铁', undercover: '轻轨', category: '交通' },
  { civilian: '微信', undercover: 'QQ', category: 'App' },
  { civilian: '微博', undercover: '小红书', category: 'App' },
  { civilian: '篮球', undercover: '排球', category: '运动' },
  { civilian: '笔记本', undercover: '平板电脑', category: '数码' },
];

/**
 * 随机抽取一对词
 * @returns {{ civilian: string, undercover: string, category: string }}
 */
function pickWordPair() {
  const i = Math.floor(Math.random() * WORD_PAIRS.length);
  return { ...WORD_PAIRS[i] };
}

/**
 * 用 AI 生成一对词
 * @param {Function} generateFn - AI 生成函数（接收 prompt，返回 JSON 字符串）
 * @returns {Promise<{ civilian: string, undercover: string, category: string } | null>}
 */
async function generateWordPair(generateFn) {
  const prompt = `你是一个游戏词库设计者。请为"谁是卧底"游戏生成一对词语。

要求：
- 两个词属于同一类别
- 它们相似但不同，容易混淆
- 类别可以是有趣的、生活化的

请严格按以下 JSON 格式输出（不要输出其他内容）：
{"civilian": "平民词", "undercover": "卧底词", "category": "类别"}`;

  try {
    const reply = await generateFn(prompt);
    // 提取 JSON（可能是 markdown 代码块包裹的）
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const pair = JSON.parse(jsonMatch[0]);
    if (pair.civilian && pair.undercover) {
      return {
        civilian: pair.civilian,
        undercover: pair.undercover,
        category: pair.category || '其他',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 获取词对：优先预设，可选 AI 生成
 * @param {boolean} useAi - 是否使用 AI 生成
 * @param {Function|null} generateFn - AI 生成函数
 * @returns {Promise<{ civilian: string, undercover: string, category: string, source: 'preset'|'ai' }>}
 */
async function getWordPair(useAi = false, generateFn = null) {
  if (useAi && generateFn) {
    const aiPair = await generateWordPair(generateFn);
    if (aiPair) {
      return { ...aiPair, source: 'ai' };
    }
    console.log('[词库] AI 生成失败，fallback 到预设词库');
  }
  return { ...pickWordPair(), source: 'preset' };
}

module.exports = { WORD_PAIRS, pickWordPair, generateWordPair, getWordPair };
