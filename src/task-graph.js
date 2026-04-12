"use strict";

/**
 * task-graph.js — Mr. Krabs 任务图谱管理层
 *
 * 在 tasks.md 平铺清单之上，维护一份结构化的任务关系图谱（task-graph.json）。
 * 每个任务节点包含：来源 context、依赖关系、子任务树、决策历史。
 * 图谱与 tasks.md 双向同步，不替代 Markdown 工作流。
 *
 * 数据存储：~/.mr-krabs/task-graph.json
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

module.exports = function initTaskGraph(mrKrabsDir) {

const GRAPH_FILE = path.join(mrKrabsDir, "task-graph.json");

// ── Schema ──
// task-graph.json 结构：
// {
//   version: 1,
//   nodes: {
//     "<id>": {
//       id: string,              // 8 位短 hash
//       text: string,            // 任务文本（与 tasks.md 中的文本对应）
//       status: string,          // pending | running | review | done | proposed
//       priority: string,        // high | normal | low
//       createdAt: string,       // ISO 时间戳
//       completedAt: string|null,
//
//       // ── 关系 ──
//       parentId: string|null,   // 父任务 ID（子任务树）
//       childIds: string[],      // 子任务 ID 列表
//       dependsOn: string[],     // 前置依赖（这些任务完成后才能开始）
//       blockedBy: string[],     // 被哪些任务阻塞（dependsOn 的反向）
//       relatedIds: string[],    // 关联任务（非依赖，仅相关）
//
//       // ── 来源 Context ──
//       origin: {
//         type: string,          // "user" | "proposal" | "follow-up" | "skill" | "browse" | "chat"
//         source: string|null,   // 来源描述（如 "划词自 xxx"、"基于任务 xxx 的后续"）
//         parentTaskId: string|null,  // 如果是 follow-up，指向原任务
//         contextSnapshot: string|null, // 创建时的上下文快照（简短）
//       },
//
//       // ── 决策历史 ──
//       history: [
//         {
//           action: string,      // "created" | "started" | "completed" | "reflected" | "supplemented" | "rerun" | "status-changed"
//           timestamp: string,
//           detail: string|null, // 补充说明
//         }
//       ],
//
//       // ── 元数据 ──
//       tags: string[],          // 用户标签
//       goalId: string|null,     // 所属大目标 ID（goals 中的 key）
//       mdLine: number|null,     // 在 tasks.md 中的行号（用于同步）
//     }
//   },
//   goals: {
//     "<id>": {
//       id: string,
//       title: string,           // 大目标名称
//       description: string,     // 目标描述
//       taskIds: string[],       // 属于此目标的任务 ID
//       createdAt: string,
//       status: string,          // active | completed | archived
//     }
//   },
//   edges: [
//     { from: string, to: string, type: "depends" | "related" | "parent-child" | "follow-up" }
//   ]
// }

function generateId() {
  return crypto.randomBytes(4).toString("hex");
}

function readGraph() {
  try {
    if (fs.existsSync(GRAPH_FILE)) {
      const raw = fs.readFileSync(GRAPH_FILE, "utf8");
      const g = JSON.parse(raw);
      if (g && g.version === 1) return g;
    }
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to read graph:", e.message);
  }
  return createEmptyGraph();
}

function createEmptyGraph() {
  return { version: 1, nodes: {}, goals: {}, edges: [] };
}

function writeGraph(graph) {
  try {
    fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2), "utf8");
  } catch (e) {
    console.warn("Mr. Krabs TaskGraph: failed to write graph:", e.message);
  }
}

// ── Node CRUD ──

function createNode(text, opts = {}) {
  const graph = readGraph();
  const id = generateId();
  const now = new Date().toISOString();

  const node = {
    id,
    text: text.trim(),
    status: opts.status || "pending",
    priority: opts.priority || "normal",
    createdAt: now,
    completedAt: null,
    parentId: opts.parentId || null,
    childIds: [],
    dependsOn: opts.dependsOn || [],
    blockedBy: [],
    relatedIds: opts.relatedIds || [],
    origin: {
      type: opts.originType || "user",
      source: opts.originSource || null,
      parentTaskId: opts.originParentTaskId || null,
      contextSnapshot: opts.contextSnapshot || null,
    },
    history: [
      { action: "created", timestamp: now, detail: opts.originSource || null },
    ],
    tags: opts.tags || [],
    goalId: opts.goalId || null,
    mdLine: opts.mdLine != null ? opts.mdLine : null,
  };

  graph.nodes[id] = node;

  // 维护父子关系
  if (node.parentId && graph.nodes[node.parentId]) {
    const parent = graph.nodes[node.parentId];
    if (!parent.childIds.includes(id)) {
      parent.childIds.push(id);
    }
    graph.edges.push({ from: node.parentId, to: id, type: "parent-child" });
  }

  // 维护依赖关系
  for (const depId of node.dependsOn) {
    if (graph.nodes[depId]) {
      if (!graph.nodes[depId].blockedBy) graph.nodes[depId].blockedBy = [];
      // blockedBy 记录的是「谁依赖我」，即反向
      // 但更直觉的是：depId 完成后 node 才能开始
      graph.edges.push({ from: depId, to: id, type: "depends" });
    }
  }

  // 维护关联关系
  for (const relId of node.relatedIds) {
    if (graph.nodes[relId]) {
      if (!graph.nodes[relId].relatedIds.includes(id)) {
        graph.nodes[relId].relatedIds.push(id);
      }
      graph.edges.push({ from: id, to: relId, type: "related" });
    }
  }

  writeGraph(graph);
  return node;
}

function updateNodeStatus(id, newStatus) {
  const graph = readGraph();
  const node = graph.nodes[id];
  if (!node) return null;

  const oldStatus = node.status;
  node.status = newStatus;
  if (newStatus === "done" && !node.completedAt) {
    node.completedAt = new Date().toISOString();
  }
  node.history.push({
    action: "status-changed",
    timestamp: new Date().toISOString(),
    detail: `${oldStatus} → ${newStatus}`,
  });

  writeGraph(graph);
  return node;
}

function addHistoryEntry(id, action, detail) {
  const graph = readGraph();
  const node = graph.nodes[id];
  if (!node) return;
  node.history.push({
    action,
    timestamp: new Date().toISOString(),
    detail: detail || null,
  });
  writeGraph(graph);
}

function deleteNode(id) {
  const graph = readGraph();
  const node = graph.nodes[id];
  if (!node) return;

  // 清理父子关系
  if (node.parentId && graph.nodes[node.parentId]) {
    const parent = graph.nodes[node.parentId];
    parent.childIds = parent.childIds.filter(c => c !== id);
  }

  // 清理子任务的 parentId
  for (const childId of (node.childIds || [])) {
    if (graph.nodes[childId]) {
      graph.nodes[childId].parentId = null;
    }
  }

  // 清理关联关系
  for (const relId of (node.relatedIds || [])) {
    if (graph.nodes[relId]) {
      graph.nodes[relId].relatedIds = graph.nodes[relId].relatedIds.filter(r => r !== id);
    }
  }

  // 清理目标关联
  if (node.goalId && graph.goals[node.goalId]) {
    graph.goals[node.goalId].taskIds = graph.goals[node.goalId].taskIds.filter(t => t !== id);
  }

  // 清理 edges
  graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);

  delete graph.nodes[id];
  writeGraph(graph);
}

// ── 查询 ──

function findNodeByText(text) {
  const graph = readGraph();
  const cleanText = text.trim();
  for (const node of Object.values(graph.nodes)) {
    if (node.text === cleanText) return node;
    // 模糊匹配：前 30 字符
    if (cleanText.length > 10 && node.text.includes(cleanText.slice(0, 30))) return node;
    if (node.text.length > 10 && cleanText.includes(node.text.slice(0, 30))) return node;
  }
  return null;
}

function findNodeByMdLine(lineIndex) {
  const graph = readGraph();
  for (const node of Object.values(graph.nodes)) {
    if (node.mdLine === lineIndex) return node;
  }
  return null;
}

function getNode(id) {
  const graph = readGraph();
  return graph.nodes[id] || null;
}

function getAllNodes() {
  const graph = readGraph();
  return Object.values(graph.nodes);
}

/** 获取任务的完整关系上下文（用于注入 prompt） */
function getTaskContext(id) {
  const graph = readGraph();
  const node = graph.nodes[id];
  if (!node) return null;

  const ctx = {
    self: node,
    parent: null,
    children: [],
    dependencies: [],
    dependents: [],  // 依赖我的任务
    related: [],
    goal: null,
    ancestorChain: [],  // 从根到当前的路径
  };

  // 父任务
  if (node.parentId && graph.nodes[node.parentId]) {
    ctx.parent = graph.nodes[node.parentId];
  }

  // 子任务
  for (const childId of (node.childIds || [])) {
    if (graph.nodes[childId]) ctx.children.push(graph.nodes[childId]);
  }

  // 前置依赖
  for (const depId of (node.dependsOn || [])) {
    if (graph.nodes[depId]) ctx.dependencies.push(graph.nodes[depId]);
  }

  // 依赖我的任务
  for (const n of Object.values(graph.nodes)) {
    if ((n.dependsOn || []).includes(id)) {
      ctx.dependents.push(n);
    }
  }

  // 关联任务
  for (const relId of (node.relatedIds || [])) {
    if (graph.nodes[relId]) ctx.related.push(graph.nodes[relId]);
  }

  // 所属目标
  if (node.goalId && graph.goals[node.goalId]) {
    ctx.goal = graph.goals[node.goalId];
  }

  // 祖先链
  let cur = node;
  while (cur.parentId && graph.nodes[cur.parentId]) {
    cur = graph.nodes[cur.parentId];
    ctx.ancestorChain.unshift(cur);
  }

  return ctx;
}

