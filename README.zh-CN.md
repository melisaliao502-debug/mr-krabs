<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Mr. Krabs">
</p>
<h1 align="center">🦀 Mr. Krabs — 你想拥有一个主动干活的 AI 吗？</h1>
<p align="center">
  <a href="README.md">English</a>
</p>

**Mr. Krabs 是一个桌面级的 Harness 原型。** 它不替代模型能力，而是围绕 AI Agent 搭建一套 OS 级的感知-执行-反馈系统。它的核心能力不是"更聪明"，而是**主动帮你干活**——你给它一个长线方向，它自己判断什么时候做、做到什么程度该汇报、什么情况下别打扰你。

支持 Windows 11 和 macOS。需要 Node.js。兼容 **Claude Code**、**Codex CLI** 和 **Copilot CLI**。

---

## 核心能力：围绕 To-Do List 的主动执行系统

现在的 AI Agent 虽然特别能干，但有三个致命问题：**你不说他就不动**、**你说完他就忘**、**你看不到他在干嘛**。

普通 Junior 是你布置一件做一件。好的 Junior 是你跟他说"最近盯着竞品动态"，他自己知道每天去看、看完整理、觉得有价值的主动告诉你。**Mr. Krabs 就是后者。**

### 你给方向，它主动干活

| 模式 | 做什么 | 状态 |
| --- | --- | --- |
| **你布置任务** | 通过快捷键或划词把任务加入清单 → Mr. Krabs 空闲时自动执行 → 交付结果 | ✅ |
| **它主动提议** | 每 4 小时分析你的工作上下文，主动提议 1-3 个值得做的任务 → 你采纳才进队列 | ✅ |
| **长线跟进** | 你给一个方向（如"盯竞品动态"），它持续执行、定期更新、积累越来越准 | ✅ |

任务清单就是一份 `~/.mr-krabs/tasks.md`，5 种状态：待执行 `[ ]`、执行中 `[~]`、待审阅 `[!]`、已完成 `[x]`、建议中 `[?]`（Mr. Krabs 提议，你采纳才执行）。

### 它怎么决定要不要打扰你

| 结果 | Mr. Krabs 的行为 |
| --- | --- |
| **搞定了** (confidence ≥ 0.7) | 存文件，标记待审阅，不打扰 |
| **没完全搞定** (confidence < 0.7) | 自动反思迭代一轮，交付最好的结果；Mr. Krabs 晃一下提醒 |
| **真的需要你** | 弹窗写清缺什么信息，你填完它接着跑 |

### 越用越懂你

每个成功任务自动提取方法论，存成技能卡片和失败教训。下次类似任务自动注入。**你不需要重复教它——它自己记住怎么做事。**

---

## 这套系统怎么运转的

Proactive AI 不是凭空产生的。它依赖两个基础能力：**看得见你在做什么**（Context）和**随时能告诉你它的状态**（Always On）。

### 看得见：Context 从哪来

这个 Junior 很聪明，但他只知道你亲口告诉他的事。你上午开了个会、下午看了篇文章、刚跟同事聊了个想法——他全不知道。Mr. Krabs 住在 OS 层，能从你的工作流里自己捡到线索：

| 通道 | 做什么 |
| --- | --- |
| **划词 + 浮窗** ⭐ | 浏览器/编辑器中选中文字 → 一键加入任务清单，连同上下文一起进去 |
| **快捷键** ⭐ | Cmd+Shift+T → 脑子里的想法直接进清单 |
| **OS 感知** ⭐ | 自动感知当前项目、待办、近期动作，定期做上下文快照 |
| Claude 对话历史 / 会话记录 / 浏览笔记 | 辅助上下文，丰富提议质量 |

⭐ = 核心信号源。所有入口最终汇入同一份任务清单。

### 看得到：Always On 状态感知

这个 Junior 坐在你桌上，你抬头就能看到他在忙什么。40 个像素风动画映射 Agent 状态——不需要看 dashboard，看 Mr. Krabs 就行。

权限审批也在桌面完成——Claude Code 需要权限时，Mr. Krabs 弹一张卡片，一键批准，不用切终端。

---

## 为什么是桌宠

桌宠只是表现层。底层是一套 OS 级的感知-执行-反馈系统。去掉动画，系统照样跑。

但桌宠形态解决了三个真实问题：

1. **Agent 需要常驻但不能碍事** — 桌宠天然常驻屏幕但不占窗口，比 App 更轻、比 CLI 更可见
2. **用户需要敢放手** — 你不是在"授权一个程序"，而是在"让你的 Mr. Krabs 帮你做事"。拟人化降低自治执行的心理门槛
3. **状态需要零成本感知** — 用动画映射 Agent 状态，是最低认知负担的 observability 方案

