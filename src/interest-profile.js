"use strict";

/**
 * interest-profile.js — 用户兴趣画像引擎
 *
 * 三层信号分类：
 *   P0 · ask     — 用户主动提问（快捷键输入、Claude 对话）  来源系数 3.0
 *   P1 · select  — 划词延伸（选中文本 + 追问）              来源系数 2.0
 *   P2 · external— 外部新鲜信息（HN 热点、浏览笔记）        来源系数 1.0
 *
 * 有效权重 = 基础权重 × 来源系数 × 时间衰减
 * 时间衰减 = 0.5 ^ (天数 / HALF_LIFE_DAYS)
 *
 * 反馈闭环：
 *   采纳 → 相关 topic weight +1.5
 *   拒绝 → 相关 topic weight -0.8
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const MR_KRABS_DIR = path.join(os.homedir(), ".mr-krabs");
const PROFILE_FILE = path.join(MR_KRABS_DIR, "interest-profile.json");

/** 来源系数 */
const SOURCE_MULTIPLIER = {
  ask: 3.0,
  select: 2.0,
  external: 1.0,
};

/** 7 天半衰期 */
const HALF_LIFE_DAYS = 7;

/** 信号历史最大保留条数 */
const MAX_SIGNALS = 200;

/** topic 最大保留数 */
const MAX_TOPICS = 80;

/** 有效权重低于此阈值的 topic 在清理时被移除 */
const PRUNE_THRESHOLD = 0.05;

// ─────────────────────────────────────────────
// 数据结构
// ─────────────────────────────────────────────

function emptyProfile() {
  return {
    version: 1,
    topics: {},
    signals: [],
  };
}

// ─────────────────────────────────────────────
// 持久化
// ─────────────────────────────────────────────

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      const raw = fs.readFileSync(PROFILE_FILE, "utf8");
      _cache = JSON.parse(raw);
      if (!_cache.topics) _cache.topics = {};
      if (!Array.isArray(_cache.signals)) _cache.signals = [];
      return _cache;
    }
  } catch (e) {
    console.warn("Mr. Krabs InterestProfile: failed to load:", e.message);
  }
  _cache = emptyProfile();
  return _cache;
}

function save() {
  try {
    if (!fs.existsSync(MR_KRABS_DIR)) fs.mkdirSync(MR_KRABS_DIR, { recursive: true });
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(_cache, null, 2), "utf8");
  } catch (e) {
    console.warn("Mr. Krabs InterestProfile: failed to save:", e.message);
  }
}

// ─────────────────────────────────────────────
// 时间衰减
// ─────────────────────────────────────────────

function daysSince(isoDateStr) {
  const then = new Date(isoDateStr);
  if (isNaN(then.getTime())) return 999;
  return (Date.now() - then.getTime()) / (1000 * 60 * 60 * 24);
}

