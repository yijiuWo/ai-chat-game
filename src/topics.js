const TOPICS = [
  '你最尴尬的一次经历是什么？',
  '如果你能穿越到古代，你最想做什么？',
  '说一个你最近 get 到的新技能',
  '你小时候最离谱的梦想是什么？',
  '如果明天是世界末日，你今天会做什么？',
  '分享一个你被骗的经历',
  '你最近单曲循环的一首歌是什么？为什么？',
  '假如你有一千万，第一件事做什么？',
];

/**
 * 从话题池随机抽取一个话题
 * @returns {string}
 */
function getRandomTopic() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

module.exports = { TOPICS, getRandomTopic };