---

## 状态映射

来自所有 Agent（Claude Code hooks、Codex JSONL、Copilot hooks）的事件映射到同一套动画状态：

| Agent 事件 | Mr. Krabs 状态 | 动画 | |
|---|---|---|---|
| 无活动 | idle | 眼球跟随鼠标 | <img src="assets/gif/clawd-idle.gif" width="200"> |
| UserPromptSubmit | thinking | 思考泡泡 | <img src="assets/gif/clawd-thinking.gif" width="200"> |
| PreToolUse / PostToolUse | working (typing) | 打字 | <img src="assets/gif/clawd-typing.gif" width="200"> |
| PreToolUse (3+ 会话) | working (building) | 建造 | <img src="assets/gif/clawd-building.gif" width="200"> |
| SubagentStart (1个) | juggling | 杂耍 | <img src="assets/gif/clawd-juggling.gif" width="200"> |
| SubagentStart (2+) | conducting | 指挥 | <img src="assets/gif/clawd-conducting.gif" width="200"> |
| PostToolUseFailure / StopFailure | error | ERROR + 冒烟 | <img src="assets/gif/clawd-error.gif" width="200"> |
| Stop / PostCompact | attention | 开心蹦跳 | <img src="assets/gif/clawd-happy.gif" width="200"> |
| PermissionRequest / Notification | notification | 提醒跳跃 | <img src="assets/gif/clawd-notification.gif" width="200"> |
| PreCompact | sweeping | 扫帚清扫 | <img src="assets/gif/clawd-sweeping.gif" width="200"> |
| WorktreeCreate | carrying | 搬箱子 | <img src="assets/gif/clawd-carrying.gif" width="200"> |
| 60 秒无事件 | sleeping | 睡眠序列 | <img src="assets/gif/clawd-sleeping.gif" width="200"> |

### 迷你模式

把 Mr. Krabs 拖到屏幕右侧边缘（或右键 → "迷你模式"）进入迷你模式。Mr. Krabs 隐藏在屏幕边缘，只露出半个身体，鼠标悬停时探出头来。

| 触发 | 迷你反应 | |
|---|---|---|
| 默认 | 呼吸 + 眨眼 + 偶尔挥手 + 眼球跟随 | <img src="assets/gif/clawd-mini-idle.gif" width="120"> |
| 鼠标悬停 | 探出头 + 挥手（向屏幕内滑动 25px） | <img src="assets/gif/clawd-mini-peek.gif" width="120"> |
| 通知 / 权限请求 | 感叹号弹出 + >< 眯眼 | <img src="assets/gif/clawd-mini-alert.gif" width="120"> |
| 任务完成 | 小花 + ^^ 开心表情 + 闪光 | <img src="assets/gif/clawd-mini-happy.gif" width="120"> |
| 悬停时点击 | 退出迷你模式（抛物线跳回） | |

---

## 功能详情

### 多 Agent 支持
- **Claude Code** — 通过 command hooks + HTTP permission hooks 完整集成
- **Codex CLI** — 自动轮询 JSONL 日志（`~/.codex/sessions/`，约 1.5 秒间隔），零配置
- **Copilot CLI** — 通过 `~/.copilot/hooks/hooks.json` 配置 command hooks
- **多 Agent 共存** — 三个同时运行，Mr. Krabs 独立追踪每个会话

### 权限气泡

- **应用内权限审批** — Claude Code 请求工具权限时，Mr. Krabs 弹出浮动气泡卡片，无需在终端等待
- **允许 / 拒绝 / 建议** — 一键批准、拒绝或应用权限规则
- **堆叠布局** — 多个请求从右下角向上堆叠
- **自动消失** — 如果你先在终端回答了，气泡自动消失

### 会话智能

- **多会话追踪** — 所有 Agent 的会话解析到最高优先级状态
- **子代理感知** — 1 个子代理时杂耍，2+ 时指挥
- **终端聚焦** — 右键 → Sessions 菜单跳转到指定会话的终端窗口
- **进程存活检测** — 检测崩溃/退出的 Agent 进程，清理孤立会话
- **启动恢复** — 如果 Mr. Krabs 在 Agent 运行时重启，保持清醒状态