/** 格式化任务关系上下文为可注入 prompt 的文本 */
function formatTaskContextForPrompt(id) {
  const ctx = getTaskContext(id);
  if (!ctx) return "";

  const lines = [];

  // 来源
  if (ctx.self.origin && ctx.self.origin.source) {
    lines.push(`- 任务来源：${ctx.self.origin.source}`);
  }

  // 祖先链（大目标 → 子目标 → 当前任务）
  if (ctx.ancestorChain.length > 0) {
    const chain = ctx.ancestorChain.map(n => n.text.slice(0, 40)).join(" → ");
    lines.push(`- 任务层级：${chain} → 【当前】${ctx.self.text.slice(0, 40)}`);
  }

  // 所属目标
  if (ctx.goal) {
    lines.push(`- 所属目标：${ctx.goal.title}${ctx.goal.description ? "（" + ctx.goal.description.slice(0, 60) + "）" : ""}`);
  }

  // 父任务
  if (ctx.parent) {
    lines.push(`- 父任务：${ctx.parent.text.slice(0, 60)}（${ctx.parent.status}）`);
  }

  // 子任务
  if (ctx.children.length > 0) {
    const childSummary = ctx.children.map(c => `${c.text.slice(0, 30)}[${c.status}]`).join("、");
    lines.push(`- 子任务（${ctx.children.length}）：${childSummary}`);
  }

  // 前置依赖
  if (ctx.dependencies.length > 0) {
    const depSummary = ctx.dependencies.map(d => `${d.text.slice(0, 30)}[${d.status}]`).join("、");
    lines.push(`- 前置依赖：${depSummary}`);
    const unfinished = ctx.dependencies.filter(d => d.status !== "done");
    if (unfinished.length > 0) {
      lines.push(`  ⚠️ ${unfinished.length} 个依赖尚未完成`);
    }
  }

  // 依赖我的任务
  if (ctx.dependents.length > 0) {
    const depSummary = ctx.dependents.map(d => `${d.text.slice(0, 30)}[${d.status}]`).join("、");
    lines.push(`- 后续任务（等我完成）：${depSummary}`);
  }

  // 关联任务
  if (ctx.related.length > 0) {
    const relSummary = ctx.related.map(r => `${r.text.slice(0, 30)}[${r.status}]`).join("、");
    lines.push(`- 关联任务：${relSummary}`);
  }

  // 决策历史（最近 5 条）
  if (ctx.self.history && ctx.self.history.length > 1) {
    const recent = ctx.self.history.slice(-5);
    const histLines = recent.map(h => {
      const time = h.timestamp ? h.timestamp.slice(0, 16).replace("T", " ") : "";
      return `  ${time} ${h.action}${h.detail ? "：" + h.detail.slice(0, 50) : ""}`;
    });
    lines.push(`- 决策历史：\n${histLines.join("\n")}`);
  }

  return lines.join("\n");
}

