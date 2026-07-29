require('dotenv').config();

const AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';

// 模型配置表
const PROVIDERS = {
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    key: process.env.DEEPSEEK_API_KEY,
    model: 'deepseek-chat',
  },
  doubao: {
    url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    key: process.env.DOUBAO_API_KEY,
    model: process.env.DOUBAO_MODEL || 'doubao-pro-32k',
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    key: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
  },
  qwen: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    key: process.env.QWEN_API_KEY,
    model: process.env.QWEN_MODEL || 'qwen-plus',
  },
};

// AI 挂了时的兜底话术
const FALLBACKS = [
  '哈哈，有点意思',
  '我也不太确定诶',
  '你们说得都对',
  '呃...我再想想',
  '这个话题好难啊',
  '说实话我也不太懂',
];

/**
 * 调用 AI 生成回复
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userPrompt  - 格式化的聊天记录
 * @returns {Promise<string|null>} AI 回复文本，失败返回兜底话术
 */
async function generateReply(systemPrompt, userPrompt) {
  // 检查 fetch 是否可用（Node 18+）
  if (typeof fetch !== 'function') {
    console.error('[AI] fetch is not available — Node version is ' + process.version + ', need >=18');
    return getFallback();
  }

  const provider = PROVIDERS[AI_PROVIDER];

  if (!provider || !provider.key || provider.key.includes('your_')) {
    console.error(`[AI] Provider "${AI_PROVIDER}" not configured. key=${!!provider?.key} hasProvider=${!!provider}`);
    return getFallback();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    console.log(`[AI] Calling ${AI_PROVIDER} (${provider.model})...`);
    const response = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.key}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.85,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[AI] API error ${response.status}: ${await response.text().catch(() => '')}`);
      return getFallback();
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text || text.length > 500) {
      return text ? text.slice(0, 500) : getFallback();
    }

    return text;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error('[AI] Request timeout');
    } else {
      console.error(`[AI] Error: ${err.message}`);
    }
    return getFallback();
  }
}

/**
 * 随机取一个兜底话术
 * @returns {string}
 */
function getFallback() {
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

module.exports = { generateReply, getFallback };