### 交互与系统
- **眼球跟随** — 空闲时跟随鼠标，身体微倾，影子拉伸
- **睡眠序列** — 打哈欠 → 打盹 → 倒下 → 睡着（60 秒空闲后）；鼠标移动触发惊醒动画
- **点击反应** — 双击戳一下，连点 4 次东张西望
- **任意状态拖拽** — 随时抓住 Mr. Krabs，松手继续
- **点击穿透** — 透明区域将点击传递给下面的窗口
- **位置记忆** — 跨重启记住位置（包括迷你模式）
- **单实例锁** — 防止重复窗口
- **自动启动** — SessionStart hook 自动启动 Mr. Krabs
- **免打扰** — 右键或托盘进入睡眠模式，所有事件静音
- **系统托盘** — 调整大小 (S/M/L)、免打扰、语言切换、自启动、检查更新
- **国际化** — 中英文界面，右键或托盘切换
- **自动更新** — 退出时检查 GitHub Releases

---

## 快速开始

### 一键安装（推荐）

在终端或 Claude Code 中粘贴：

```bash
curl -fsSL https://raw.githubusercontent.com/melisaliao502-debug/mr-krabs/main/install.sh | bash
```

自动检测系统和芯片架构，下载最新版本，安装并启动。支持 macOS（Intel / Apple Silicon）和 Windows。

### 从源码运行（开发者）

```bash
# 克隆仓库
git clone https://github.com/melisaliao502-debug/mr-krabs.git
cd mr-krabs

# 安装依赖
npm install

# 启动 Mr. Krabs（自动注册 Claude Code hooks）
npm start
```

### Agent 配置

**Claude Code** — 开箱即用。启动时自动注册 hooks。版本化 hooks（`PreCompact`、`PostCompact`、`StopFailure`）仅在检测到兼容的 Claude Code 版本时注册，否则回退到核心 hooks。

**Codex CLI** — 开箱即用。Mr. Krabs 自动轮询 `~/.codex/sessions/` 的 JSONL 日志。

**Copilot CLI** — 创建 `~/.copilot/hooks/hooks.json`：
```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "type": "command", "bash": "node /path/to/mr-krabs/hooks/copilot-hook.js sessionStart", "powershell": "node /path/to/mr-krabs/hooks/copilot-hook.js sessionStart", "timeoutSec": 5 }],
    "userPromptSubmitted": [{ "type": "command", "bash": "node /path/to/mr-krabs/hooks/copilot-hook.js userPromptSubmitted", "powershell": "node /path/to/mr-krabs/hooks/copilot-hook.js userPromptSubmitted", "timeoutSec": 5 }],
    "preToolUse": [{ "type": "command", "bash": "node /path/to/mr-krabs/hooks/copilot-hook.js preToolUse", "powershell": "node /path/to/mr-krabs/hooks/copilot-hook.js preToolUse", "timeoutSec": 5 }],
    "postToolUse": [{ "type": "command", "bash": "node /path/to/mr-krabs/hooks/copilot-hook.js postToolUse", "powershell": "node /path/to/mr-krabs/hooks/copilot-hook.js postToolUse", "timeoutSec": 5 }],
    "sessionEnd": [{ "type": "command", "bash": "node /path/to/mr-krabs/hooks/copilot-hook.js sessionEnd", "powershell": "node /path/to/mr-krabs/hooks/copilot-hook.js sessionEnd", "timeoutSec": 5 }]
  }
}
```
将 `/path/to/mr-krabs` 替换为你的实际安装路径。

### macOS 说明

- **从源码运行**（`npm start`）：Intel 和 Apple Silicon 开箱即用。
- **DMG 安装器**：未签名 — 右键 → **打开** → 点击 **打开**，或在终端运行 `xattr -cr /Applications/Mr. Krabs.app`。

---

## 工作原理

```
主动任务系统：
  上下文来源（划词 / 快捷键 / OS 感知 / Claude 对话历史）
    → ~/.mr-krabs/tasks.md（统一任务队列）
    → tasks.js（空闲检测 / 定时触发 → 启动 Claude 会话）
    → 基于置信度的交付（自动完成 / 反思重试 / 请求输入）
    → 技能提取 → ~/.mr-krabs/skills/*.md（下次自动注入）

  上下文监控（4 小时周期）：
    → 收集快照（对话 + 会话 + 笔记 + 趋势）
    → Claude 分析 → 提议 1-3 个任务作为 [?] 建议

实时状态感知：
  Claude Code / Copilot CLI（command hooks，非阻塞）：
    Agent 事件
      → hooks/mr-krabs-hook.js 或 copilot-hook.js（事件 → 状态 → HTTP POST）
      → 127.0.0.1:23333/state
      → main.js 中的状态机（多会话 + 优先级 + 最小显示时长）
      → IPC 到 renderer.js（SVG 预加载 + 淡入切换）

  Codex CLI（JSONL 日志轮询）：
    Codex 写入 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
      → agents/codex-log-monitor.js（增量读取、事件映射）
      → 同一个状态机 → 同一套动画

  权限审批（Claude Code HTTP hook，阻塞）：
    Claude Code PermissionRequest
      → HTTP POST 到 127.0.0.1:23333/permission
      → 气泡窗口 (bubble.html)，允许 / 拒绝 / 建议按钮
      → 用户点击 → HTTP 响应 → Claude Code 继续执行
```

