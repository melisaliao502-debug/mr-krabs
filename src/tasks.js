"use strict";

const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

const resolveClaudeBin = require("./resolve-claude-bin");
const initTaskGraph = require("./task-graph");
/** 空闲自治执行链路使用的子代理身份（与提议子代理隔离，各自独立 `claude -p` 会话） */
const SUBAGENT_EXECUTOR = "mr-krabs-executor";

function executorSubagentEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MR_KRABS_SUBAGENT = SUBAGENT_EXECUTOR;
  return env;
}
const FEISHU_CLI = process.env.FEISHU_CLI || require("path").join(require("os").homedir(), "bin", "feishu-cli");

module.exports = function initTasks(ctx) {

function notifyTasksFileObservers() {
  if (typeof ctx.onTaskFileChanged === "function") {
    try { ctx.onTaskFileChanged(); } catch (e) { /* ignore */ }
  }
}

const TASKS_DIR = path.join(ctx.userDataPath || require("electron").app.getPath("home"), ".mr-krabs");
const TASKS_FILE = path.join(TASKS_DIR, "tasks.md");
const RESULTS_FILE = path.join(TASKS_DIR, "results.md");
const DELIVERABLES_DIR = path.join(TASKS_DIR, "deliverables");
const SKILLS_DIR = path.join(TASKS_DIR, "skills");
const TASK_INDEX_FILE = path.join(TASKS_DIR, "task-index.json");
// P1: 执行摘要目录（借鉴 Claude Code 的 Session Memory 增量摘要机制）
const SUMMARIES_DIR = path.join(TASKS_DIR, "session-summaries");
// P1-2: 项目隔离目录（借鉴 Claude Code Agent Memory 的三种 Scope）
// global: ~/.mr-krabs/skills/ — 跨项目通用技能
// project: ~/.mr-krabs/projects/<hash>/skills/ — 项目专属技能
const PROJECTS_DIR = path.join(TASKS_DIR, "projects");
// P2: 长期知识库（借鉴 Claude Code L4 MEMORY.md / memdir 机制）
// MEMORY.md: 入口文件，限 200 行 / 25KB，每次任务执行时注入 prompt
// memory/: topic 文件目录，按需检索加载（避免 token 膨胀）
const MEMORY_FILE = path.join(TASKS_DIR, "MEMORY.md");
const MEMORY_DIR = path.join(TASKS_DIR, "memory");
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25 * 1024;
// P2: 技能卡片容量控制
const SKILLS_MAX_COUNT = 50;       // 技能卡片上限
const SKILLS_MAX_AGE_DAYS = 90;    // 超过 90 天未被匹配的技能标记为过期

/** 根据工作目录生成项目 hash（用于隔离项目级数据） */
function getProjectHash(cwd) {
  if (!cwd || cwd === process.env.HOME) return null;
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

/** 获取项目级目录路径（如果有活跃项目） */
function getProjectDir() {
  const cwd = ctx.getProjectCwd ? ctx.getProjectCwd() : null;
  const hash = getProjectHash(cwd);
  if (!hash) return null;
  return path.join(PROJECTS_DIR, hash);
}

/** 确保项目级目录存在 */
function ensureProjectDir() {
  const dir = getProjectDir();
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // 写入项目元信息
    const cwd = ctx.getProjectCwd ? ctx.getProjectCwd() : null;
    const metaFile = path.join(dir, ".project-meta.json");
    fs.writeFileSync(metaFile, JSON.stringify({ cwd, createdAt: new Date().toISOString() }, null, 2), "utf8");
  }
  return dir;
}

/** 获取项目级技能目录 */
function getProjectSkillsDir() {
  const dir = getProjectDir();
  if (!dir) return null;
  const skillsDir = path.join(dir, "skills");
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
  return skillsDir;
}

/** 获取项目级摘要目录 */
function getProjectSummariesDir() {
  const dir = getProjectDir();
  if (!dir) return null;
  const summariesDir = path.join(dir, "session-summaries");
  if (!fs.existsSync(summariesDir)) fs.mkdirSync(summariesDir, { recursive: true });
  return summariesDir;
}

// ── 任务图谱 ──
const _graph = initTaskGraph(TASKS_DIR);

function ensureDir() {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function ensureTasksFile() {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) {
    fs.writeFileSync(TASKS_FILE, `# Mr. Krabs 任务清单

## 快速任务（空闲时自动执行）

## 长期任务（需要较长时间）

## Claude 推荐
`, "utf8");
  }
}

function ensureResultsFile() {
  ensureDir();
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, "# Mr. Krabs 交付报告\n", "utf8");
  }
}

function ensureDeliverablesDir() {
  ensureDir();
  if (!fs.existsSync(DELIVERABLES_DIR)) fs.mkdirSync(DELIVERABLES_DIR, { recursive: true });
}