function timeDecay(days) {
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

// ─────────────────────────────────────────────
// 关键词提取（轻量级，不依赖 NLP 库）
// ─────────────────────────────────────────────

/** 停用词（中英文混合） */
const STOP_WORDS = new Set([
  // 中文
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
  "自己", "这", "他", "她", "它", "吗", "什么", "怎么", "那", "可以", "这个", "那个",
  "帮我", "请", "能", "想", "做", "用", "把", "被", "让", "给", "从", "对", "但",
  "如果", "因为", "所以", "还", "而", "或", "与", "及", "等", "吧", "呢", "啊",
  // 英文
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
  "and", "or", "but", "if", "then", "else", "when", "where", "how", "what", "which",
  "who", "whom", "why", "not", "no", "so", "too", "very", "just", "about",
  "in", "on", "at", "to", "for", "with", "by", "from", "of", "as",
]);

/**
 * 从文本中提取关键词/短语作为 topic 候选
 * 策略：
 *   1. 英文：提取 2+ 字母的连续 token，过滤停用词
 *   2. 中文：提取 2~6 字的连续汉字片段
 *   3. 技术术语：保留含 - 或 . 的复合词（如 context-engineering, node.js）
 */
function extractTopics(text) {
  if (!text || typeof text !== "string") return [];
  const topics = new Set();

  // 英文 token + 技术术语（含 - . _）
  const enMatches = text.match(/[a-zA-Z][a-zA-Z0-9._-]{1,40}/g) || [];
  for (const w of enMatches) {
    const lower = w.toLowerCase();
    if (!STOP_WORDS.has(lower) && lower.length >= 2) {
      topics.add(lower);
    }
  }

  // 中文：连续汉字 2~6 字
  const zhMatches = text.match(/[\u4e00-\u9fff]{2,6}/g) || [];
  for (const w of zhMatches) {
    if (!STOP_WORDS.has(w)) {
      topics.add(w);
    }
  }

  return [...topics].slice(0, 10);
}

// ─────────────────────────────────────────────
// 核心 API
// ─────────────────────────────────────────────

/**
 * 记录一条信号（用户输入、划词、外部信息）
 * @param {string} text   — 原始文本
 * @param {"ask"|"select"|"external"} source — 信号来源
 */
function recordSignal(text, source) {
  const profile = load();
  const now = new Date().toISOString();
  const topics = extractTopics(text);

  // 追加信号历史
  profile.signals.push({
    text: (text || "").slice(0, 300),
    source: source || "ask",
    time: now,
    topics,
  });

  // 裁剪信号历史
  if (profile.signals.length > MAX_SIGNALS) {
    profile.signals = profile.signals.slice(-MAX_SIGNALS);
  }

  // 更新 topic 权重
  const mult = SOURCE_MULTIPLIER[source] || 1.0;
  for (const t of topics) {
    if (!profile.topics[t]) {
      profile.topics[t] = {
        weight: 0,
        source: source || "ask",
        lastSeen: now,
        adoptCount: 0,
        rejectCount: 0,
      };
    }
    const entry = profile.topics[t];
    entry.weight += mult;
    entry.lastSeen = now;
    // 升级来源等级（ask > select > external）
    if (SOURCE_MULTIPLIER[source] > SOURCE_MULTIPLIER[entry.source]) {
      entry.source = source;
    }
  }

  pruneTopics(profile);
  _cache = profile;
  save();
  return topics;
}

/**
 * 反馈：采纳建议 → 相关 topic 权重 +1.5
 * @param {string} proposalText — 被采纳的建议文本
 */
function onAdopt(proposalText) {
  const profile = load();
  const topics = extractTopics(proposalText);
  const now = new Date().toISOString();

  for (const t of topics) {
    if (!profile.topics[t]) {
      profile.topics[t] = {
        weight: 0,
        source: "ask",
        lastSeen: now,
        adoptCount: 0,
        rejectCount: 0,
      };
    }
    profile.topics[t].weight += 1.5;
    profile.topics[t].adoptCount += 1;
    profile.topics[t].lastSeen = now;
  }

  _cache = profile;
  save();
  console.log(`Mr. Krabs InterestProfile: adopt feedback, topics=[${topics.join(", ")}]`);
}

/**
 * 反馈：拒绝建议 → 相关 topic 权重 -0.8
 * @param {string} proposalText — 被拒绝的建议文本
 */
function onReject(proposalText) {
  const profile = load();
  const topics = extractTopics(proposalText);

  for (const t of topics) {
    if (profile.topics[t]) {
      profile.topics[t].weight -= 0.8;
      profile.topics[t].rejectCount += 1;
    }
  }

  pruneTopics(profile);
  _cache = profile;
  save();
  console.log(`Mr. Krabs InterestProfile: reject feedback, topics=[${topics.join(", ")}]`);
}

/**
 * 获取按有效权重排序的 top-N 兴趣话题
 * 有效权重 = 基础权重 × 来源系数 × 时间衰减
 */
function getTopInterests(n = 15) {
  const profile = load();
  const now = Date.now();
  const ranked = [];

  for (const [topic, entry] of Object.entries(profile.topics)) {
    const days = (now - new Date(entry.lastSeen).getTime()) / (1000 * 60 * 60 * 24);
    const decay = timeDecay(days);
    const sourceMult = SOURCE_MULTIPLIER[entry.source] || 1.0;
    const effectiveWeight = entry.weight * sourceMult * decay;

    if (effectiveWeight > PRUNE_THRESHOLD) {
      ranked.push({
        topic,
        effectiveWeight: Math.round(effectiveWeight * 100) / 100,
        source: entry.source,
        daysSinceLastSeen: Math.round(days * 10) / 10,
        adoptCount: entry.adoptCount,
        rejectCount: entry.rejectCount,
      });
    }
  }

  ranked.sort((a, b) => b.effectiveWeight - a.effectiveWeight);
  return ranked.slice(0, n);
}

/**
 * 生成可注入 prompt 的兴趣画像摘要
 * 格式：按有效权重排序的 topic 列表 + 来源标签
 */
function buildProfileSummary(maxTopics = 12) {
  const top = getTopInterests(maxTopics);
  if (!top.length) return "";

  const lines = top.map((t, i) => {
    const sourceLabel = { ask: "主动提问", select: "划词延伸", external: "外部信息" }[t.source] || t.source;
    const feedback = [];
    if (t.adoptCount > 0) feedback.push(`采纳${t.adoptCount}次`);
    if (t.rejectCount > 0) feedback.push(`拒绝${t.rejectCount}次`);
    const fbStr = feedback.length ? ` (${feedback.join("，")})` : "";
    // 把距今天数明确展示给 LLM，让它区分新鲜度
    const age = t.daysSinceLastSeen < 1
      ? "今天"
      : t.daysSinceLastSeen < 2
        ? "昨天"
        : `${Math.round(t.daysSinceLastSeen)} 天前`;
    return `  ${i + 1}. ${t.topic} — 权重 ${t.effectiveWeight}，来源：${sourceLabel}，最近活跃：${age}${fbStr}`;
  });

  return `## 用户兴趣画像（历史积累，按有效权重排序；注意：优先参考下方"最近信号"而非本节高权重 topic）\n${lines.join("\n")}`;
}

/**
 * 获取最近 N 条信号（用于上下文注入）
 */
function getRecentSignals(n = 10) {
  const profile = load();
  return profile.signals.slice(-n);
}

// ─────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────

function pruneTopics(profile) {
  const entries = Object.entries(profile.topics);
  if (entries.length <= MAX_TOPICS) return;

  // 按有效权重排序，保留 top MAX_TOPICS
  const now = Date.now();
  const scored = entries.map(([topic, entry]) => {
    const days = (now - new Date(entry.lastSeen).getTime()) / (1000 * 60 * 60 * 24);
    const ew = entry.weight * (SOURCE_MULTIPLIER[entry.source] || 1) * timeDecay(days);
    return { topic, ew };
  });
  scored.sort((a, b) => b.ew - a.ew);

  const keep = new Set(scored.slice(0, MAX_TOPICS).map(s => s.topic));
  for (const [topic] of entries) {
    if (!keep.has(topic)) delete profile.topics[topic];
  }
}

/**
 * 强制刷新缓存（测试用）
 */
function invalidateCache() {
  _cache = null;
}

module.exports = {
  recordSignal,
  onAdopt,
  onReject,
  getTopInterests,
  buildProfileSummary,
  getRecentSignals,
  extractTopics,
  invalidateCache,
};
