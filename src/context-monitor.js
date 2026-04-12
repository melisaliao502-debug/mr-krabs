"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const resolveClaudeBin = require("./resolve-claude-bin");
const interestProfile = require("./interest-profile");
/** 主动提议专用子代理，与 tasks.js 中的 mr-krabs-executor 隔离（各自独立 `claude -p`） */
const SUBAGENT_PROPOSAL = "mr-krabs-proposal";

function proposalSubagentEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MR_KRABS_SUBAGENT = SUBAGENT_PROPOSAL;
  return env;
}

module.exports = function initContextMonitor(ctx) {

/** 周期性主动提议间隔（每 4 小时一次；与 Codex JSONL 实时轮询无关） */
const INTERVAL_MS = 4 * 60 * 60 * 1000;
/** 启动后首次提议延迟，避免干等一个完整周期；之后按 INTERVAL_MS 循环 */
const FIRST_RUN_MS = 10 * 60 * 1000;
let timer = null;
let firstTimer = null;
let running = false;

const homedir = os.homedir();
const MR_KRABS_DIR = path.join(homedir, ".mr-krabs");
const BROWSE_CONTEXT_FILE = path.join(MR_KRABS_DIR, "context", "browse.md");
const TRENDS_OVERRIDE_FILE = path.join(MR_KRABS_DIR, "context", "trends.md");
const PROPOSAL_SKILL_FILE = path.join(MR_KRABS_DIR, "skills", "生成任务建议.md");

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/** Hacker News 头条标题，作为「技术圈热点」参考（无需 API Key） */
async function fetchTechHeadlines(maxTitles = 8) {
  const ids = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json", 6000);
  if (!Array.isArray(ids) || !ids.length) return "";
  const pick = ids.slice(0, 15);
  const items = await Promise.all(
    pick.map((id) => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 4000)),
  );
  const titles = items
    .filter(Boolean)
    .map((i) => i.title)
    .filter(Boolean)
    .slice(0, maxTitles);
  if (!titles.length) return "";
  return titles.map((t) => `  - ${t}`).join("\n");
}

function readTailText(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/** ~/.claude/history.jsonl 里用户输入过的 prompt（display 字段） */
function collectClaudeHistoryDisplays(maxLines = 40) {
  const fp = path.join(homedir, ".claude", "history.jsonl");
  if (!fs.existsSync(fp)) return [];
  const tail = readTailText(fp, 256 * 1024);
  const out = [];
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.display === "string" && o.display.length > 2) {
        out.push(o.display.slice(0, 280));
      }
    } catch { /* skip */ }
  }
  return out.slice(-maxLines);
}

function listRecentProjectJsonls(maxFiles) {
  const base = path.join(homedir, ".claude", "projects");
  if (!fs.existsSync(base)) return [];
  const files = [];
  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(base, ent.name);
    let sub;
    try {
      sub = fs.readdirSync(dir);
    } catch { continue; }
    for (const f of sub) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f);
      try {
        files.push({ fp, mtime: fs.statSync(fp).mtimeMs });
      } catch { /* skip */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, maxFiles).map((x) => x.fp);
}

/** 从会话 jsonl 抽取用户侧短文本（排除大块 tool_result） */
function extractUserSnippetsFromJsonl(filePath, maxSnippets, maxLen) {
  const tail = readTailText(filePath, 200 * 1024);
  const snippets = [];
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type !== "user" || !o.message) continue;
      const c = o.message.content;
      if (typeof c === "string" && c.length > 2 && c.length < 4000) {
        snippets.push(c.slice(0, maxLen));
      }
    } catch { /* skip */ }
    if (snippets.length > maxSnippets * 4) break;
  }
  const uniq = [...new Set(snippets)];
  return uniq.slice(-maxSnippets);
}

function readOptionalMarkdownFile(fp, maxChars) {
  try {
    if (!fs.existsSync(fp)) return "";
    const raw = fs.readFileSync(fp, "utf8").trim();
    return raw.slice(0, maxChars);
  } catch {
    return "";
  }
}