// ── 目标管理 ──

function createGoal(title, description) {
  const graph = readGraph();
  const id = generateId();
  graph.goals[id] = {
    id,
    title,
    description: description || "",
    taskIds: [],
    createdAt: new Date().toISOString(),
    status: "active",
  };
  writeGraph(graph);
  return graph.goals[id];
}

function assignToGoal(taskId, goalId) {
  const graph = readGraph();
  if (!graph.nodes[taskId] || !graph.goals[goalId]) return false;
  graph.nodes[taskId].goalId = goalId;
  if (!graph.goals[goalId].taskIds.includes(taskId)) {
    graph.goals[goalId].taskIds.push(taskId);
  }
  writeGraph(graph);
  return true;
}

function getGoals() {
  const graph = readGraph();
  return Object.values(graph.goals);
}

// ── 关系操作 ──

function addDependency(taskId, dependsOnId) {
  const graph = readGraph();
  const node = graph.nodes[taskId];
  const dep = graph.nodes[dependsOnId];
  if (!node || !dep) return false;
  if (!node.dependsOn.includes(dependsOnId)) {
    node.dependsOn.push(dependsOnId);
    graph.edges.push({ from: dependsOnId, to: taskId, type: "depends" });
    writeGraph(graph);
  }
  return true;
}