Mr. Krabs 作为透明、始终置顶、不可聚焦的 Electron 窗口运行，支持按区域点击穿透。它永远不会抢焦点或阻挡你的工作流。

---

## 手动测试

```bash
# 触发特定状态
curl -X POST http://127.0.0.1:23333/state \
  -H "Content-Type: application/json" \
  -d '{"state":"working","session_id":"test"}'

# 循环播放所有动画（每个 8 秒）
bash test-demo.sh

# 循环播放迷你模式动画
bash test-mini.sh
```

## 项目结构

```
src/
  main.js              # Electron 主进程：状态机、窗口、托盘、光标、任务集成
  renderer.js          # 渲染进程：拖拽、点击、SVG 动画、眼球跟随
  tasks.js             # 任务引擎：队列、执行、交付、技能、记忆
  context-monitor.js   # 上下文监控：周期分析 + 主动提议
  bubble.html          # 权限气泡 UI
  quick-task.html      # 快速任务输入（Spotlight 风格，Cmd+Shift+T）
  task-panel.html      # 任务面板（状态板）
  task-notify.html     # 通知窗口（缺失信息提示）
  chat.html            # 划词浮窗
  preload.js           # IPC 桥接 (contextBridge)
  index.html           # 主窗口页面结构
agents/
  claude-code.js       # Claude Code Agent 配置
  codex.js             # Codex CLI Agent 配置
  copilot-cli.js       # Copilot CLI Agent 配置
  registry.js          # Agent 注册表
  codex-log-monitor.js # Codex JSONL 增量日志轮询
hooks/
  mr-krabs-hook.js        # Claude Code command hook
  copilot-hook.js      # Copilot CLI command hook
  install.js           # 安全 hook 注册
  auto-start.js        # SessionStart：未运行时自动启动 Mr. Krabs
extensions/
  vscode/              # VS Code 扩展：终端标签聚焦
assets/
  svg/                 # 40 个像素风 SVG 动画（含 8 个迷你模式）
  gif/                 # 文档用录制 GIF
```

## 已知限制

| 限制 | 详情 |
|---|---|
| **Codex CLI：无终端聚焦** | JSONL 轮询不携带终端 PID 信息。Claude Code 和 Copilot CLI 正常工作。 |
| **Codex CLI：Windows hooks 被禁用** | 改用日志文件轮询（约 1.5 秒延迟，hook 模式几乎无延迟）。 |
| **Copilot CLI：需手动配置 hooks** | 需要手动创建 `~/.copilot/hooks/hooks.json`。Claude Code 和 Codex 开箱即用。 |
| **Copilot CLI：无权限气泡** | `preToolUse` hook 只支持拒绝。权限气泡仅支持 Claude Code。 |
| **macOS 自动更新** | 无 Apple 代码签名 — 需从 GitHub Releases 手动下载。 |
| **Electron 无测试框架** | 单元测试覆盖 Agent 和日志轮询，但 Electron 主进程无自动化测试。 |

### 路线图

- 通过 `codex.exe` PID 进程树查找实现 Codex 终端聚焦
- 自动注册 Copilot CLI hooks（像 Claude Code 一样）
- 状态切换音效（受 Electron 自动播放策略限制）
- 自定义角色皮肤 / 动画
- Hook 卸载脚本

---

## 贡献

欢迎提交 Bug 报告、功能建议和 Pull Request — 开一个 [issue](https://github.com/melisaliao502-debug/mr-krabs/issues) 讨论或直接提交 PR。

### 贡献者

感谢每一位让 Mr. Krabs 变得更好的人：

<a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /></a>

## 鸣谢

- 桌宠基础和社区贡献来自 [mr-krabs](https://github.com/rullerzhou-afk/clawd-on-desk)
- 像素画参考自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- Mr. Krabs 角色归属 [Anthropic](https://www.anthropic.com)。这是一个社区项目，非 Anthropic 官方关联或背书。

## 许可证

MIT