function collectBaseContext() {
  const parts = [];

  if (ctx.getProjectCwd) {
    const cwd = ctx.getProjectCwd();
    if (cwd && cwd !== homedir) {
      parts.push(`- 用户最近在项目目录工作：${cwd}`);
    }
  }

  if (ctx.getTasksRaw) {
    const raw = ctx.getTasksRaw();
    const pending = raw.split("\n")
      .filter(l => l.match(/^- \[ \]/))
      .map(l => l.replace(/^- \[ \]\s*/, "").slice(0, 60))
      .slice(0, 5);
    if (pending.length) {
      parts.push(`- 当前待办任务：\n${pending.map(t => "  - " + t).join("\n")}`);
    }
  }

  if (ctx.getResults) {
    const results = ctx.getResults();
    const recentEntries = results.split("\n")
      .filter(l => l.startsWith("### "))
      .slice(0, 3)
      .map(l => l.replace(/^###\s*/, "").slice(0, 60));
    if (recentEntries.length) {
      parts.push(`- 最近完成的任务：\n${recentEntries.map(t => "  - " + t).join("\n")}`);
    }
  }

  if (ctx.getSessions) {
    const sessions = ctx.getSessions();
    const active = [];
    for (const [, s] of sessions) {
      if (s.cwd) active.push(`${s.state || "idle"} @ ${s.cwd}`);
    }
    if (active.length) {
      parts.push(`- 活跃的 Claude Code 会话：\n${active.slice(0, 3).map(a => "  - " + a).join("\n")}`);
    }
  }

  if (ctx.getSkillsList) {
    const skills = ctx.getSkillsList();
    if (skills.length) {
      parts.push(`- 已学会的技能：${skills.map(s => s.name).join("、")}`);
    }
  }

  return parts.join("\n");
}

async function gatherFullContext() {
  const blocks = [];
  const now = new Date();
  blocks.push(`## 元信息\n- 本地日期：${now.toISOString().slice(0, 10)}（${now.toLocaleString("zh-CN", { hour12: false })}）`);

  const hist = collectClaudeHistoryDisplays(35);
  if (hist.length) {
    blocks.push(`## 近期与 Claude 对话中的用户输入（来自 ~/.claude/history.jsonl，按时间从旧到新排列，越靠后越新鲜）\n${hist.map((h, i) => `  ${i + 1}. ${h}`).join("\n")}`);
  }

  const jsonls = listRecentProjectJsonls(3);
  const sessionSnips = [];
  for (const fp of jsonls) {
    sessionSnips.push(...extractUserSnippetsFromJsonl(fp, 8, 200));
  }
  const dedup = [...new Set(sessionSnips)].slice(-12);
  if (dedup.length) {
    blocks.push(`## 近期 Claude Code 会话中的用户消息摘要（本地 jsonl，越靠后越新鲜）\n${dedup.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
  }

  const browse = readOptionalMarkdownFile(BROWSE_CONTEXT_FILE, 6000);
  if (browse) {
    blocks.push(`## 用户维护的浏览 / 阅读笔记（~/.mr-krabs/context/browse.md）\n${browse}`);
  }

  const trendsOverride = readOptionalMarkdownFile(TRENDS_OVERRIDE_FILE, 4000);
  if (trendsOverride) {
    blocks.push(`## 用户补充的热点 / 议题（~/.mr-krabs/context/trends.md）\n${trendsOverride}`);
  } else {
    const hn = await fetchTechHeadlines(8);
    if (hn) {
      blocks.push(`## 技术社区热点参考（Hacker News Top，可作市场/行业话题线索）\n${hn}`);
    }
  }

  const base = collectBaseContext();
  if (base) {
    blocks.push(`## 任务系统内部状态\n${base}`);
  }

  // ── 任务图谱摘要：为提议子代理提供任务关系全景 ──
  try {
    if (ctx.getTaskGraph) {
      const graph = ctx.getTaskGraph();
      const summary = graph.getGraphSummary();
      if (summary) {
        blocks.push(`## 任务图谱摘要（任务间的依赖、来源、目标关系）\n${summary}`);
      }
    }
  } catch (e) {
    console.warn("Mr. Krabs ContextMonitor: failed to get graph summary:", e.message);
  }

  // ── 兴趣画像：先注入最近信号（时效补充），再注入历史权重画像（主锚） ──
  try {
    // 最近原始信号：带时间戳，让 LLM 知道新鲜度，补充画像尚未更新的最新动向
    const recentSignals = interestProfile.getRecentSignals(10);
    if (recentSignals.length) {
      const nowMs = Date.now();
      const sigLines = recentSignals.map((s, i) => {
        const sourceLabel = { ask: "主动提问", select: "划词延伸", external: "外部信息" }[s.source] || s.source;
        // 计算距今时间，给 LLM 明确的新鲜度感知
        const msAgo = nowMs - new Date(s.time).getTime();
        const hoursAgo = msAgo / (1000 * 60 * 60);
        const ageStr = hoursAgo < 1
          ? `${Math.round(hoursAgo * 60)} 分钟前`
          : hoursAgo < 24
            ? `${Math.round(hoursAgo)} 小时前`
            : `${Math.round(hoursAgo / 24)} 天前`;
        return `  ${i + 1}. [${sourceLabel}｜${ageStr}] ${s.text.slice(0, 120)}`;
      });
      blocks.push(`## 最近用户兴趣信号（按时间从旧到新，越靠后越新鲜；可补充兴趣画像尚未更新的最新动向）\n${sigLines.join("\n")}`);
    }

    // 兴趣画像放在最后，作为最高优先锚点（已含时间衰减，有效权重高 + 最近活跃 = 最应参考）
    const profileSummary = interestProfile.buildProfileSummary(12);
    if (profileSummary) {
      blocks.push(profileSummary);
    }
  } catch (e) {
    console.warn("Mr. Krabs ContextMonitor: failed to inject interest profile:", e.message);
  }

  return blocks.join("\n\n");
}

/** 全角标点、有序列表前缀等归一化，便于匹配模型输出 */
function normalizeProposalLine(line) {
  let s = (line || "").trim();
  s = s.replace(/^\d+\.\s*/, "");
  s = s.replace(/^[・•]\s*/, "- ");
  s = s.replace(/^[\u2013\u2014－—﹣]\s*/, "- ");
  s = s.replace(/［/g, "[").replace(/］/g, "]").replace(/？/g, "?");
  return s.trim();
}

/** 从模型输出中解析建议行（严格 `- [?]` + 宽松空格 / 全角变体） */
function extractProposalsFromOutput(raw) {
  let output = (raw || "").trim();
  if (/^```/.test(output)) {
    output = output.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/m, "").trim();
  }
  const lines = output.split("\n").map(normalizeProposalLine).filter(Boolean);
  const strict = lines.filter(l => /^- \[\?\]/.test(l));
  if (strict.length) return strict.slice(0, 5);
  const loose = [];
  for (const l of lines) {
    const m = l.match(/^-\s*\[\s*\?\s*\]\s*(.+)$/);
    if (!m) continue;
    let rest = m[1].trim();
    if (!/^建议[：:]/.test(rest)) rest = `建议：${rest}`;
    loose.push(`- [?] ${rest}`);
  }
  if (loose.length) return loose.slice(0, 5);
  const fallback = [];
  for (const l of lines) {
    if (/\[\s*\?\s*\]/.test(l) && (l.includes("建议") || l.length < 120)) {
      const tail = l.replace(/^.*?\]\s*/, "").trim() || l;
      fallback.push(tail.includes("建议") ? `- [?] ${tail}` : `- [?] 建议：${tail}`);
    }
  }
  return fallback.slice(0, 5);
}

/**
 * @param {{ force?: boolean, onComplete?: (r: object) => void }} opts
 * force=true：手动触发，不因执行子代理占线而跳过（仍与定时器互斥 running）
 */
function runPropose(opts = {}) {
  const { force = false, onComplete } = opts;
  const done = (result) => {
    running = false;
    if (typeof onComplete === "function") onComplete(result);
  };

  if (running) {
    if (onComplete) onComplete({ ok: false, reason: "busy", message: "上一轮提议尚未结束" });
    return;
  }
  if (!force && ctx.isExecutorBusy && ctx.isExecutorBusy()) {
    console.log("Mr. Krabs ContextMonitor: skip scheduled propose — mr-krabs-executor busy");
    if (onComplete) onComplete({ ok: false, reason: "executor_busy", message: "正在执行任务队列，定时提议已跳过；可在任务面板手动生成建议" });
    return;
  }

  running = true;

  gatherFullContext()
    .then((context) => {
      const text = (context || "").trim();
      if (!text) {
        done({ ok: false, reason: "empty_context", message: "没有可用的上下文快照" });
        console.warn("Mr. Krabs ContextMonitor: empty context, skip propose");
        return;
      }

      /* ── 读取 Skill 文件构建方法论指令 ── */
      const skillContent = readOptionalMarkdownFile(PROPOSAL_SKILL_FILE, 4000);
      let methodology;
      if (skillContent) {
        // Skill 文件存在：提取 ## 方法 段落作为核心指令
        methodology = skillContent;
        console.log(`Mr. Krabs ContextMonitor: loaded proposal skill (${skillContent.length} chars)`);
      } else {
        // 兜底：硬编码指令（Skill 文件不存在时）
        methodology = `根据多源上下文（日常对话、浏览笔记、热点、当前待办等），推测用户可能愿意接下来做的 1～3 个具体任务或想深入的话题。

优先级策略（按权重从高到低）：
1. 【最高优先】用户兴趣画像——这是从历史交流中提炼、经过时间衰减加权的真实兴趣向量，有效权重越高、最近活跃时间越近，越应优先参考
2. 已被用户多次采纳的方向继续深入；已被拒绝的方向降低优先级或避开
3. 最近用户兴趣信号中的新鲜条目（每条带有"N分钟前/N小时前"标注，可补充画像尚未更新的最新动向）
4. 历史对话和会话记录越靠后的条目越新鲜，参考时以末尾条目为主
5. 若兴趣画像为空，则根据最近信号和对话历史末尾自由推荐

要求：
- 任务要简短、可执行，与画像中高权重且近期活跃的兴趣方向强相关。
- 只输出 1～3 行；每行必须以英文半角减号和空格开头，格式严格为：- [?] 建议：{一句话任务描述}（不要用全角－、不要用代码块包裹）
- 不要输出其它说明、标题或 markdown 代码块。
- 若确实没有任何有价值的方向，只输出一行：NONE`;
      }

      const prompt = `【子代理身份】你是 Mr. Krabs 的「提议子代理」（${SUBAGENT_PROPOSAL}，独立 Claude 会话，与「执行子代理 mr-krabs-executor」不共享上下文、不延续对话）。
你只根据下列快照生成任务建议，不负责执行清单中的任务、不产出交付物。

${methodology}

上下文：
${text}`;

      /* ── 使用 spawn + stdin 管道传递 prompt，避免命令行参数长度/特殊字符问题 ── */
      const claudeExe = resolveClaudeBin();
      console.log(`Mr. Krabs ContextMonitor: [${SUBAGENT_PROPOSAL}] spawning claude, prompt ${prompt.length} chars`);

      const child = spawn(claudeExe, ["-p"], {
        cwd: homedir,
        env: proposalSubagentEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      let finished = false;
      const timeoutMs = 120000;

      const killTimer = setTimeout(() => {
        if (!finished) {
          console.warn(`Mr. Krabs ContextMonitor: [${SUBAGENT_PROPOSAL}] timeout after ${timeoutMs / 1000}s, killing`);
          try { child.kill("SIGTERM"); } catch {}
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
        }
      }, timeoutMs);

      child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });

      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        console.warn(`Mr. Krabs ContextMonitor: [${SUBAGENT_PROPOSAL}] spawn error:`, err.message);
        done({ ok: false, reason: "claude_error", message: err.message || "claude 启动失败" });
      });

      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);

        if (stderrBuf.trim()) {
          console.warn(`Mr. Krabs ContextMonitor: [${SUBAGENT_PROPOSAL}] stderr:`, stderrBuf.trim().slice(0, 500));
        }

        if (code !== 0) {
          const detail = [stderrBuf.trim(), `exit code ${code}`].filter(Boolean).join(" | ");
          console.warn(`Mr. Krabs ContextMonitor: [${SUBAGENT_PROPOSAL}] proposal error (${claudeExe}):`, detail);
          done({ ok: false, reason: "claude_error", message: detail || "claude 调用失败" });
          return;
        }

        const output = stdoutBuf.trim();
        if (output === "NONE" || !output) {
          done({ ok: true, reason: "model_none", count: 0, message: "模型认为暂无合适建议" });
          return;
        }

        const proposals = extractProposalsFromOutput(output);
        if (!proposals.length) {
          done({
            ok: true,
            reason: "unparsed",
            count: 0,
            message: "未能解析建议格式，请检查 claude 输出",
            detail: output.slice(0, 400),
          });
          return;
        }

        if (ctx.addProposals) ctx.addProposals(proposals);
        if (ctx.onNewProposals) ctx.onNewProposals(proposals.length);
        console.log(`Mr. Krabs ContextMonitor: [${SUBAGENT_PROPOSAL}] proposed ${proposals.length} task(s)`);
        done({ ok: true, reason: "ok", count: proposals.length, message: `已添加 ${proposals.length} 条建议` });
      });

      /* 将 prompt 写入 stdin 并关闭，让 claude 开始处理 */
      child.stdin.write(prompt);
      child.stdin.end();
    })
    .catch((e) => {
      console.warn("Mr. Krabs ContextMonitor: gather context failed:", e.message);
      done({ ok: false, reason: "gather_failed", message: e.message || "收集上下文失败" });
    });
}

function proposeScheduled() {
  runPropose({ force: false });
}

function start() {
  if (timer) return;
  timer = setInterval(proposeScheduled, INTERVAL_MS);
  firstTimer = setTimeout(() => {
    firstTimer = null;
    proposeScheduled();
  }, FIRST_RUN_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
}

/** 手动触发：强制运行（不与执行队列互斥），返回 Promise<结果对象> */
function triggerNow() {
  return new Promise((resolve) => {
    runPropose({ force: true, onComplete: resolve });
  });
}

return { start, stop, triggerNow };

};