function addRelation(taskId1, taskId2) {
  const graph = readGraph();
  const n1 = graph.nodes[taskId1];
  const n2 = graph.nodes[taskId2];
  if (!n1 || !n2) return false;
  if (!n1.relatedIds.includes(taskId2)) {
    n1.relatedIds.push(taskId2);
    n2.relatedIds.push(taskId1);
    graph.edges.push({ from: taskId1, to: taskId2, type: "related" });
    writeGraph(graph);
  }
  return true;
}

function setParent(childId, parentId) {
  const graph = readGraph();
  const child = graph.nodes[childId];
  const parent = graph.nodes[parentId];
  if (!child || !parent) return false;

  // 清理旧父子关系
  if (child.parentId && graph.nodes[child.parentId]) {
    graph.nodes[child.parentId].childIds = graph.nodes[child.parentId].childIds.filter(c => c !== childId);
  }

  child.parentId = parentId;
  if (!parent.childIds.includes(childId)) {
    parent.childIds.push(childId);
  }
  graph.edges.push({ from: parentId, to: childId, type: "parent-child" });
  writeGraph(graph);
  return true;
}

// ── 同步 tasks.md 行号 ──

function syncMdLines(parsedTasks) {
  const graph = readGraph();
  let changed = false;

  for (const task of parsedTasks) {
    const node = findNodeByTextInGraph(graph, task.text || task.cleanText);
    if (node && node.mdLine !== task.line) {
      node.mdLine = task.line;
      changed = true;
    }
  }

  if (changed) writeGraph(graph);
}

function findNodeByTextInGraph(graph, text) {
  const cleanText = (text || "").trim();
  for (const node of Object.values(graph.nodes)) {
    if (node.text === cleanText) return node;
    if (cleanText.length > 10 && node.text.includes(cleanText.slice(0, 30))) return node;
    if (node.text.length > 10 && cleanText.includes(node.text.slice(0, 30))) return node;
  }
  return null;
}

// ── 图谱分析（供主动提议使用） ──