function ensureSkillsDir() {
  ensureDir();
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

function ensureSummariesDir() {
  ensureDir();
  if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
}

// ── Task-to-file index ──

function readIndex() {
  try {
    if (fs.existsSync(TASK_INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(TASK_INDEX_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function writeIndex(index) {
  ensureDir();
  fs.writeFileSync(TASK_INDEX_FILE, JSON.stringify(index, null, 2), "utf8");
}

function indexSet(taskText, filepath) {
  const idx = readIndex();
  idx[taskText] = filepath;
  writeIndex(idx);
}

function rebuildIndexFromResults() {
  ensureResultsFile();
  const raw = fs.readFileSync(RESULTS_FILE, "utf8");
  const lines = raw.split("\n");
  const idx = readIndex();
  let changed = false;
  let currentTitle = null;
  let currentContent = [];
  let currentHasFile = false;

  function flushEntry() {
    if (!currentTitle) return;
    if (!idx[currentTitle] && !currentHasFile && currentContent.length) {
      const content = currentContent.join("\n").trim();
      if (content.length > 10) {
        const { filepath: fp } = saveDeliverable(currentTitle, content);
        idx[currentTitle] = fp;
        changed = true;
      }
    }
    currentTitle = null;
    currentContent = [];
    currentHasFile = false;
  }

  for (const line of lines) {
    const titleMatch = line.match(/^###\s+\[.*?\]\s*(.+)/);
    if (titleMatch) {
      flushEntry();
      currentTitle = titleMatch[1].trim();
      continue;
    }
    if (line.startsWith("## ")) {
      flushEntry();
      continue;
    }

    if (!currentTitle) continue;

    const fileMatch = line.match(/^- 交付文件：(.+)/);
    if (fileMatch) {
      const fp = fileMatch[1].trim();
      currentHasFile = true;
      if (!idx[currentTitle] && fs.existsSync(fp)) {
        idx[currentTitle] = fp;
        changed = true;
      }
      continue;
    }

    const resultMatch = line.match(/^- 结果：(.*)/);
    if (resultMatch) {
      currentContent.push(resultMatch[1]);
    } else if (currentContent.length && !line.startsWith("- 执行时间：") && !line.startsWith("- 执行失败")) {
      currentContent.push(line);
    }
  }
  flushEntry();

  if (changed) writeIndex(idx);
}

rebuildIndexFromResults();

// On startup, reset any stale "running" tasks back to "pending"
(function resetStaleRunning() {
  ensureTasksFile();
  const raw = fs.readFileSync(TASKS_FILE, "utf8");
  if (raw.includes("- [~]")) {
    const fixed = raw.replace(/^- \[~\]/gm, "- [ ]");
    fs.writeFileSync(TASKS_FILE, fixed, "utf8");
    console.log("Mr. Krabs Tasks: reset stale running tasks to pending");
  }
})();

// ── Content type detection ──

function detectContentType(content) {
  if (/<(!DOCTYPE|html|div|table|style|script)/i.test(content)) return "html";
  if (/\.(css)\s*\{/i.test(content) && !/^#/m.test(content)) return "html";

  const mdIndicators = [
    /^#{1,6}\s/m,
    /\*\*[^*]+\*\*/,
    /```[\s\S]*?```/,
    /^\|.*\|.*\|/m,
    /\[.+?\]\(.+?\)/,
    /^>\s/m,
  ];
  const mdCount = mdIndicators.filter(re => re.test(content)).length;
  if (mdCount >= 2) return "md";

  return "text";
}

// ── Deliverables ──

function saveDeliverable(taskText, content) {
  ensureDeliverablesDir();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5).replace(":", "");
  const slug = taskText.slice(0, 50).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/_$/, "");

  const type = detectContentType(content);
  const ext = type === "html" ? "html" : "md";
  const filename = `${dateStr}_${timeStr}_${slug}.${ext}`;
  const filepath = path.join(DELIVERABLES_DIR, filename);

  let fileContent;
  if (type === "html") {
    fileContent = content;
  } else {
    fileContent = `# ${taskText}\n\n> 执行时间：${dateStr} ${now.toTimeString().slice(0, 5)}\n\n${content}\n`;
  }

  fs.writeFileSync(filepath, fileContent, "utf8");
  return { filepath, type };
}

// ── Feishu upload ──

function uploadToFeishu(filepath, title) {
  return new Promise((resolve) => {
    if (!fs.existsSync(FEISHU_CLI)) {
      console.warn("Mr. Krabs Feishu: CLI not found at", FEISHU_CLI);
      resolve(null);
      return;
    }

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    execFile(FEISHU_CLI, ["doc", "import", filepath, "--title", title, "-o", "json"], {
      cwd: process.env.HOME,
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      env,
    }, (err, stdout, stderr) => {
      if (err) {
        console.warn("Mr. Krabs Feishu: upload failed:", err.message, stderr);
        resolve(null);
        return;
      }

      try {
        const result = JSON.parse(stdout);
        const url = result.url || result.document_url || result.link;
        if (url) {
          console.log(`Mr. Krabs Feishu: uploaded "${title}" → ${url}`);
          resolve(url);
          return;
        }
        const docId = result.document_id || result.documentId || result.doc_id;
        if (docId) {
          const feishuUrl = `https://feishu.cn/docx/${docId}`;
          console.log(`Mr. Krabs Feishu: uploaded "${title}" → ${feishuUrl}`);
          resolve(feishuUrl);
          return;
        }
        console.warn("Mr. Krabs Feishu: no URL in response:", stdout.slice(0, 300));
        resolve(null);
      } catch {
        const urlMatch = (stdout || "").match(/(https?:\/\/[^\s"']+feishu[^\s"']+)/);
        if (urlMatch) {
          console.log(`Mr. Krabs Feishu: uploaded "${title}" → ${urlMatch[1]}`);
          resolve(urlMatch[1]);
        } else {
          console.warn("Mr. Krabs Feishu: can't parse response:", (stdout || "").slice(0, 300));
          resolve(null);
        }
      }
    });
  });
}

// ── Markdown parsing ──

function readTasks() {
  ensureTasksFile();
  const raw = fs.readFileSync(TASKS_FILE, "utf8");
  return parseTasks(raw);
}

function parseTasks(md) {
  const lines = md.split("\n");
  let currentSection = "";
  const tasks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      currentSection = h2[1].trim();
      continue;
    }
    const checkbox = line.match(/^- \[([ x~!?])\]\s+(.+)/);
    if (checkbox) {
      const statusMap = { " ": "pending", "x": "done", "~": "running", "!": "review", "?": "proposed" };
      const status = statusMap[checkbox[1]] || "pending";
      const rawLine = checkbox[2].trim();
      const completedMatch = rawLine.match(/\(已完成\s*(\d{4}-\d{2}-\d{2})\s*\)/);
      const createdMatch = rawLine.match(/\(创建于\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*\)/);
      const proposedMatch = rawLine.match(/\(建议于\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*\)/);
      const completedAt = completedMatch ? completedMatch[1] : null;
      const createdAt = createdMatch ? createdMatch[1] : null;
      const proposedAt = proposedMatch ? proposedMatch[1] : null;
      const priority = rawLine.includes("#priority:high") ? "high" : rawLine.includes("#priority:low") ? "low" : "normal";
      const cleanText = rawLine
        .replace(/#priority:\w+/g, "")
        .replace(/\(已完成.*?\)/g, "")
        .replace(/\(创建于.*?\)/g, "")
        .replace(/\(建议于.*?\)/g, "")
        .trim();
      tasks.push({
        line: i,
        section: currentSection,
        status,
        text: cleanText,
        rawText: rawLine,
        priority,
        completedAt,
        createdAt,
        proposedAt,
      });
    }
  }
  return tasks;
}

function updateTaskStatus(lineIndex, newStatus) {
  ensureTasksFile();
  const lines = fs.readFileSync(TASKS_FILE, "utf8").split("\n");
  if (lineIndex >= lines.length) return;

  const marker = { pending: " ", done: "x", running: "~", review: "!", proposed: "?" }[newStatus] || " ";
  lines[lineIndex] = lines[lineIndex].replace(/^- \[[ x~!?]\]/, `- [${marker}]`);

  if (newStatus === "done") {
    const now = new Date().toISOString().slice(0, 10);
    if (!lines[lineIndex].includes("已完成")) {
      lines[lineIndex] += ` (已完成 ${now})`;
    }
  }

  fs.writeFileSync(TASKS_FILE, lines.join("\n"), "utf8");

  // ── 同步图谱状态 ──
  try {
    const node = _graph.findNodeByMdLine(lineIndex);
    if (node) {
      _graph.updateNodeStatus(node.id, newStatus);
    }
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to sync updateTaskStatus:", e.message);
  }

  notifyTasksFileObservers();
}

function formatTaskTimestamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function addTask(text, section, graphOpts) {
  ensureTasksFile();
  const raw = fs.readFileSync(TASKS_FILE, "utf8");
  const lines = raw.split("\n");
  const sectionTarget = section || "快速任务";

  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const h2 = lines[i].match(/^##\s+(.+)/);
    if (h2 && h2[1].includes(sectionTarget)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith("## ")) j++;
      insertAt = j;
      break;
    }
  }

  const newLine = `- [ ] ${text} (创建于 ${formatTaskTimestamp()})`;
  if (insertAt >= 0) {
    lines.splice(insertAt, 0, newLine);
  } else {
    lines.push("", `## ${sectionTarget}`, newLine);
  }

  fs.writeFileSync(TASKS_FILE, lines.join("\n"), "utf8");

  // ── 同步图谱 ──
  try {
    const opts = graphOpts || {};
    _graph.createNode(text, {
      status: "pending",
      originType: opts.originType || "user",
      originSource: opts.originSource || null,
      originParentTaskId: opts.originParentTaskId || null,
      contextSnapshot: opts.contextSnapshot || null,
      parentId: opts.parentId || null,
      dependsOn: opts.dependsOn || [],
      relatedIds: opts.relatedIds || [],
      tags: opts.tags || [],
      goalId: opts.goalId || null,
      mdLine: insertAt >= 0 ? insertAt : null,
    });
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to sync addTask:", e.message);
  }

  notifyTasksFileObservers();
}

function addProposals(proposalLines) {
  ensureTasksFile();
  const raw = fs.readFileSync(TASKS_FILE, "utf8");
  const allLines = raw.split("\n");
  let recIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].match(/^##/) && allLines[i].includes("推荐")) {
      recIdx = i;
      break;
    }
  }

  const ts = formatTaskTimestamp();
  const normalized = proposalLines.map(l => {
    const base = l.match(/^- \[\?\]/) ? l : `- [?] ${l.replace(/^[-*]\s*/, "")}`;
    if (/\(建议于\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\)/.test(base)) return base;
    return `${base} (建议于 ${ts})`;
  });

  if (recIdx >= 0) {
    let j = recIdx + 1;
    while (j < allLines.length && !allLines[j].startsWith("## ")) j++;
    allLines.splice(j, 0, ...normalized);
  } else {
    allLines.push("", "## Claude 推荐", ...normalized);
  }

  fs.writeFileSync(TASKS_FILE, allLines.join("\n"), "utf8");

  // ── 同步图谱：为每个提议创建节点 ──
  try {
    for (const line of normalized) {
      const textMatch = line.match(/^- \[\?\]\s*(.+?)(?:\s*\(建议于.*\))?$/);
      if (textMatch) {
        _graph.createNode(textMatch[1].trim(), {
          status: "proposed",
          originType: "proposal",
          originSource: "Mr. Krabs 主动提议",
        });
      }
    }
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to sync addProposals:", e.message);
  }

  console.log(`Mr. Krabs Tasks: added ${normalized.length} proposal(s)`);
  notifyTasksFileObservers();
}

function appendResult(title, rawContent, status) {
  ensureResultsFile();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);

  const tags = {
    delivered: "待审阅",
    needs_action: "需操作",
    failed: "执行失败",
    done: "已完成",
    partial: "部分完成",
  };
  const tag = tags[status] || "待审阅";

  let fileLine = "";
  if (rawContent && rawContent.trim()) {
    const { filepath, type } = saveDeliverable(title, rawContent);
    fileLine = `\n- 交付文件：${filepath}`;
    indexSet(title, filepath);

    if (type === "text") {
      uploadToFeishu(filepath, title).then(url => {
        if (url) {
          indexSet(title, url);
          console.log(`Mr. Krabs Tasks: "${title}" → Feishu: ${url}`);
        }
      });
    }
  }

  let existing = fs.readFileSync(RESULTS_FILE, "utf8");
  if (!existing.includes(`## ${dateStr}`)) {
    existing += `\n## ${dateStr}\n`;
  }

  const entry = `
### [${tag}] ${title}
- 执行时间：${timeStr}${fileLine}
`;

  const idx = existing.lastIndexOf(`## ${dateStr}`);
  const afterHeader = existing.indexOf("\n", idx) + 1;
  const before = existing.slice(0, afterHeader);
  const after = existing.slice(afterHeader);
  fs.writeFileSync(RESULTS_FILE, before + entry + after, "utf8");
}

// ── Skills system (Skill 5) — 四类技能卡片 + 失败模式沉淀 ──
// 借鉴 Claude Code Memory 的记忆类型分类（user/feedback/project/reference）
// Mr. Krabs 技能卡片分为：method（方法论）、gotcha（踩坑记录）、preference（用户偏好）、pattern（项目模式）
// 明确排除：可从代码/文档直接推导的信息、临时状态、可过期的版本号

const SKILL_TYPES = ["method", "gotcha", "preference", "pattern"];

function getSkillsList() {
  ensureSkillsDir();

  /** 从指定目录读取技能卡片 */
  function readSkillsFromDir(dir, scope) {
    if (!dir || !fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith(".md"))
        .map(f => {
          const content = fs.readFileSync(path.join(dir, f), "utf8");
          const nameMatch = content.match(/^#\s+技能[：:]\s*(.+)/m);
          const scenarioMatch = content.match(/^-\s*适用场景[：:]\s*(.+)/m);
          const typeMatch = content.match(/^-\s*类型[：:]\s*(.+)/m);
          const type = typeMatch ? typeMatch[1].trim() : "method";
          return {
            name: nameMatch ? nameMatch[1].trim() : f.replace(".md", ""),
            file: f,
            scenario: scenarioMatch ? scenarioMatch[1].trim() : "",
            type: SKILL_TYPES.includes(type) ? type : "method",
            scope: scope,
            content,
          };
        });
    } catch { return []; }
  }

  // P1-2: 合并全局技能 + 项目级技能（项目级优先，同名覆盖全局）
  const globalSkills = readSkillsFromDir(SKILLS_DIR, "global");
  const projectSkillsDir = getProjectSkillsDir();
  const projectSkills = readSkillsFromDir(projectSkillsDir, "project");

  // 项目级同名技能覆盖全局（按 name 去重）
  const nameSet = new Set(projectSkills.map(s => s.name));
  const merged = [...projectSkills, ...globalSkills.filter(s => !nameSet.has(s.name))];
  return merged;
}

/** 构建技能 manifest（轻量索引：文件名 + 名称 + 适用场景 + 类型），用于两阶段检索 */
function buildSkillManifest() {
  const skills = getSkillsList();
  if (!skills.length) return { skills, manifest: "" };
  const manifest = skills.map((s, i) =>
    `${i + 1}. [${s.type}] ${s.name}：${s.scenario || "(无描述)"}`
  ).join("\n");
  return { skills, manifest };
}

/**
 * 两阶段技能匹配（借鉴 Claude Code 的 findRelevantMemories）
 * Phase 1: 扫描所有技能卡片的 header 构建轻量 manifest
 * Phase 2: 用 Claude 选出最相关的 ≤3 个技能
 * 降级：如果 Claude 调用失败，回退到关键词匹配
 */
function matchSkills(taskText) {
  const { skills, manifest } = buildSkillManifest();
  if (!skills.length) return [];

  // 同步快速路径：关键词匹配（作为默认和降级方案）
  const keywords = taskText
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1);

  return skills.filter(s => {
    const haystack = (s.name + " " + s.scenario + " " + s.content).toLowerCase();
    return keywords.some(k => haystack.includes(k.toLowerCase()));
  }).slice(0, 3);
}

/**
 * 异步两阶段技能匹配：用 Claude 从 manifest 中选出最相关的技能
 * 返回 Promise<Skill[]>，调用方可 await 获取更精准的匹配结果
 */
function matchSkillsAsync(taskText) {
  return new Promise((resolve) => {
    const { skills, manifest } = buildSkillManifest();
    if (!skills.length || !manifest) { resolve([]); return; }

    // 如果技能卡片 ≤3 张，直接全部返回，不需要 Claude 筛选
    if (skills.length <= 3) { resolve(skills); return; }

    const prompt = `你是一个技能匹配助手。根据任务描述，从技能列表中选出最相关的 1-3 个技能。

任务：${taskText}

可用技能列表：
${manifest}

请只输出选中的技能编号（如 "1,3"），不要输出其他内容。如果没有相关技能，输出 NONE。`;

    const child = spawn(resolveClaudeBin(), ["-p"], {
      cwd: process.env.HOME,
      env: executorSubagentEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let finished = false;
    const killTimer = setTimeout(() => {
      if (!finished) { try { child.kill("SIGTERM"); } catch {} }
    }, 30000);

    child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      finished = true;
      clearTimeout(killTimer);
      // 降级到关键词匹配
      resolve(matchSkills(taskText));
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);

      if (code !== 0 || !stdoutBuf.trim() || stdoutBuf.trim() === "NONE") {
        resolve(matchSkills(taskText));
        return;
      }

      // 解析编号列表
      const nums = stdoutBuf.trim().match(/\d+/g);
      if (!nums) { resolve(matchSkills(taskText)); return; }

      const selected = nums
        .map(n => parseInt(n, 10) - 1)
        .filter(i => i >= 0 && i < skills.length)
        .map(i => skills[i]);

      if (selected.length > 0) {
        console.log(`Mr. Krabs Skills: async match selected ${selected.map(s => s.name).join(", ")}`);
        resolve(selected.slice(0, 3));
      } else {
        resolve(matchSkills(taskText));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractSkill(taskText, output) {
  ensureSkillsDir();

  const prompt = `刚完成的任务：${taskText}
结果摘要：${(output || "").slice(0, 500)}

这个任务中是否有可复用的方法或经验？如果有，输出一个技能卡片。

技能卡片有 4 种类型，请选择最合适的一种：
- method：可复用的方法论或步骤（如"如何做 X"）
- gotcha：踩坑记录或需要注意的陷阱（如"做 X 时要注意 Y"）
- preference：用户偏好或工作方式（如"用户喜欢 X 风格"）
- pattern：项目特有的模式或约定（如"这个项目的 X 总是用 Y 方式"）

排除以下内容（不要记录）：
- 可以直接从代码或文档推导出的信息
- 当前会话的临时状态
- 可过期的版本号、具体数值

输出格式：
# 技能：{名称}
- 类型：{method|gotcha|preference|pattern}
- 适用场景：{一句话描述什么时候该用这个技能}
- 方法：{具体步骤或要点}
- 学习来源：任务「${taskText.slice(0, 40)}」(${new Date().toISOString().slice(0, 10)})

如果没有值得记录的经验，输出 NONE`;

  /* 使用 spawn + stdin 管道传递 prompt，避免命令行参数长度/特殊字符问题 */
  const child = spawn(resolveClaudeBin(), ["-p"], {
    cwd: process.env.HOME,
    env: executorSubagentEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let finished = false;
  const killTimer = setTimeout(() => {
    if (!finished) { try { child.kill("SIGTERM"); } catch {} }
  }, 60000);

  child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
  child.stderr.on("data", () => {});
  child.on("error", () => { finished = true; clearTimeout(killTimer); });
  child.on("close", () => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    const result = stdoutBuf.trim();
    if (result === "NONE" || !result || !result.includes("# 技能")) return;

    const nameMatch = result.match(/^#\s+技能[：:]\s*(.+)/m);
    const typeMatch = result.match(/^-\s*类型[：:]\s*(.+)/m);
    const skillName = nameMatch ? nameMatch[1].trim() : "unnamed";
    const skillType = typeMatch ? typeMatch[1].trim() : "method";
    const slug = skillName.slice(0, 30).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
    const filename = `${slug}.md`;

    // P1-2: pattern/gotcha 写入项目级目录，method/preference 写入全局目录
    const isProjectScope = (skillType === "pattern" || skillType === "gotcha");
    const _projectSkillsDir = isProjectScope ? getProjectSkillsDir() : null;
    const targetDir = (isProjectScope && _projectSkillsDir) ? _projectSkillsDir : SKILLS_DIR;
    const filepath = path.join(targetDir, filename);

    fs.writeFileSync(filepath, result, "utf8");
    const scopeLabel = targetDir === SKILLS_DIR ? "global" : "project";
    console.log(`Mr. Krabs Tasks: extracted skill [${skillType}/${scopeLabel}] "${skillName}" → ${filename}`);
  });

  child.stdin.write(prompt);
  child.stdin.end();
}

/**
 * 失败模式沉淀（借鉴 Claude Code 的 feedback 记忆类型）
 * 任务失败或低 confidence 时自动提取"踩坑记录"，存为 gotcha 类型技能卡片
 * 下次遇到类似任务时自动注入，避免重蹈覆辙
 */
function extractFailurePattern(taskText, errorDetail) {
  ensureSkillsDir();

  const prompt = `一个任务执行失败了，请分析失败原因并提取可复用的避坑经验。

失败的任务：${taskText}
错误详情：${(errorDetail || "").slice(0, 800)}

如果这个失败包含可复用的教训（不是一次性的偶发错误），输出一个踩坑记录卡片：

# 技能：避坑 - {简短描述}
- 类型：gotcha
- 适用场景：{什么情况下可能遇到同样的问题}
- 方法：{如何避免或解决这个问题}
- 失败模式：{简述失败的根因}
- 学习来源：任务失败「${taskText.slice(0, 40)}」(${new Date().toISOString().slice(0, 10)})

排除以下情况（直接输出 NONE）：
- 网络超时、临时服务不可用等偶发错误
- 用户输入不完整导致的失败
- 环境配置问题（如缺少依赖）

如果不值得记录，输出 NONE`;

  const child = spawn(resolveClaudeBin(), ["-p"], {
    cwd: process.env.HOME,
    env: executorSubagentEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let finished = false;
  const killTimer = setTimeout(() => {
    if (!finished) { try { child.kill("SIGTERM"); } catch {} }
  }, 60000);

  child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
  child.stderr.on("data", () => {});
  child.on("error", () => { finished = true; clearTimeout(killTimer); });
  child.on("close", () => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    const result = stdoutBuf.trim();
    if (result === "NONE" || !result || !result.includes("# 技能")) return;

    const nameMatch = result.match(/^#\s+技能[：:]\s*(.+)/m);
    const skillName = nameMatch ? nameMatch[1].trim() : "unnamed-gotcha";
    const slug = skillName.slice(0, 30).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
    const filename = `gotcha_${slug}.md`;
    // P1-2: gotcha 优先写入项目级目录
    const _projSkillsDir = getProjectSkillsDir();
    const gotchaTargetDir = _projSkillsDir || SKILLS_DIR;
    const filepath = path.join(gotchaTargetDir, filename);

    fs.writeFileSync(filepath, result, "utf8");
    const _scopeLabel = gotchaTargetDir === SKILLS_DIR ? "global" : "project";
    console.log(`Mr. Krabs Tasks: extracted failure pattern [gotcha/${_scopeLabel}] "${skillName}" → ${filename}`);
  });

  child.stdin.write(prompt);
  child.stdin.end();
}

// ── P1: 执行摘要系统（借鉴 Claude Code 的 Session Memory 增量摘要） ──
// 每次任务完成后异步提取结构化摘要，存到 session-summaries/
// 下次相关任务启动时自动注入前序摘要，实现任务间上下文传递

function extractSessionSummary(taskText, output, status) {
  ensureSummariesDir();

  const prompt = `请为以下已完成的任务生成一份简短的结构化执行摘要。

任务：${taskText}
执行状态：${status}
结果摘要（前 600 字）：${(output || "").slice(0, 600)}

请输出以下格式的摘要（不要输出其他内容）：
---
task: ${taskText.slice(0, 80)}
status: ${status}
date: ${new Date().toISOString().slice(0, 10)}
---
## 做了什么
{一句话概括}

## 关键发现
{列出 1-3 个关键发现或结论，每个一行}

## 遗留问题
{如果有未解决的问题，列出来；没有则写"无"}

## 可复用上下文
{下次做类似任务时需要知道的关键信息，如路径、配置、注意事项}`;

  const child = spawn(resolveClaudeBin(), ["-p"], {
    cwd: process.env.HOME,
    env: executorSubagentEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let finished = false;
  const killTimer = setTimeout(() => {
    if (!finished) { try { child.kill("SIGTERM"); } catch {} }
  }, 60000);

  child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
  child.stderr.on("data", () => {});
  child.on("error", () => { finished = true; clearTimeout(killTimer); });
  child.on("close", () => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    const result = stdoutBuf.trim();
    if (!result || result.length < 20) return;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(":", "");
    const slug = taskText.slice(0, 40).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/_$/, "");
    const filename = `${dateStr}_${timeStr}_${slug}.md`;
    // P1-2: 有活跃项目时摘要写入项目级目录
    const _projSummariesDir = getProjectSummariesDir();
    const summaryTargetDir = _projSummariesDir || SUMMARIES_DIR;
    const filepath = path.join(summaryTargetDir, filename);

    fs.writeFileSync(filepath, result, "utf8");
    const _sumScope = summaryTargetDir === SUMMARIES_DIR ? "global" : "project";
    console.log(`Mr. Krabs Tasks: extracted session summary [${_sumScope}] → ${filename}`);
  });

  child.stdin.write(prompt);
  child.stdin.end();
}

/**
 * 获取最近的执行摘要（用于注入到下一个任务的 prompt 中）
 * 借鉴 Claude Code 的 lastSummarizedMessageId 增量思路：
 * 只加载最近 N 份摘要，避免 token 膨胀
 * P1-2: 合并 global + project 两级摘要，项目级摘要排在前面
 */
function getRecentSummaries(maxCount, maxCharsPerSummary) {
  ensureSummariesDir();
  const count = maxCount || 3;
  const maxChars = maxCharsPerSummary || 400;

  /** 从指定目录读取摘要文件列表（带完整路径） */
  function readSummariesFromDir(dir, scope) {
    if (!dir || !fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith(".md"))
        .map(f => ({ file: f, dir, scope }));
    } catch { return []; }
  }

  try {
    // 合并全局 + 项目级摘要
    const globalFiles = readSummariesFromDir(SUMMARIES_DIR, "global");
    const projectSummariesDir = getProjectSummariesDir();
    const projectFiles = readSummariesFromDir(projectSummariesDir, "project");

    // 按文件名排序（文件名含日期时间戳），取最近 N 份
    const allFiles = [...projectFiles, ...globalFiles]
      .sort((a, b) => b.file.localeCompare(a.file))
      .slice(0, count);

    if (!allFiles.length) return [];

    return allFiles.map(({ file, dir, scope }) => {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      const taskMatch = content.match(/^task:\s*(.+)/m);
      const taskName = taskMatch ? taskMatch[1].trim() : file.replace(".md", "");
      return {
        file,
        task: taskName,
        scope,
        summary: content.slice(0, maxChars),
      };
    });
  } catch { return []; }
}


// ── P2: 长期知识库系统（借鉴 Claude Code L4 memdir） ──

/** 确保 memory 目录存在 */
function ensureMemoryDir() {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

/**
 * 读取 MEMORY.md 入口文件（限 200 行 / 25KB）
 * 每次任务执行时注入 prompt，作为长期知识库的"常驻层"
 */
function getMemoryContent() {
  if (!fs.existsSync(MEMORY_FILE)) return "";
  try {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    // 容量控制：超过限制时截断并提示
    const lines = raw.split("\n");
    const bytes = Buffer.byteLength(raw, "utf8");
    if (lines.length > MEMORY_MAX_LINES || bytes > MEMORY_MAX_BYTES) {
      const truncated = lines.slice(0, MEMORY_MAX_LINES).join("\n").slice(0, MEMORY_MAX_BYTES);
      console.warn(`Mr. Krabs Memory: MEMORY.md exceeds limits (${lines.length} lines / ${bytes} bytes), truncated`);
      return truncated;
    }
    return raw;
  } catch { return ""; }
}

/**
 * 构建 topic 文件的轻量 manifest（文件名 + 首行描述）
 * 用于两阶段检索的 Phase 1
 */
function buildMemoryManifest() {
  ensureMemoryDir();
  try {
    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md"));
    if (!files.length) return { files: [], manifest: "" };

    const entries = files.map((f, i) => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, f), "utf8");
      // 取首行非空内容作为描述（通常是 # 标题）
      const firstLine = content.split("\n").find(l => l.trim()) || f;
      const desc = firstLine.replace(/^#+\s*/, "").trim().slice(0, 80);
      return { file: f, desc, content };
    });

    const manifest = entries.map((e, i) =>
      `${i + 1}. ${e.file}: ${e.desc}`
    ).join("\n");

    return { files: entries, manifest };
  } catch { return { files: [], manifest: "" }; }
}

/**
 * 异步两阶段 topic 检索（借鉴 Claude Code findRelevantMemories）
 * Phase 1: 扫描所有 topic 文件的 header 构建 manifest
 * Phase 2: 用 Claude 选出最相关的 ≤3 个 topic
 * 返回 Promise<string[]>，每个元素是 topic 文件的完整内容
 */
function findRelevantMemories(taskText) {
  return new Promise((resolve) => {
    const { files, manifest } = buildMemoryManifest();
    if (!files.length || !manifest) { resolve([]); return; }

    // 如果 topic 文件 ≤3 个，直接全部返回
    if (files.length <= 3) {
      resolve(files.map(f => ({ file: f.file, content: f.content.slice(0, 800) })));
      return;
    }

    const prompt = `你是一个知识库检索助手。根据任务描述，从知识库 topic 列表中选出最相关的 1-3 个文件。

任务：${taskText}

可用 topic 列表：
${manifest}

请只输出选中的编号（如 "1,3"），不要输出其他内容。如果没有相关 topic，输出 NONE。`;

    const child = spawn(resolveClaudeBin(), ["-p"], {
      cwd: process.env.HOME,
      env: executorSubagentEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let finished = false;
    const killTimer = setTimeout(() => {
      if (!finished) { try { child.kill("SIGTERM"); } catch {} }
    }, 30000);

    child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      finished = true;
      clearTimeout(killTimer);
      resolve([]);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);

      if (code !== 0 || !stdoutBuf.trim() || stdoutBuf.trim() === "NONE") {
        resolve([]);
        return;
      }

      const nums = stdoutBuf.trim().match(/\d+/g);
      if (!nums) { resolve([]); return; }

      const selected = nums
        .map(n => parseInt(n, 10) - 1)
        .filter(i => i >= 0 && i < files.length)
        .map(i => ({ file: files[i].file, content: files[i].content.slice(0, 800) }));

      if (selected.length > 0) {
        console.log(`Mr. Krabs Memory: selected topics: ${selected.map(s => s.file).join(", ")}`);
        resolve(selected.slice(0, 3));
      } else {
        resolve([]);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ── P2: 技能卡片容量控制（借鉴 Claude Code 的 200 行限制 + alreadySurfaced 去重） ──

/** 已在本轮队列中展示过的技能（避免重复注入同一技能） */
const _surfacedSkills = new Set();

/** 重置已展示记录（每轮队列开始时调用） */
function resetSurfacedSkills() {
  _surfacedSkills.clear();
}

/**
 * 技能卡片容量控制：
 * 1. 超过 SKILLS_MAX_COUNT 时，按最后修改时间淘汰最旧的
 * 2. 超过 SKILLS_MAX_AGE_DAYS 未修改的技能标记为过期（文件名加 _expired 后缀）
 * 3. 已在本轮展示过的技能不再重复注入
 */
function pruneSkills() {
  ensureSkillsDir();
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
    if (files.length <= SKILLS_MAX_COUNT) return;

    // 按修改时间排序，淘汰最旧的
    const withStats = files.map(f => {
      const fp = path.join(SKILLS_DIR, f);
      const stat = fs.statSync(fp);
      return { file: f, mtime: stat.mtimeMs, path: fp };
    }).sort((a, b) => b.mtime - a.mtime);

    const now = Date.now();
    const maxAgeMs = SKILLS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    // 标记过期（超龄 + 超量的部分）
    const toRemove = withStats.slice(SKILLS_MAX_COUNT);
    for (const item of toRemove) {
      const age = now - item.mtime;
      if (age > maxAgeMs) {
        // 过期：重命名为 _expired（保留但不再加载）
        const expiredPath = item.path.replace(/\.md$/, "_expired.md.bak");
        fs.renameSync(item.path, expiredPath);
        console.log(`Mr. Krabs Skills: expired "${item.file}" (age: ${Math.round(age / 86400000)}d)`);
      }
    }
  } catch (e) {
    console.warn("Mr. Krabs Skills: pruneSkills error:", e.message);
  }
}

/**
 * 过滤已展示的技能（alreadySurfaced 去重）
 * 返回未展示过的技能，并标记为已展示
 */
function filterAndMarkSurfaced(skills) {
  const fresh = skills.filter(s => !_surfacedSkills.has(s.name));
  for (const s of fresh) _surfacedSkills.add(s.name);
  return fresh;
}

// ── Prompt enrichment (Skill 3) ──

function buildEnrichedPrompt(task, relevantTopics) {
  const parts = [];

  parts.push(`【子代理身份】你是 Mr. Krabs 的「执行子代理」（独立 Claude 会话，与「提议子代理 mr-krabs-proposal」不共享上下文、不延续对话）。
你只负责完成清单中的具体任务并交付结果，不要承担「帮用户想新任务」的职责。

正在执行的任务：
「${task.text}」`);

  // Project context
  const cwd = ctx.getProjectCwd ? ctx.getProjectCwd() : process.env.HOME;
  parts.push(`\n## 上下文
- 工作目录：${cwd}`);

  // P2: 注入 MEMORY.md 长期知识库（常驻层，每次都注入）
  const memoryContent = getMemoryContent();
  if (memoryContent) {
    parts.push(`\n## 长期知识库（MEMORY.md）\n${memoryContent}`);
  }

  // P2: 注入按需检索的 topic 文件（由 executeTask 异步预获取）
  if (relevantTopics && relevantTopics.length) {
    const topicText = relevantTopics.map(t =>
      `### ${t.file}\n${t.content}`
    ).join("\n\n");
    parts.push(`\n## 相关知识库 topic（按需加载）\n${topicText}`);
  }

  // P1: 注入前序任务的执行摘要（借鉴 Claude Code 的 Session Memory）
  const summaries = getRecentSummaries(3, 400);
  if (summaries.length) {
    const summaryText = summaries.map(s =>
      `  ### ${s.task}\n${s.summary.split("\n").map(l => "  " + l).join("\n")}`
    ).join("\n\n");
    parts.push(`\n## 前序任务摘要（最近 ${summaries.length} 个任务的执行记录）\n${summaryText}`);
  }

  // Recent related results
  try {
    ensureResultsFile();
    const results = fs.readFileSync(RESULTS_FILE, "utf8");
    const entries = results.split("\n")
      .filter(l => l.startsWith("### "))
      .slice(0, 5)
      .map(l => l.replace(/^###\s*/, "").slice(0, 80));
    if (entries.length) {
      parts.push(`- 相关已完成任务：\n${entries.map(e => "  - " + e).join("\n")}`);
    }
  } catch {}

  // P2: 技能卡片容量控制 — 每轮队列启动时清理过期技能
  pruneSkills();

  // Matched skills — 区分 method/pattern 和 gotcha 类型 + P2 alreadySurfaced 去重
  const rawMatched = matchSkills(task.text);
  const matched = filterAndMarkSurfaced(rawMatched);
  if (matched.length) {
    // 正向技能（method, preference, pattern）
    const positiveSkills = matched.filter(s => s.type !== "gotcha");
    if (positiveSkills.length) {
      const skillSummary = positiveSkills.map(s => {
        const methodMatch = s.content.match(/^-\s*方法[：:]\s*(.+)/m);
        return `  - [${s.type}] ${s.name}：${methodMatch ? methodMatch[1].trim().slice(0, 100) : s.scenario.slice(0, 100)}`;
      }).join("\n");
      parts.push(`- 可用技能：\n${skillSummary}`);
    }

    // 踩坑记录（gotcha）— 单独注入为"注意事项"，提高 Agent 警觉
    const gotchas = matched.filter(s => s.type === "gotcha");
    if (gotchas.length) {
      const gotchaSummary = gotchas.map(s => {
        const failureMatch = s.content.match(/^-\s*失败模式[：:]\s*(.+)/m);
        const methodMatch = s.content.match(/^-\s*方法[：:]\s*(.+)/m);
        return `  - ⚠️ ${s.name}：${failureMatch ? failureMatch[1].trim().slice(0, 80) : ""}${methodMatch ? " → " + methodMatch[1].trim().slice(0, 80) : ""}`;
      }).join("\n");
      parts.push(`- ⚠️ 历史踩坑记录（请注意避免）：\n${gotchaSummary}`);
    }
  }

  // ── 任务图谱关系上下文注入 ──
  try {
    const graphNode = _graph.findNodeByText(task.text);
    if (graphNode) {
      const graphCtx = _graph.formatTaskContextForPrompt(graphNode.id);
      if (graphCtx) {
        parts.push(`\n## 任务关系\n${graphCtx}`);
      }
    }
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to inject graph context:", e.message);
  }

  // Output format requirements (Skill 4)
  parts.push(`
## 输出要求
1. 直接产出完整结果（Markdown 或 HTML）
2. 在结果的最末尾，另起一行加一个 JSON 块来标记交互需求，格式如下：
\`\`\`json
{"status": "complete", "missing": "", "confidence": 0.9}
\`\`\`

status 字段说明：
- "complete"：任务已完全完成，结果可靠
- "partial"：有初步结果但不完整，说明还差什么
- "needs_input"：必须用户提供信息才能继续，在 missing 里说明需要什么

confidence 是 0-1 之间的数字，表示你对结果质量的自信程度。
如果 confidence < 0.7，请在 missing 里说明原因。`);

  return parts.join("\n");
}

// ── JSON result parsing (Skill 4) ──

function parseTaskResult(output) {
  const result = {
    status: "complete",
    missing: "",
    confidence: 0.8,
    cleanOutput: output,
  };

  const jsonMatch = output.match(/```json\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      result.status = parsed.status || "complete";
      result.missing = parsed.missing || "";
      result.confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.8;
      result.cleanOutput = output.slice(0, jsonMatch.index).trim();
    } catch {
      // JSON parse failed — use regex fallbacks
      if (/needs_input|需要你提供|请你补充|缺少.*信息/.test(output)) {
        result.status = "needs_input";
        result.confidence = 0.4;
      }
    }
  } else {
    // No JSON block — heuristic classification
    if (/需要你|请你|请确认|你需要|手动|你来/.test(output)) {
      result.status = "partial";
      result.confidence = 0.5;
    }
  }

  return result;
}

// ── Task execution ──

let runningChild = null;
let taskQueueActive = false;
let currentTaskText = "";
let preferredTaskLine = null;
const failedThisRun = new Set();

function getNextPendingTask() {
  const tasks = readTasks();
  const pending = tasks.filter(t => t.status === "pending" && !failedThisRun.has(t.line));

  // ── 图谱依赖检查：过滤掉依赖未满足的任务 ──
  const executablePending = pending.filter(t => {
    try {
      const node = _graph.findNodeByText(t.text);
      if (node && !_graph.areDependenciesMet(node.id)) {
        console.log(`Mr. Krabs Tasks: skipping "${t.text.slice(0, 40)}…" — dependencies not met`);
        return false;
      }
    } catch (e) { /* 图谱查询失败不阻塞任务执行 */ }
    return true;
  });

  // 如果所有任务都被依赖阻塞，回退到原始 pending 列表（避免死锁）
  const candidates = executablePending.length > 0 ? executablePending : pending;

  if (preferredTaskLine !== null) {
    const preferred = candidates.find(t => t.line === preferredTaskLine);
    preferredTaskLine = null;
    if (preferred) return preferred;
  }
  candidates.sort((a, b) => {
    const prio = { high: 0, normal: 1, low: 2 };
    const pa = prio[a.priority] ?? 1;
    const pb = prio[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    const isQuickA = a.section.includes("快速") ? 0 : 1;
    const isQuickB = b.section.includes("快速") ? 0 : 1;
    return isQuickA - isQuickB;
  });
  return candidates[0] || null;
}

async function executeTask(task, done) {
  updateTaskStatus(task.line, "running");
  currentTaskText = task.text;

  if (ctx.onTaskStart) ctx.onTaskStart(task.text);

  // P2: 异步获取相关 topic 文件（不阻塞，超时降级为空）
  const topicPromise = findRelevantMemories(task.text).catch(() => []);
  const relevantTopics = await topicPromise;

  const enrichedPrompt = buildEnrichedPrompt(task, relevantTopics);
  const isLong = task.section.includes("长期");

  const cwd = ctx.getProjectCwd ? ctx.getProjectCwd() : process.env.HOME;
  const timeoutMs = isLong ? 900000 : 300000;

  console.log(`Mr. Krabs Tasks: [${SUBAGENT_EXECUTOR}] executing "${task.text.slice(0, 60)}…" (timeout ${timeoutMs / 1000}s, prompt ${enrichedPrompt.length} chars)`);

  /* 使用 spawn + stdin 管道传递 prompt，避免命令行参数长度/特殊字符问题 */
  const child = spawn(resolveClaudeBin(), ["-p"], {
    cwd,
    env: executorSubagentEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let finished = false;
  let killTimer = setTimeout(() => {
    if (!finished) {
      console.warn(`Mr. Krabs Tasks: timeout after ${timeoutMs / 1000}s, killing`);
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutBuf += text;
    if (ctx.onTaskOutput) ctx.onTaskOutput(task.text, text);
  });

  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });

  child.on("error", (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    runningChild = null;
    currentTaskText = "";
    console.warn("Mr. Krabs Tasks: spawn error:", err.message);
    failedThisRun.add(task.line);
    updateTaskStatus(task.line, "pending");
    appendResult(task.text, `- 启动失败：${err.message}`, "failed");
    if (ctx.onTaskFinish) ctx.onTaskFinish(task.text, null, err);
    done(err);
  });

  child.on("close", (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    runningChild = null;
    currentTaskText = "";

    const output = stdoutBuf.trim();
    const errOutput = stderrBuf.trim();

    console.log(`Mr. Krabs Tasks: process exited with code ${code}, stdout ${output.length} bytes, stderr ${errOutput.length} bytes`);

    if (code !== 0) {
      const detail = errOutput || `进程退出码 ${code}` + (output ? `\n输出：${output.slice(0, 300)}` : "");
      console.warn("Mr. Krabs Tasks: failed:", detail.slice(0, 200));
      failedThisRun.add(task.line);
      updateTaskStatus(task.line, "pending");
      appendResult(task.text, detail.slice(0, 1000), "failed");
      // 失败模式沉淀：异步提取踩坑记录
      extractFailurePattern(task.text, detail.slice(0, 1000));
      if (ctx.onTaskFinish) ctx.onTaskFinish(task.text, null, new Error(detail.slice(0, 200)));
      done(new Error(detail));
    } else {
      handleTaskSuccess(task, output, done);
    }
  });

  runningChild = child;

  /* 将 prompt 写入 stdin 并关闭，让 claude 开始处理 */
  child.stdin.write(enrichedPrompt);
  child.stdin.end();
}

function handleTaskSuccess(task, output, done) {
  const parsed = parseTaskResult(output);

  if (parsed.status === "complete" && parsed.confidence >= 0.7) {
    updateTaskStatus(task.line, "review");
    appendResult(task.text, parsed.cleanOutput, "delivered");
    extractSkill(task.text, parsed.cleanOutput);
    // P1: 异步提取执行摘要，供后续任务上下文传递
    extractSessionSummary(task.text, parsed.cleanOutput, "complete");
    recommendTasks(task.text, parsed.cleanOutput);
    if (ctx.onTaskFinish) ctx.onTaskFinish(task.text, parsed.cleanOutput, null);
    done(null);

  } else if (parsed.status === "needs_input") {
    updateTaskStatus(task.line, "review");
    appendResult(task.text, parsed.cleanOutput, "needs_action");
    // P1: 即使需要输入，也记录摘要（记录"做到哪了"）
    extractSessionSummary(task.text, parsed.cleanOutput, "needs_input");
    if (ctx.onNeedsInput) {
      ctx.onNeedsInput(task.text, parsed.missing || "需要更多信息才能完成此任务");
    }
    if (ctx.onTaskFinish) ctx.onTaskFinish(task.text, parsed.cleanOutput, null);
    done(null);

  } else if (parsed.status === "partial" || parsed.confidence < 0.7) {
    // Low confidence — try one round of reflection (Skill 5)
    if (!task._reflected) {
      console.log(`Mr. Krabs Tasks: low confidence (${parsed.confidence}), running reflection...`);
      doReflection(task, parsed, done);
    } else {
      updateTaskStatus(task.line, "review");
      appendResult(task.text, parsed.cleanOutput, "partial");
      // P1: 反思后仍为 partial，记录摘要 + 提取失败模式
      extractSessionSummary(task.text, parsed.cleanOutput, "partial");
      extractFailurePattern(task.text, `低置信度(${parsed.confidence})：${parsed.missing || parsed.cleanOutput.slice(0, 300)}`);
      if (ctx.onAttention) ctx.onAttention();
      if (ctx.onTaskFinish) ctx.onTaskFinish(task.text, parsed.cleanOutput, null);
      done(null);
    }

  } else {
    updateTaskStatus(task.line, "review");
    appendResult(task.text, parsed.cleanOutput, "delivered");
    extractSkill(task.text, parsed.cleanOutput);
    extractSessionSummary(task.text, parsed.cleanOutput, "delivered");
    recommendTasks(task.text, parsed.cleanOutput);
    if (ctx.onTaskFinish) ctx.onTaskFinish(task.text, parsed.cleanOutput, null);
    done(null);
  }
}

// ── Self-reflection (Skill 5) ──

function doReflection(task, parsed, done) {
  const reflectionPrompt = `【子代理身份】你是 Mr. Krabs「执行子代理」（${SUBAGENT_EXECUTOR}），仍在同一条任务链中的新一轮独立 \`claude -p\` 调用，与「提议子代理」无关。

你之前执行了任务「${task.text}」，但结果质量不够（confidence: ${parsed.confidence}）。
${parsed.missing ? `原因：${parsed.missing}` : ""}

之前的输出（前500字）：
${parsed.cleanOutput.slice(0, 500)}

请改进后重新输出完整结果。仍然在最末尾加 JSON 块：
\`\`\`json
{"status": "complete|partial|needs_input", "missing": "...", "confidence": 0.9}
\`\`\``;

  const cwd = ctx.getProjectCwd ? ctx.getProjectCwd() : process.env.HOME;

  /* 使用 spawn + stdin 管道传递 prompt，避免命令行参数长度/特殊字符问题 */
  const child = spawn(resolveClaudeBin(), ["-p"], {
    cwd,
    env: executorSubagentEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let finished = false;

  const killTimer = setTimeout(() => {
    if (!finished) {
      try { child.kill("SIGTERM"); } catch {}
    }
  }, 300000);

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    if (ctx.onTaskOutput) ctx.onTaskOutput(task.text, chunk.toString("utf8"));
  });

  child.stderr.on("data", () => {});

  child.on("close", (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);

    if (code !== 0 || !stdoutBuf.trim()) {
      updateTaskStatus(task.line, "review");
      appendResult(task.text, parsed.cleanOutput, "partial");
      if (ctx.onAttention) ctx.onAttention();
      if (ctx.onTaskFinish) ctx.onTaskFinish(task.text, parsed.cleanOutput, null);
      done(null);
      return;
    }

    const reflectedTask = { ...task, _reflected: true };
    handleTaskSuccess(reflectedTask, stdoutBuf.trim(), done);
  });

  child.on("error", () => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    updateTaskStatus(task.line, "review");
    appendResult(task.text, parsed.cleanOutput, "partial");
    if (ctx.onTaskFinish) ctx.onTaskFinish(task.text, parsed.cleanOutput, null);
    done(null);
  });

  /* 将 prompt 写入 stdin 并关闭，让 claude 开始处理 */
  child.stdin.write(reflectionPrompt);
  child.stdin.end();
}

// ── Queue management ──

function runTaskQueue() {
  if (taskQueueActive) return;
  taskQueueActive = true;
  failedThisRun.clear();
  resetSurfacedSkills(); // P2: 每轮队列重置已展示技能记录

  const runNext = () => {
    if (!taskQueueActive) return;

    const task = getNextPendingTask();
    if (!task) {
      taskQueueActive = false;
      console.log("Mr. Krabs Tasks: queue empty, done.");
      if (ctx.onQueueEmpty) ctx.onQueueEmpty();
      return;
    }

    executeTask(task, () => {
      setTimeout(runNext, 2000);
    });
  };

  runNext();
}

function stopTaskQueue() {
  taskQueueActive = false;
  preferredTaskLine = null;
  if (runningChild) {
    try { runningChild.kill(); } catch {}
    runningChild = null;
  }
}

function pauseTaskQueue() {
  taskQueueActive = false;
  preferredTaskLine = null;
}

function isRunning() { return taskQueueActive; }

function getStatus() {
  if (!taskQueueActive && currentTaskText) return { state: "finishing", task: currentTaskText };
  if (!taskQueueActive) return { state: "idle", task: null };
  if (currentTaskText) return { state: "running", task: currentTaskText };
  return { state: "waiting", task: null };
}

// ── Task editing ──

function editTask(lineIndex, newText) {
  ensureTasksFile();
  const lines = fs.readFileSync(TASKS_FILE, "utf8").split("\n");
  if (lineIndex >= lines.length) return;
  const match = lines[lineIndex].match(/^- \[([ x~!?])\]/);
  if (!match) return;
  lines[lineIndex] = `- [${match[1]}] ${newText}`;
  fs.writeFileSync(TASKS_FILE, lines.join("\n"), "utf8");
  notifyTasksFileObservers();
}

function deleteTask(lineIndex) {
  ensureTasksFile();
  const lines = fs.readFileSync(TASKS_FILE, "utf8").split("\n");
  if (lineIndex >= lines.length) return;

  // ── 同步图谱：删除节点 ──
  try {
    const node = _graph.findNodeByMdLine(lineIndex);
    if (node) _graph.deleteNode(node.id);
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to sync deleteTask:", e.message);
  }

  lines.splice(lineIndex, 1);
  fs.writeFileSync(TASKS_FILE, lines.join("\n"), "utf8");
  notifyTasksFileObservers();
}

/**
 * 移动任务行：将 fromLine 行移动到 toLine 行的位置
 * 用于拖拽排序调整优先级
 */
function moveTask(fromLine, toLine) {
  ensureTasksFile();
  const lines = fs.readFileSync(TASKS_FILE, "utf8").split("\n");
  if (fromLine < 0 || fromLine >= lines.length) return false;
  if (toLine < 0 || toLine >= lines.length) return false;
  if (fromLine === toLine) return false;

  // 只允许移动 checkbox 行
  if (!/^- \[[ x~!?]\]/.test(lines[fromLine])) return false;
  if (!/^- \[[ x~!?]\]/.test(lines[toLine])) return false;

  const [removed] = lines.splice(fromLine, 1);
  lines.splice(toLine, 0, removed);
  fs.writeFileSync(TASKS_FILE, lines.join("\n"), "utf8");
  notifyTasksFileObservers();
  return true;
}

function appendToTask(lineIndex, supplement) {
  ensureTasksFile();
  const lines = fs.readFileSync(TASKS_FILE, "utf8").split("\n");
  if (lineIndex >= lines.length) return false;
  const match = lines[lineIndex].match(/^- \[([ x~!?])\]\s+(.*)/);
  if (!match) return false;
  lines[lineIndex] = `- [${match[1]}] ${match[2].trim()}；补充：${supplement}`;
  fs.writeFileSync(TASKS_FILE, lines.join("\n"), "utf8");

  // ── 同步图谱：记录补充历史 ──
  try {
    const node = _graph.findNodeByMdLine(lineIndex);
    if (node) {
      _graph.addHistoryEntry(node.id, "supplemented", `补充信息：${supplement}`);
    }
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to sync appendToTask:", e.message);
  }

  notifyTasksFileObservers();
  return true;
}

function appendToTaskByText(taskText, supplement) {
  ensureTasksFile();
  const tasks = readTasks();
  const found = tasks.find(t => t.text === taskText || t.rawText.includes(taskText.slice(0, 30)));
  if (found) {
    return appendToTask(found.line, supplement);
  }
  addTask(`${taskText}；补充：${supplement}`, "快速任务");
  return true;
}

function rerunTask(taskText) {
  ensureTasksFile();
  const tasks = readTasks();
  const found = tasks.find(t => t.text.includes(taskText.slice(0, 30)) || taskText.includes(t.text.slice(0, 30)));
  if (found) {
    updateTaskStatus(found.line, "pending");
    if (!taskQueueActive) {
      runTaskQueue();
    }
    return true;
  }
  return false;
}

function openDeliverable(filepath) {
  if (filepath.startsWith("http")) {
    require("electron").shell.openExternal(filepath);
    return true;
  }
  if (!fs.existsSync(filepath)) return false;
  if (filepath.endsWith(".html") || filepath.endsWith(".css")) {
    require("electron").shell.openExternal("file://" + filepath);
  } else {
    require("electron").shell.openPath(filepath);
  }
  return true;
}

function getDeliverables() {
  ensureDeliverablesDir();
  return fs.readdirSync(DELIVERABLES_DIR)
    .filter(f => f.endsWith(".md") || f.endsWith(".html"))
    .sort()
    .reverse()
    .map(f => ({ name: f, path: path.join(DELIVERABLES_DIR, f) }));
}

function createFollowUp(originalText, followUpPrompt) {
  const text = `继续上一个任务「${originalText.slice(0, 40)}${originalText.length > 40 ? "…" : ""}」：${followUpPrompt}`;

  // ── 图谱：查找原始任务节点，建立 follow-up 关系 ──
  let graphOpts = { originType: "follow-up", originSource: `follow-up of: ${originalText.slice(0, 60)}` };
  try {
    const parentNode = _graph.findNodeByText(originalText);
    if (parentNode) {
      graphOpts.originParentTaskId = parentNode.id;
      graphOpts.parentId = parentNode.id;
      graphOpts.relatedIds = [parentNode.id];
    }
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to find parent for follow-up:", e.message);
  }

  addTask(text, "快速任务", graphOpts);
}

function prioritizeTask(lineIndex) {
  preferredTaskLine = lineIndex;
}

// ── Scheduled execution ──

let scheduledTimers = [];

function startScheduledExecution(scheduleConfig) {
  stopScheduledExecution();

  const hours = scheduleConfig || [2, 14];

  const check = () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    if (hours.includes(h) && m === 0 && !taskQueueActive) {
      console.log(`Mr. Krabs Tasks: scheduled trigger at ${h}:00`);
      runTaskQueue();
    }
  };

  scheduledTimers.push(setInterval(check, 60000));
}

function stopScheduledExecution() {
  for (const t of scheduledTimers) clearInterval(t);
  scheduledTimers = [];
}

// ── Smart recommend (post-task) ──

function recommendTasks(lastTaskText, lastResult) {
  const prompt = `Based on a completed task and its result, suggest 1-2 follow-up tasks. Output ONLY markdown checkbox lines like "- [?] 建议：task description". No other text.

Completed task: ${lastTaskText}
Result summary: ${(lastResult || "").slice(0, 500)}`;

  /* 使用 spawn + stdin 管道传递 prompt，避免命令行参数长度/特殊字符问题 */
  const child = spawn(resolveClaudeBin(), ["-p"], {
    cwd: process.env.HOME,
    env: executorSubagentEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let finished = false;
  const killTimer = setTimeout(() => {
    if (!finished) { try { child.kill("SIGTERM"); } catch {} }
  }, 60000);

  child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
  child.stderr.on("data", () => {});
  child.on("error", () => { finished = true; clearTimeout(killTimer); });
  child.on("close", () => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    const stdout = stdoutBuf;
    // 解析推荐的任务行：兼容 - [ ] 和 - [?] 格式，统一转成 proposed
    const rawLines = stdout.split("\n").filter(l => l.match(/^- \[[ ?]\]/));
    if (!rawLines.length) return;

    // 统一转为 proposed 格式 - [?]，需要用户采纳后才执行
    const proposals = rawLines.map(l => {
      let text = l.replace(/^- \[[ ?]\]\s*/, "").trim();
      if (!/^建议[：:]/.test(text)) text = `建议：${text}`;
      return `- [?] ${text}`;
    });

    addProposals(proposals);
    console.log(`Mr. Krabs Tasks: added ${proposals.length} recommended task(s) as proposals`);
  });

  child.stdin.write(prompt);
  child.stdin.end();
}

// ── Public API ──

function getTaskList() {
  const tasks = readTasks();
  const idx = readIndex();
  for (const t of tasks) {
    if (idx[t.text]) {
      t.file = idx[t.text];
    } else {
      const match = Object.keys(idx).find(k =>
        t.text.includes(k.slice(0, 20)) || k.includes(t.text.slice(0, 20))
      );
      if (match) t.file = idx[match];
    }

    // ── 附加图谱信息 ──
    try {
      const node = _graph.findNodeByText(t.text);
      if (node) {
        t.graphId = node.id;
        t.parentId = node.parentId;
        t.childIds = node.childIds;
        t.dependsOn = node.dependsOn;
        t.blockedBy = node.blockedBy;
        t.relatedIds = node.relatedIds;
        t.origin = node.origin;
        t.tags = node.tags;
        t.goalId = node.goalId;
        t.depsReady = _graph.areDependenciesMet(node.id);
      }
    } catch (e) { /* 图谱查询失败不影响任务列表 */ }
  }
  return tasks;
}

function getResults() {
  ensureResultsFile();
  return fs.readFileSync(RESULTS_FILE, "utf8");
}

function getTasksRaw() {
  ensureTasksFile();
  return fs.readFileSync(TASKS_FILE, "utf8");
}

function cleanup() {
  stopTaskQueue();
  stopScheduledExecution();
}

/** 执行子代理是否占线（队列在跑或有 claude 子进程），供提议子代理避让 */
function isExecutorBusy() {
  return taskQueueActive || runningChild !== null;
}

return {
  readTasks, addTask, updateTaskStatus, editTask, deleteTask, moveTask,
  appendToTask, appendToTaskByText, rerunTask,
  createFollowUp, prioritizeTask, openDeliverable, getDeliverables,
  appendResult, getTaskList, getResults, getTasksRaw,
  addProposals, getSkillsList, matchSkillsAsync, getRecentSummaries,
  getMemoryContent, findRelevantMemories, pruneSkills,
  runTaskQueue, stopTaskQueue, pauseTaskQueue, isRunning, getStatus, isExecutorBusy,
  startScheduledExecution, stopScheduledExecution,
  recommendTasks,
  cleanup,
  get TASKS_FILE() { return TASKS_FILE; },
  get RESULTS_FILE() { return RESULTS_FILE; },
  // ── 图谱 API ──
  getTaskGraph: () => _graph,
};

};