/** 获取图谱摘要（用于注入提议 prompt） */
function getGraphSummary() {
  const graph = readGraph();
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return "";

  const lines = [];
  const byStatus = {};
  for (const n of nodes) {
    if (!byStatus[n.status]) byStatus[n.status] = [];
    byStatus[n.status].push(n);
  }

  lines.push(`任务图谱概览（共 ${nodes.length} 个任务节点）：`);

  // 按状态统计
  const statusLabels = { pending: "待执行", running: "执行中", review: "待审阅", done: "已完成", proposed: "建议中" };
  for (const [status, label] of Object.entries(statusLabels)) {
    if (byStatus[status] && byStatus[status].length > 0) {
      lines.push(`  ${label}：${byStatus[status].length} 个`);
    }
  }

  // 活跃目标
  const activeGoals = Object.values(graph.goals).filter(g => g.status === "active");
  if (activeGoals.length > 0) {
    lines.push(`\n活跃目标：`);
    for (const g of activeGoals) {
      const goalTasks = (g.taskIds || []).map(id => graph.nodes[id]).filter(Boolean);
      const done = goalTasks.filter(t => t.status === "done").length;
      lines.push(`  - ${g.title}（${done}/${goalTasks.length} 完成）`);
    }
  }

  // 有依赖关系的任务链
  const withDeps = nodes.filter(n => (n.dependsOn || []).length > 0 && n.status !== "done");
  if (withDeps.length > 0) {
    lines.push(`\n有前置依赖的待办任务：`);
    for (const n of withDeps.slice(0, 5)) {
      const deps = n.dependsOn.map(id => graph.nodes[id]).filter(Boolean);
      const depNames = deps.map(d => `${d.text.slice(0, 20)}[${d.status}]`).join("→");
      lines.push(`  - ${n.text.slice(0, 30)} ← 依赖：${depNames}`);
    }
  }

  // 有子任务的任务树
  const withChildren = nodes.filter(n => (n.childIds || []).length > 0);
  if (withChildren.length > 0) {
    lines.push(`\n任务树：`);
    for (const n of withChildren.slice(0, 5)) {
      const children = n.childIds.map(id => graph.nodes[id]).filter(Boolean);
      const childSummary = children.map(c => `${c.text.slice(0, 15)}[${c.status}]`).join("、");
      lines.push(`  - ${n.text.slice(0, 30)}（子任务：${childSummary}）`);
    }
  }

  // 最近的来源 context
  const recentWithOrigin = nodes
    .filter(n => n.origin && n.origin.source && n.status !== "done")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, 3);
  if (recentWithOrigin.length > 0) {
    lines.push(`\n近期任务来源：`);
    for (const n of recentWithOrigin) {
      lines.push(`  - 「${n.text.slice(0, 25)}」← ${n.origin.source.slice(0, 50)}`);
    }
  }

  return lines.join("\n");
}

/** 检查任务的依赖是否都已完成 */
function areDependenciesMet(id) {
  const graph = readGraph();
  const node = graph.nodes[id];
  if (!node) return true;
  for (const depId of (node.dependsOn || [])) {
    const dep = graph.nodes[depId];
    if (dep && dep.status !== "done") return false;
  }
  return true;
}

/** 获取可执行的任务（依赖已满足的 pending 任务） */
function getExecutableTasks() {
  const graph = readGraph();
  return Object.values(graph.nodes).filter(n => {
    if (n.status !== "pending") return false;
    return areDependenciesMet(n.id);
  });
}

// ── 导出 ──

return {
  // CRUD
  createNode,
  updateNodeStatus,
  addHistoryEntry,
  deleteNode,

  // 查询
  findNodeByText,
  findNodeByMdLine,
  getNode,
  getAllNodes,
  getTaskContext,
  formatTaskContextForPrompt,

  // 目标
  createGoal,
  assignToGoal,
  getGoals,

  // 关系
  addDependency,
  addRelation,
  setParent,

  // 同步
  syncMdLines,

  // 分析
  getGraphSummary,
  areDependenciesMet,
  getExecutableTasks,

  // 底层
  readGraph,
  writeGraph,
  generateId,
};

};
