const { app, BrowserWindow, screen, Menu, ipcMain, globalShortcut, clipboard, systemPreferences, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

// ── 修复 EPIPE 崩溃：stdout/stderr 管道断裂时静默忽略 ──
// 当 Electron 从终端启动后终端关闭，或父进程退出时，
// console.log 写入已关闭的管道会抛出 EPIPE，导致 Uncaught Exception 弹窗。
// EPIPE 在 Node 内部是异步抛出的（afterWriteDispatched），try/catch 无法捕获，
// 必须通过 stream 的 error 事件 + uncaughtException 兜底。
// 参考：https://github.com/nodejs/node/issues/29548

// 1) 监听 stream error 事件，忽略 EPIPE
process.stdout.on("error", (e) => { if (e.code !== "EPIPE") throw e; });
process.stderr.on("error", (e) => { if (e.code !== "EPIPE") throw e; });

// 2) 同步写入也包一层保险
function silenceEpipe(stream) {
  const _origWrite = stream.write;
  stream.write = function (...args) {
    try { return _origWrite.apply(this, args); }
    catch (e) { if (e.code !== "EPIPE") throw e; }
  };
}
silenceEpipe(process.stdout);
silenceEpipe(process.stderr);

// 3) 最后防线：uncaughtException 中仅过滤 EPIPE
// 注意：不能吞掉非 EPIPE 错误，否则 Electron 应用会静默崩溃
process.on("uncaughtException", (err, origin) => {
  if (err && err.code === "EPIPE") return; // 静默忽略 EPIPE
  // 非 EPIPE 错误：移除本监听器后重新抛出，让 Electron 默认弹窗处理
  process.removeAllListeners("uncaughtException");
  throw err;
});

const isMac = process.platform === "darwin";


// ── Windows: AllowSetForegroundWindow via FFI ──
let _allowSetForeground = null;
if (!isMac) {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    _allowSetForeground = user32.func("bool __stdcall AllowSetForegroundWindow(int dwProcessId)");
  } catch (err) {
    console.warn("Mr. Krabs: koffi/AllowSetForegroundWindow not available:", err.message);
  }
}


// ── Window size presets ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

let lang = "en";

// ── Position persistence ──
const PREFS_PATH = path.join(app.getPath("userData"), "mr-krabs-prefs.json");

function loadPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    // Sanitize numeric fields — corrupted JSON can feed NaN into window positioning
    for (const key of ["x", "y", "preMiniX", "preMiniY"]) {
      if (key in raw && (typeof raw[key] !== "number" || !isFinite(raw[key]))) {
        raw[key] = 0;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

function savePrefs() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds();
  const data = {
    x, y, size: currentSize,
    miniMode: _mini.getMiniMode(), preMiniX: _mini.getPreMiniX(), preMiniY: _mini.getPreMiniY(), lang,
    showTray, showDock,
    autoStartWithClaude, bubbleFollowPet,
    quickSendMode,
    chatShortcut, quickTaskShortcut,
  };
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(data)); } catch {}
}

let _codexMonitor = null;          // Codex CLI JSONL log polling instance

// ── CSS <object> sizing (mirrors styles.css #mr-krabs) ──
const OBJ_SCALE_W = 1.9;   // width: 190%
const OBJ_SCALE_H = 1.3;   // height: 130%
const OBJ_OFF_X   = -0.45; // left: -45%
const OBJ_OFF_Y   = -0.25; // top: -25%

function getObjRect(bounds) {
  return {
    x: bounds.x + bounds.width * OBJ_OFF_X,
    y: bounds.y + bounds.height * OBJ_OFF_Y,
    w: bounds.width * OBJ_SCALE_W,
    h: bounds.height * OBJ_SCALE_H,
  };
}

let win;
let hitWin;  // input window — small opaque rect over hitbox, receives all pointer events
let chatWin = null; // quick-input window (Control+Enter)
/** Plain-text context from frontmost selection (macOS); passed to chat UI, not "whatever is on clipboard". */
let chatContextSnapshotPending = false;
let chatContextSnapshot = "";
let _accessibilityWarningShown = false;
let _accessibilityCached = null;   // null=unchecked, true=granted, false=denied
let _accessibilityPromptCooldown = false; // prevent double-prompting

// ── 快捷键设置（用户可自定义，持久化到 prefs） ──
// macOS: F18 = Fn 键，几乎无冲突，默认比 Ctrl+Enter 更友好
const DEFAULT_CHAT_SHORTCUT       = "Control+Return"; // 划词发送给 Claude（Ctrl+Enter）
const DEFAULT_QUICK_TASK_SHORTCUT  = "Control+Space";  // 快速添加任务（Ctrl+空格）
let chatShortcut      = DEFAULT_CHAT_SHORTCUT;
let quickTaskShortcut = DEFAULT_QUICK_TASK_SHORTCUT;

/** 注销旧快捷键 → 用当前变量重新注册 */
function reregisterShortcuts() {
  globalShortcut.unregisterAll();
  const okChat = globalShortcut.register(chatShortcut, openChatWindow);
  const okTask = globalShortcut.register(quickTaskShortcut, openQuickTaskWindow);
  if (!okChat)  console.warn(`Mr. Krabs: failed to register chatShortcut: ${chatShortcut}`);
  if (!okTask)  console.warn(`Mr. Krabs: failed to register quickTaskShortcut: ${quickTaskShortcut}`);
}

function truncateContextPreview(text, maxCodePoints) {
  if (!text) return "";
  const units = [...text];
  if (units.length <= maxCodePoints) return text;
  return units.slice(0, maxCodePoints).join("");
}

/**
 * After Ctrl+Enter we synthesize Cmd+C: the general pasteboard plain text is then treated as the
 * selection payload (same bytes you would get from Copy), even when it matches what was already
 * on the pasteboard. Poll until the pasteboard updates or max wait so slow apps finish writing.
 */
const CLIPBOARD_POST_COPY_POLL_MS = 30;
const CLIPBOARD_POST_COPY_MAX_MS = 800;

/**
 * Yields the selected text captured via synthetic Cmd+C.
 * Polls the pasteboard until it differs from `beforeCopy` (= real selection captured)
 * or until timeout (= Cmd+C failed / nothing selected → return empty string).
 */
function readPostCopyContextPlainMac(plainBeforeCopy, done) {
  const start = Date.now();
  const tick = () => {
    const now = clipboard.readText();
    const elapsed = Date.now() - start;
    if (now !== plainBeforeCopy) {
      // Clipboard changed → we captured the selection
      done(now);
      return;
    }
    if (elapsed >= CLIPBOARD_POST_COPY_MAX_MS) {
      // Timeout: synthetic Cmd+C didn't change the clipboard.
      // This means no text was selected or the copy failed.
      // Return empty string instead of the old clipboard content.
      done("");
      return;
    }
    setTimeout(tick, CLIPBOARD_POST_COPY_POLL_MS);
  };
  setTimeout(tick, CLIPBOARD_POST_COPY_POLL_MS);
}

let tray = null;
let contextMenuOwner = null;
let currentSize = "S";
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
let showTray = true;
let showDock = true;
let autoStartWithClaude = false;
let bubbleFollowPet = false;
// "auto" | "claude-desktop" | "claude-code" | "claude-cli"  — Quick Send routing mode
// "auto" = try Desktop → Code in order; explicit = prefer that channel, fallback if unavailable
let quickSendMode = "auto";

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function sendToHitWin(channel, ...args) {
  if (hitWin && !hitWin.isDestroyed()) hitWin.webContents.send(channel, ...args);
}

// Sync input window position to match render window's hitbox.
// Called manually after every win position/size change + event-level safety net.
let _lastHitW = 0, _lastHitH = 0;
function syncHitWin() {
  if (!hitWin || hitWin.isDestroyed() || !win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const hit = getHitRectScreen(bounds);
  const x = Math.round(hit.left);
  const y = Math.round(hit.top);
  const w = Math.round(hit.right - hit.left);
  const h = Math.round(hit.bottom - hit.top);
  if (w <= 0 || h <= 0) return;
  hitWin.setBounds({ x, y, width: w, height: h });
  // Update shape if hitbox dimensions changed (e.g. after resize)
  if (w !== _lastHitW || h !== _lastHitH) {
    _lastHitW = w; _lastHitH = h;
    hitWin.setShape([{ x: 0, y: 0, width: w, height: h }]);
  }
}

let mouseOverPet = false;
let dragLocked = false;
let menuOpen = false;
let idlePaused = false;
let forceEyeResend = false;

// ── Mini Mode — delegated to src/mini.js ──
// Initialized after state module (needs applyState, resolveDisplayState, etc.)
// See _mini initialization below


// ── Permission bubble — delegated to src/permission.js ──
const _permCtx = {
  get win() { return win; },
  get lang() { return lang; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get permDebugLog() { return permDebugLog; },
  getNearestWorkArea,
  getHitRectScreen,
  guardAlwaysOnTop,
};
const _perm = require("./permission")(_permCtx);
const { showPermissionBubble, resolvePermissionEntry, sendPermissionResponse, repositionBubbles, permLog, PASSTHROUGH_TOOLS } = _perm;
const pendingPermissions = _perm.pendingPermissions;
let permDebugLog = null; // set after app.whenReady()
let updateDebugLog = null; // set after app.whenReady()

// ── State machine — delegated to src/state.js ──
const _stateCtx = {
  get win() { return win; },
  get hitWin() { return hitWin; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get mouseOverPet() { return mouseOverPet; },
  get miniSleepPeeked() { return _mini.getMiniSleepPeeked(); },
  set miniSleepPeeked(v) { _mini.setMiniSleepPeeked(v); },
  get idlePaused() { return idlePaused; },
  set idlePaused(v) { idlePaused = v; },
  get forceEyeResend() { return forceEyeResend; },
  set forceEyeResend(v) { forceEyeResend = v; },
  get mouseStillSince() { return _tick ? _tick._mouseStillSince : Date.now(); },
  get pendingPermissions() { return pendingPermissions; },
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  t: (key) => t(key),
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  resolvePermissionEntry: (...args) => resolvePermissionEntry(...args),
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
};
const _state = require("./state")(_stateCtx);
const { setState, applyState, updateSession, resolveDisplayState, getSvgOverride,
        enableDoNotDisturb, disableDoNotDisturb, startStaleCleanup, stopStaleCleanup,
        startWakePoll, stopWakePoll, detectRunningAgentProcesses, buildSessionSubmenu,
        startStartupRecovery: _startStartupRecovery } = _state;
const sessions = _state.sessions;
const STATE_SVGS = _state.STATE_SVGS;
const STATE_PRIORITY = _state.STATE_PRIORITY;

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) {
  const obj = getObjRect(bounds);
  const scale = Math.min(obj.w, obj.h) / 45;
  const offsetX = obj.x + (obj.w - 45 * scale) / 2;
  const offsetY = obj.y + (obj.h - 45 * scale) / 2;
  const hb = _state.getCurrentHitBox();
  return {
    left:   offsetX + (hb.x + 15) * scale,
    top:    offsetY + (hb.y + 25) * scale,
    right:  offsetX + (hb.x + 15 + hb.w) * scale,
    bottom: offsetY + (hb.y + 25 + hb.h) * scale,
  };
}

// ── Main tick — delegated to src/tick.js ──
const _tickCtx = {
  get win() { return win; },
  get currentState() { return _state.getCurrentState(); },
  get currentSvg() { return _state.getCurrentSvg(); },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get dragLocked() { return dragLocked; },
  get menuOpen() { return menuOpen; },
  get idlePaused() { return idlePaused; },
  get isAnimating() { return _mini.getIsAnimating(); },
  get miniSleepPeeked() { return _mini.getMiniSleepPeeked(); },
  set miniSleepPeeked(v) { _mini.setMiniSleepPeeked(v); },
  get mouseOverPet() { return mouseOverPet; },
  set mouseOverPet(v) { mouseOverPet = v; },
  get forceEyeResend() { return forceEyeResend; },
  set forceEyeResend(v) { forceEyeResend = v; },
  get startupRecoveryActive() { return _state.getStartupRecoveryActive(); },
  sendToRenderer,
  setState,
  applyState,
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  getObjRect,
  getHitRectScreen,
};
const _tick = require("./tick")(_tickCtx);
const { startMainTick, resetIdleTimer } = _tick;

// ── Terminal focus — delegated to src/focus.js ──
const _focus = require("./focus")({ _allowSetForeground });
const { initFocusHelper, killFocusHelper, focusTerminalWindow, clearMacFocusCooldownTimer } = _focus;

// ── HTTP server — delegated to src/server.js ──
const _serverCtx = {
  get autoStartWithClaude() { return autoStartWithClaude; },
  get doNotDisturb() { return doNotDisturb; },
  get pendingPermissions() { return pendingPermissions; },
  get PASSTHROUGH_TOOLS() { return PASSTHROUGH_TOOLS; },
  get STATE_SVGS() { return STATE_SVGS; },
  setState,
  updateSession,
  resolvePermissionEntry,
  sendPermissionResponse,
  showPermissionBubble,
  permLog,
};
const _server = require("./server")(_serverCtx);
const { startHttpServer, getHookServerPort, syncMrKrabsHooks } = _server;

// ── alwaysOnTop recovery (Windows DWM / Shell can strip TOPMOST flag) ──
// The "always-on-top-changed" event only fires from Electron's own SetAlwaysOnTop
// path — it does NOT fire when Explorer/Start menu/Gallery silently reorder windows.
// So we keep the event listener for the cases it does catch (Alt/Win key), and add
// a slow watchdog (20s) to recover from silent shell-initiated z-order drops.
const WIN_TOPMOST_LEVEL = "pop-up-menu";  // above taskbar-level UI
const TOPMOST_WATCHDOG_MS = 5_000;
let topmostWatchdog = null;
let hwndRecoveryTimer = null;

// Reinitialize HWND input routing after DWM z-order disruptions.
// showInactive() (ShowWindow SW_SHOWNOACTIVATE) is the same call that makes
// the right-click context menu restore drag capability — it forces Windows to
// fully recalculate the transparent window's input target region.
function scheduleHwndRecovery() {
  if (isMac) return;
  if (hwndRecoveryTimer) clearTimeout(hwndRecoveryTimer);
  hwndRecoveryTimer = setTimeout(() => {
    hwndRecoveryTimer = null;
    if (!win || win.isDestroyed()) return;
    // Just restore z-order — input routing is handled by hitWin now
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (hitWin && !hitWin.isDestroyed()) hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    forceEyeResend = true;
  }, 1000);
}

function guardAlwaysOnTop(w) {
  if (isMac) return;
  w.on("always-on-top-changed", (_, isOnTop) => {
    if (!isOnTop && w && !w.isDestroyed()) {
      w.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      if (w === win && !dragLocked) {
        forceEyeResend = true;
        const { x, y } = win.getBounds();
        win.setPosition(x + 1, y);
        win.setPosition(x, y);
        syncHitWin();
        scheduleHwndRecovery();
      }
    }
  });
}

function startTopmostWatchdog() {
  if (isMac || topmostWatchdog) return;
  topmostWatchdog = setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    // Keep hitWin topmost too
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed() && perm.bubble.isVisible()) perm.bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
  }, TOPMOST_WATCHDOG_MS);
}

function stopTopmostWatchdog() {
  if (topmostWatchdog) { clearInterval(topmostWatchdog); topmostWatchdog = null; }
}

function updateLog(msg) {
  if (!updateDebugLog) return;
  fs.appendFileSync(updateDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

// ── Menu — delegated to src/menu.js ──
const _menuCtx = {
  get win() { return win; },
  get sessions() { return sessions; },
  get currentSize() { return currentSize; },
  set currentSize(v) { currentSize = v; },
  get doNotDisturb() { return doNotDisturb; },
  get lang() { return lang; },
  set lang(v) { lang = v; },
  get showTray() { return showTray; },
  set showTray(v) { showTray = v; },
  get showDock() { return showDock; },
  set showDock(v) { showDock = v; },
  get autoStartWithClaude() { return autoStartWithClaude; },
  set autoStartWithClaude(v) { autoStartWithClaude = v; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  set bubbleFollowPet(v) { bubbleFollowPet = v; },
  get quickSendMode() { return quickSendMode; },
  set quickSendMode(v) { quickSendMode = v; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionBubbles(),
  get isQuitting() { return isQuitting; },
  set isQuitting(v) { isQuitting = v; },
  get menuOpen() { return menuOpen; },
  set menuOpen(v) { menuOpen = v; },
  get tray() { return tray; },
  set tray(v) { tray = v; },
  get contextMenuOwner() { return contextMenuOwner; },
  set contextMenuOwner(v) { contextMenuOwner = v; },
  get contextMenu() { return contextMenu; },
  set contextMenu(v) { contextMenu = v; },
  enableDoNotDisturb: () => enableDoNotDisturb(),
  disableDoNotDisturb: () => disableDoNotDisturb(),
  enterMiniViaMenu: () => enterMiniViaMenu(),
  exitMiniMode: () => exitMiniMode(),
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  miniHandleResize: (sizeKey) => _mini.handleResize(sizeKey),
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  checkForUpdates: (...args) => checkForUpdates(...args),
  getUpdateMenuItem: () => getUpdateMenuItem(),
  buildSessionSubmenu: () => buildSessionSubmenu(),
  savePrefs,
  getHookServerPort: () => getHookServerPort(),
  clampToScreen,
  getNearestWorkArea,
  openTaskPanel: () => openTaskPanel(),
  openQuickTask: () => openQuickTaskWindow(),
  openShortcutSettingsWindow: () => openShortcutSettingsWindow(),
  startIdleTask: () => _tasks.runTaskQueue(),
};
const _menu = require("./menu")(_menuCtx);
const { t, buildContextMenu, buildTrayMenu, rebuildAllMenus, createTray,
        showPetContextMenu, popupMenuAt, ensureContextMenuOwner,
        requestAppQuit, resizeWindow, applyDockVisibility } = _menu;

// ── Auto-updater — delegated to src/updater.js ──
const _updaterCtx = {
  get doNotDisturb() { return doNotDisturb; },
  get miniMode() { return _mini.getMiniMode(); },
  t, rebuildAllMenus, updateLog,
};
const _updater = require("./updater")(_updaterCtx);
const { setupAutoUpdater, checkForUpdates, getUpdateMenuItem, getUpdateMenuLabel } = _updater;

// ── Autonomous task system — delegated to src/tasks.js ──
let taskPanelWin = null;
const _tasksCtx = {
  get userDataPath() { return app.getPath("home"); },
  onTaskFileChanged() {
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-refresh");
    }
  },
  getProjectCwd() {
    let best = null, bestTime = 0;
    for (const [, s] of sessions) {
      if (s.cwd && s.lastActive > bestTime) { best = s; bestTime = s.lastActive; }
    }
    return best ? best.cwd : process.env.HOME;
  },
  onTaskStart(taskText) {
    applyState("sweeping");
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-status", { state: "running", task: taskText });
      taskPanelWin.webContents.send("task-refresh");
    }
  },
  onTaskOutput(taskText, chunk) {
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-output", { task: taskText, chunk });
    }
  },
  onTaskFinish(taskText, result, err) {
    const resolved = resolveDisplayState();
    applyState(resolved, getSvgOverride(resolved));
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-log", {
        task: taskText,
        success: !err,
        preview: err ? err.message : (result || "").slice(0, 200),
        time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      });
      taskPanelWin.webContents.send("task-refresh");
    }
  },
  onQueueEmpty() {
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-status", { state: "idle", task: null });
      taskPanelWin.webContents.send("task-refresh");
    }
  },
  onNeedsInput(taskText, missing) {
    openTaskNotifyWindow(taskText, missing);
  },
  onAttention() {
    applyState("idle", "clawd-idle-follow.svg");
    setTimeout(() => {
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    }, 4000);
  },
};
const _tasks = require("./tasks")(_tasksCtx);
const _interestProfile = require("./interest-profile");

// ── Context monitor — proactive task proposals ──
const _contextMonitorCtx = {
  isExecutorBusy: () => _tasks.isExecutorBusy(),
  getProjectCwd() {
    let best = null, bestTime = 0;
    for (const [, s] of sessions) {
      if (s.cwd && s.lastActive > bestTime) { best = s; bestTime = s.lastActive; }
    }
    return best ? best.cwd : null;
  },
  getTasksRaw: () => _tasks.getTasksRaw(),
  getResults: () => _tasks.getResults(),
  getSessions: () => sessions,
  getSkillsList: () => _tasks.getSkillsList ? _tasks.getSkillsList() : [],
  getTaskGraph: () => _tasks.getTaskGraph ? _tasks.getTaskGraph() : null,
  addProposals(proposals) {
    _tasks.addProposals(proposals);
  },
  onNewProposals(count) {
    applyState("idle", "clawd-idle-follow.svg");
    setTimeout(() => {
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    }, 4000);
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-refresh");
    }
    // 弹窗通知用户有新建议
    if (count > 0) {
      const allTasks = _tasks.getTaskList();
      const proposedItems = allTasks
        .filter(t => t.status === "proposed")
        .slice(-count)  // 取最新添加的
        .map(t => ({ line: t.line, text: t.text }));
      if (proposedItems.length) {
        openProposalNotifyWindow(proposedItems);
      }
    }
  },
};
const _contextMonitor = require("./context-monitor")(_contextMonitorCtx);
_menuCtx.triggerProposals = () => {
  _contextMonitor.triggerNow().then((r) => {
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-proposals-done", r);
    }
  });
};

let shortcutSettingsWin = null;

function openShortcutSettingsWindow() {
  if (shortcutSettingsWin && !shortcutSettingsWin.isDestroyed()) {
    shortcutSettingsWin.show();
    shortcutSettingsWin.focus();
    return;
  }
  shortcutSettingsWin = new BrowserWindow({
    width: 420,
    height: 400,
    minWidth: 360,
    minHeight: 320,
    resizable: true,
    title: "快捷键设置",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload-shortcut-settings.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  shortcutSettingsWin.loadFile(path.join(__dirname, "shortcut-settings.html"));
  shortcutSettingsWin.show();
  shortcutSettingsWin.on("closed", () => { shortcutSettingsWin = null; });
}

function openTaskPanel() {
  try {
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.show();
      taskPanelWin.focus();
      return;
    }
    const { workArea } = screen.getPrimaryDisplay();
    console.log("Mr. Krabs: opening task panel…");
    taskPanelWin = new BrowserWindow({
      width: 800,
      height: 520,
      x: Math.round(workArea.x + (workArea.width - 800) / 2),
      y: Math.round(workArea.y + (workArea.height - 520) / 2),
      frame: true,
      resizable: true,
      title: "Mr. Krabs 任务面板",
      webPreferences: {
        preload: path.join(__dirname, "preload-task-panel.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    taskPanelWin.loadFile(path.join(__dirname, "task-panel.html"));
    taskPanelWin.show();
    taskPanelWin.focus();
    taskPanelWin.on("closed", () => { taskPanelWin = null; });
    taskPanelWin.webContents.on("render-process-gone", (_event, details) => {
      console.error("Mr. Krabs: task panel renderer crashed:", details.reason);
    });
  } catch (err) {
    console.error("Mr. Krabs: failed to open task panel:", err.message);
    taskPanelWin = null;
  }
}

// ── Quick-task input window (Ctrl+Shift+T Spotlight-style) ─────────────────
let quickTaskWin = null;

function openQuickTaskWindow() {
  if (quickTaskWin && !quickTaskWin.isDestroyed()) {
    quickTaskWin.focus();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  quickTaskWin = new BrowserWindow({
    width: 480,
    height: 52,
    x: Math.round(workArea.x + (workArea.width - 480) / 2),
    y: Math.round(workArea.y + workArea.height * 0.30),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-quick-task.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isMac) {
    quickTaskWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    quickTaskWin.setAlwaysOnTop(true, "floating");
  } else {
    quickTaskWin.setAlwaysOnTop(true, "pop-up-menu");
  }
  quickTaskWin.loadFile(path.join(__dirname, "quick-task.html"));
  quickTaskWin.show();
  quickTaskWin.on("blur", () => {
    if (quickTaskWin && !quickTaskWin.isDestroyed()) { quickTaskWin.close(); }
  });
  quickTaskWin.on("closed", () => { quickTaskWin = null; });
}

// ── Task-notify window (needs_input interaction) ───────────────────────────
let taskNotifyWin = null;
let taskNotifyData = null;

function openTaskNotifyWindow(taskText, missing) {
  taskNotifyData = { task: taskText, missing };
  if (taskNotifyWin && !taskNotifyWin.isDestroyed()) {
    taskNotifyWin.focus();
    taskNotifyWin.webContents.send("task-notify-refresh");
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  taskNotifyWin = new BrowserWindow({
    width: 380,
    height: 260,
    x: Math.round(workArea.x + workArea.width - 400),
    y: Math.round(workArea.y + 20),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-task-notify.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isMac) {
    taskNotifyWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    taskNotifyWin.setAlwaysOnTop(true, "floating");
  }
  taskNotifyWin.loadFile(path.join(__dirname, "task-notify.html"));
  taskNotifyWin.show();
  taskNotifyWin.on("closed", () => { taskNotifyWin = null; taskNotifyData = null; });
}

// ── Proposal-notify window (AI 建议弹窗) ───────────────────────────────────
let proposalNotifyWin = null;
let proposalNotifyData = null;

function openProposalNotifyWindow(proposals) {
  // proposals: [{line, text}, ...] — 来自 tasks 的 proposed 条目
  proposalNotifyData = { proposals };
  if (proposalNotifyWin && !proposalNotifyWin.isDestroyed()) {
    proposalNotifyWin.webContents.send("proposal-notify-refresh");
    proposalNotifyWin.focus();
    return;
  }
  const count = proposals.length;
  const itemH = 68;    // 预估每条建议的展示高度
  const chrome = 120;  // header + footer + padding
  const estimated = chrome + count * itemH;
  const winH = Math.max(220, Math.min(600, estimated));

  const { workArea } = screen.getPrimaryDisplay();
  proposalNotifyWin = new BrowserWindow({
    width: 440,
    height: winH,
    x: Math.round(workArea.x + workArea.width - 460),
    y: Math.round(workArea.y + 20),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-proposal-notify.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isMac) {
    proposalNotifyWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    proposalNotifyWin.setAlwaysOnTop(true, "floating");
  }
  proposalNotifyWin.loadFile(path.join(__dirname, "proposal-notify.html"));
  proposalNotifyWin.show();
  proposalNotifyWin.on("closed", () => { proposalNotifyWin = null; proposalNotifyData = null; });
}

// Idle task trigger: start task queue when Mr. Krabs enters sleeping state
let _lastStateForTasks = "";
setInterval(() => {
  const cur = _state.getCurrentState();
  if (cur === "sleeping" && _lastStateForTasks !== "sleeping" && !_tasks.isRunning()) {
    console.log("Mr. Krabs Tasks: pet is sleeping — starting idle task queue");
    _tasks.runTaskQueue();
  }
  _lastStateForTasks = cur;
}, 5000);

// Auto-start task queue: if there are pending tasks and queue is idle, kick it off.
// This covers cases where tasks were added manually or left over from a previous run.
setInterval(() => {
  if (_tasks.isRunning()) return;
  try {
    const tasks = _tasks.getTaskList();
    const hasPending = tasks.some(t => t.status === "pending");
    if (hasPending) {
      console.log("Mr. Krabs Tasks: pending tasks detected while idle — auto-starting queue");
      _tasks.runTaskQueue();
    }
  } catch (_) {}
}, 30000);

// ── Quick-input window (Control+Enter) ──────────────────────────────────────
// Flow: user 划词 → Ctrl+Enter → confirm → paste into Claude CLI terminal → auto-switch back.
// Text lands in the interactive session; Claude processes it and the reply shows in the terminal.
// User barely notices the ~0.5s window flash.

// ── _sendViaClaudeCode: inject text into active terminal running Claude Code ──
function _sendViaClaudeCode(text) {
  let best = null, bestTime = 0, bestPriority = -1;
  for (const [, s] of sessions) {
    if (!s.sourcePid) continue;
    const pri = STATE_PRIORITY[s.state] || 0;
    if (pri > bestPriority || (pri === bestPriority && s.updatedAt > bestTime)) {
      best = s; bestTime = s.updatedAt; bestPriority = pri;
    }
  }
  if (best) {
    _injectAndReturn(text, best.sourcePid, best.pidChain);
    return;
  }
  if (isMac) {
    execFile("/bin/sh", ["-c", "pgrep -x claude | head -1"],
      { timeout: 1500 }, (err, stdout) => {
        const pid = parseInt((stdout || "").trim(), 10);
        if (pid && isFinite(pid)) {
          _injectAndReturn(text, pid, null);
        } else {
          console.warn("Mr. Krabs: no Claude Code session or process found.");
        }
      });
  }
}

// ── _routeAutoChannels: try each channel in order, skip if unavailable ───────
function _routeAutoChannels(text, channels) {
  if (channels.length === 0) {
    console.warn("Mr. Krabs: no Claude channel available for quick send");
    if (isMac) {
      dialog.showMessageBox({
        type: "warning",
        title: "No Claude channel available",
        message: "Could not find a running Claude instance.\nPlease open Claude Desktop or a Claude Code terminal session.",
        buttons: ["OK"],
      }).catch(() => {});
    }
    return;
  }
  const [first, ...rest] = channels;
  if (first === "claude-desktop") {
    if (!isMac) { _routeAutoChannels(text, rest); return; }
    execFile("/bin/sh", ["-c", "pgrep -x Claude | head -1"], { timeout: 1000 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        sendToClaudeDesktop(text);
      } else {
        _routeAutoChannels(text, rest);
      }
    });
  } else if (first === "claude-code") {
    if (sessions.size > 0) {
      _sendViaClaudeCode(text);
    } else if (isMac) {
      execFile("/bin/sh", ["-c", "pgrep -x claude | head -1"], { timeout: 1000 }, (err, stdout) => {
        const pid = parseInt((stdout || "").trim(), 10);
        if (pid && isFinite(pid)) {
          _injectAndReturn(text, pid, null);
        } else {
          _routeAutoChannels(text, rest);
        }
      });
    } else {
      _routeAutoChannels(text, rest);
    }
  } else {
    _routeAutoChannels(text, rest); // unknown channel, skip
  }
}

// ── sendToClaude: main entry point for Ctrl+Enter quick send ─────────────────
function sendToClaude(text) {
  if (quickSendMode === "claude-desktop") {
    // Explicit Desktop — try it, fallback to Code if not running
    if (!isMac) { _sendViaClaudeCode(text); return; }
    execFile("/bin/sh", ["-c", "pgrep -x Claude | head -1"], { timeout: 1000 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        sendToClaudeDesktop(text);
      } else {
        console.warn("Mr. Krabs: Claude Desktop not running, falling back to Claude Code");
        _sendViaClaudeCode(text);
      }
    });
  } else if (quickSendMode === "claude-code" || quickSendMode === "claude-cli") {
    // Explicit Code/CLI — always inject into terminal
    _sendViaClaudeCode(text);
  } else {
    // "auto" — try Desktop first, then Code
    _routeAutoChannels(text, ["claude-desktop", "claude-code"]);
  }
}

function _injectAndReturn(text, sourcePid, pidChain) {
  const prevClipboard = clipboard.readText();
  clipboard.writeText(text);

  // Walk up the process tree to find the terminal app (Terminal.app / iTerm2 / etc.)
  // that owns the Claude CLI process, then activate that app to paste.
  const findTerminalScript = `
set targetPid to ${sourcePid}
set termPid to 0
repeat 8 times
  try
    set ppidStr to do shell script "ps -o ppid= -p " & targetPid
    set targetPid to (ppidStr as integer)
    set commStr to do shell script "ps -o comm= -p " & targetPid
    if commStr contains "Terminal" or commStr contains "iTerm" or commStr contains "Alacritty" or commStr contains "kitty" or commStr contains "WezTerm" or commStr contains "Warp" then
      set termPid to targetPid
      exit repeat
    end if
  on error
    exit repeat
  end try
end repeat

tell application "System Events"
  set prevApp to first application process whose frontmost is true

  if termPid > 0 then
    set termProcs to every process whose unix id is termPid
    if (count of termProcs) > 0 then
      set frontmost of item 1 of termProcs to true
    end if
  else
    -- Fallback: try activating Terminal.app directly
    try
      tell application "Terminal" to activate
    end try
  end if

  delay 0.4
  keystroke "v" using {command down}
  delay 0.5
  key code 36
  delay 0.2
  set frontmost of prevApp to true
end tell`;

  execFile("osascript", ["-e", findTerminalScript], { timeout: 6000 }, (err) => {
    if (err) console.warn("Mr. Krabs: inject failed:", err.message);
    setTimeout(() => clipboard.writeText(prevClipboard), 800);
  });
}

// ── Send text to Claude Desktop App via AppleScript ─────────────────────────
// Claude Desktop is an Electron app named "Claude". Its main input field
// accepts Cmd+V paste and Enter submission just like a standard text area.
// We activate it, paste the text, press Enter, then restore the previous app.
function sendToClaudeDesktop(text) {
  if (!isMac) {
    console.warn("Mr. Krabs: Claude Desktop send is only supported on macOS");
    return;
  }
  const prevClipboard = clipboard.readText();
  clipboard.writeText(text);
  const script = `
tell application "System Events"
  set prevApp to first application process whose frontmost is true
end tell
tell application "Claude" to activate
tell application "System Events"
  delay 0.4
  keystroke "v" using {command down}
  delay 0.2
  key code 36
  delay 0.15
  set frontmost of prevApp to true
end tell`;
  execFile("osascript", ["-e", script], { timeout: 6000 }, (err) => {
    if (err) {
      console.warn("Mr. Krabs: send to Claude Desktop failed:", err.message);
      // Show a non-blocking warning dialog
      dialog.showMessageBox({
        type: "warning",
        title: "Claude Desktop not running",
        message: "Could not send to Claude Desktop App.\nPlease make sure Claude Desktop is open, or switch the send target to Claude Code in the right-click menu.",
        buttons: ["OK"],
      }).catch(() => {});
    }
    setTimeout(() => clipboard.writeText(prevClipboard), 800);
  });
}

function openChatWindow() {
  // If already open, bring to front
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.focus();
    return;
  }

  // macOS: check Accessibility permission (cached to avoid repeated TCC hits)
  if (isMac) {
    // Refresh cache: isTrustedAccessibilityClient(false) = check without prompting
    _accessibilityCached = systemPreferences.isTrustedAccessibilityClient(false);

    if (!_accessibilityCached) {
      console.warn("Mr. Krabs: Accessibility permission NOT granted");

      // Avoid double-prompting if user is already looking at the dialog
      if (_accessibilityPromptCooldown) return;
      _accessibilityPromptCooldown = true;
      setTimeout(() => { _accessibilityPromptCooldown = false; }, 5000);

      // Show a clear dialog instead of silently jumping to System Settings
      dialog.showMessageBox({
        type: "warning",
        title: "需要辅助功能权限",
        message: "Mr. Krabs 需要「辅助功能」权限才能捕获划词文本。\n\n点击「去授权」打开系统设置，找到 Mr. Krabs 并开启开关。\n\n⚠️ 授权后需要重启 Mr. Krabs 才能生效（macOS 系统限制）。",
        buttons: ["去授权", "取消"],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          // Open Accessibility pane via official Electron API (most reliable across macOS versions)
          systemPreferences.isTrustedAccessibilityClient(true);
        }
      });
      return;
    }
  }

  // macOS: synthetic Cmd+C → read general pasteboard plain text = selection, then restore.
  if (isMac) {
    setTimeout(() => {
      try {
        const plainBeforeCopy = clipboard.readText();
        console.log("Mr. Krabs: [划词] starting synthetic Cmd+C, clipboard before:", JSON.stringify(plainBeforeCopy.slice(0, 80)));
        // Release ALL modifier keys so Cmd+C is clean; target frontmost app explicitly.
        const copyScript = `
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set frontName to name of frontProc
  key up control
  key up shift
  key up option
  key up command
  delay 0.02
  tell frontProc to keystroke "c" using {command down}
  return frontName
end tell`;
        execFile("osascript", ["-e", copyScript], { timeout: 1500 }, (err, stdout, stderr) => {
          if (err) {
            console.warn("Mr. Krabs: [划词] osascript FAILED:", err.message);
            // macOS TCC: if osascript was denied accessibility, stderr contains "not allowed"
            // This happens when the app was just granted permission but hasn't restarted yet.
            const stderrStr = (stderr || "").toString();
            if (stderrStr.includes("not allowed") || stderrStr.includes("assistive")) {
              // Permission was granted in TCC but hasn't taken effect yet — need restart
              if (!_accessibilityPromptCooldown) {
                _accessibilityPromptCooldown = true;
                setTimeout(() => { _accessibilityPromptCooldown = false; }, 8000);
                dialog.showMessageBox({
                  type: "info",
                  title: "需要重启 Mr. Krabs",
                  message: "辅助功能权限已授予，但需要重启 Mr. Krabs 才能生效。\n\n请退出并重新打开 Mr. Krabs。",
                  buttons: ["好的"],
                }).catch(() => {});
              }
              return; // 不开空窗口
            }
            // Other errors: open window without selection as fallback
            chatContextSnapshot = "";
            chatContextSnapshotPending = true;
            _doOpenChatWindow();
            return;
          }
          console.log("Mr. Krabs: [划词] osascript sent Cmd+C to:", (stdout || "").trim());
          readPostCopyContextPlainMac(plainBeforeCopy, (contextPlain) => {
            console.log("Mr. Krabs: [划词] captured text:", contextPlain ? JSON.stringify(contextPlain.slice(0, 100)) : "(empty)");
            chatContextSnapshot = contextPlain;
            chatContextSnapshotPending = true;
            try {
              clipboard.writeText(plainBeforeCopy);
            } catch (e) {
              console.warn("Mr. Krabs: [划词] clipboard restore failed:", e.message);
            }
            _doOpenChatWindow();
          });
        });
      } catch (e) {
        // Ultimate fallback: if anything throws, still open the window
        console.error("Mr. Krabs: [划词] unexpected error:", e.message);
        chatContextSnapshot = "";
        chatContextSnapshotPending = true;
        _doOpenChatWindow();
      }
    }, 80);
  } else {
    // Windows: synthetic Ctrl+C to capture selection
    setTimeout(() => {
      const plainBeforeCopy = clipboard.readText();
      try {
        const { execSync } = require("child_process");
        // Use PowerShell to send Ctrl+C keystroke
        execSync("powershell -NoProfile -Command \"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')\"", { timeout: 2000 });
      } catch (e) {
        console.warn("Mr. Krabs: Windows copy failed:", e.message);
      }
      // Poll clipboard for change
      const start = Date.now();
      const tick = () => {
        const now = clipboard.readText();
        if (now !== plainBeforeCopy) {
          chatContextSnapshot = now;
          chatContextSnapshotPending = true;
          clipboard.writeText(plainBeforeCopy);
          _doOpenChatWindow();
          return;
        }
        if (Date.now() - start >= 600) {
          chatContextSnapshot = "";
          chatContextSnapshotPending = true;
          _doOpenChatWindow();
          return;
        }
        setTimeout(tick, 30);
      };
      setTimeout(tick, 50);
    }, 80);
  }
}

function _doOpenChatWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  chatWin = new BrowserWindow({
    width: 440,
    height: 120,
    x: Math.round(workArea.x + (workArea.width - 440) / 2),
    y: Math.round(workArea.y + workArea.height * 0.35),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-chat.js"),
      backgroundThrottling: false,
    },
  });

  if (isMac) {
    chatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    chatWin.setAlwaysOnTop(true, "floating");
  } else {
    chatWin.setAlwaysOnTop(true, "pop-up-menu");
  }

  chatWin.loadFile(path.join(__dirname, "chat.html"));
  chatWin.show();

  // ── Safety: auto-close on blur (click outside) ──
  // Guard: ignore blur for first 400ms — macOS can fire blur immediately
  // on the same tick as show(), closing the window before user sees it.
  const _chatOpenTime = Date.now();
  chatWin.on("blur", () => {
    if (Date.now() - _chatOpenTime < 400) return; // too soon, ignore
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.close();
      chatWin = null;
    }
  });

  chatWin.on("closed", () => { chatWin = null; });

  // ── Safety: auto-close after 60s in case something goes wrong ──
  const _chatSafetyTimer = setTimeout(() => {
    if (chatWin && !chatWin.isDestroyed()) {
      console.warn("Mr. Krabs: chat window safety timeout — auto-closing");
      chatWin.close();
      chatWin = null;
    }
  }, 60000);
  chatWin.on("closed", () => clearTimeout(_chatSafetyTimer));
}

// ────────────────────────────────────────────────────────────────────────────

function createWindow() {
  const prefs = loadPrefs();
  if (prefs && SIZES[prefs.size]) currentSize = prefs.size;
  if (prefs && (prefs.lang === "en" || prefs.lang === "zh")) lang = prefs.lang;
  // macOS: restore tray/dock visibility from prefs
  if (isMac && prefs) {
    if (typeof prefs.showTray === "boolean") showTray = prefs.showTray;
    if (typeof prefs.showDock === "boolean") showDock = prefs.showDock;
  }
  if (prefs && typeof prefs.autoStartWithClaude === "boolean") autoStartWithClaude = prefs.autoStartWithClaude;
  if (prefs && typeof prefs.bubbleFollowPet === "boolean") bubbleFollowPet = prefs.bubbleFollowPet;
  // Load quickSendMode (v0.6.5+); migrate from old claudeTarget (v0.6.4)
  const _VALID_MODES = ["auto", "claude-desktop", "claude-code", "claude-cli"];
  if (prefs && _VALID_MODES.includes(prefs.quickSendMode)) {
    quickSendMode = prefs.quickSendMode;
  } else if (prefs && prefs.claudeTarget === "claude-desktop") {
    quickSendMode = "claude-desktop"; // migrate from v0.6.4
  }
  // Load custom shortcuts (v0.6.12+)
  if (prefs && typeof prefs.chatShortcut === "string" && prefs.chatShortcut) {
    chatShortcut = prefs.chatShortcut;
  }
  if (prefs && typeof prefs.quickTaskShortcut === "string" && prefs.quickTaskShortcut) {
    quickTaskShortcut = prefs.quickTaskShortcut;
  }
  // macOS: apply dock visibility (default hidden)
  if (isMac) {
    applyDockVisibility();
  }
  const size = SIZES[currentSize];

  // Restore saved position, or default to bottom-right of primary display
  let startX, startY;
  if (prefs && prefs.miniMode) {
    // Restore mini mode
    const miniPos = _mini.restoreFromPrefs(prefs, size);
    startX = miniPos.x;
    startY = miniPos.y;
  } else if (prefs) {
    const clamped = clampToScreen(prefs.x, prefs.y, size.width, size.height);
    startX = clamped.x;
    startY = clamped.y;
  } else {
    const { workArea } = screen.getPrimaryDisplay();
    startX = workArea.x + workArea.width - size.width - 20;
    startY = workArea.y + workArea.height - size.height - 20;
  }

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });

  win.setFocusable(false);
  if (isMac) {
    // macOS: show on all Spaces (virtual desktops) and use floating window level
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.setAlwaysOnTop(true, "floating");
  } else {
    // Windows: use pop-up-menu level to stay above taskbar/shell UI
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }
  win.loadFile(path.join(__dirname, "index.html"));
  win.showInactive();

  // macOS: startup-time dock state can be overridden during app/window activation.
  // Re-apply once on next tick so persisted showDock reliably takes effect.
  if (isMac) {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      applyDockVisibility();
    }, 0);
  }

  buildContextMenu();
  if (!isMac || showTray) createTray();
  ensureContextMenuOwner();



  // ── Create input window (hitWin) — small rect over hitbox, receives all pointer events ──
  {
    const initBounds = win.getBounds();
    const initHit = getHitRectScreen(initBounds);
    const hx = Math.round(initHit.left), hy = Math.round(initHit.top);
    const hw = Math.round(initHit.right - initHit.left);
    const hh = Math.round(initHit.bottom - initHit.top);

    hitWin = new BrowserWindow({
      width: hw, height: hh, x: hx, y: hy,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,  // KEY EXPERIMENT: allow activation to avoid WS_EX_NOACTIVATE input routing bugs
      webPreferences: {
        preload: path.join(__dirname, "preload-hit.js"),
        backgroundThrottling: false,
      },
    });
    // setShape: native hit region, no per-pixel alpha dependency.
    // hitWin has no visual content — clipping is irrelevant.
    hitWin.setShape([{ x: 0, y: 0, width: hw, height: hh }]);
    hitWin.setIgnoreMouseEvents(false);  // PERMANENT — never toggle
    hitWin.showInactive();
    if (isMac) {
      hitWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
      hitWin.setAlwaysOnTop(true, "floating");
    } else {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    hitWin.loadFile(path.join(__dirname, "hit.html"));
    if (!isMac) guardAlwaysOnTop(hitWin);

    // Event-level safety net for position sync
    win.on("move", syncHitWin);
    win.on("resize", syncHitWin);

    // Send initial state to hitWin once it's ready
    hitWin.webContents.on("did-finish-load", () => {
      sendToHitWin("hit-state-sync", {
        currentSvg: _state.getCurrentSvg(), miniMode: _mini.getMiniMode(), dndEnabled: doNotDisturb,
      });
    });

    // Crash recovery for hitWin
    hitWin.webContents.on("render-process-gone", (_event, details) => {
      console.error("hitWin renderer crashed:", details.reason);
      hitWin.webContents.reload();
    });
  }

  ipcMain.on("show-context-menu", showPetContextMenu);

  ipcMain.on("move-window-by", (event, dx, dy) => {
    if (_mini.getMiniMode() || _mini.getMiniTransitioning()) return;
    const { x, y } = win.getBounds();
    const size = SIZES[currentSize];
    const clamped = clampToScreen(x + dx, y + dy, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
    if (bubbleFollowPet && pendingPermissions.length) repositionBubbles();
  });

  ipcMain.on("pause-cursor-polling", () => { idlePaused = true; });
  ipcMain.on("resume-from-reaction", () => {
    idlePaused = false;
    if (_mini.getMiniTransitioning()) return;
    sendToRenderer("state-change", _state.getCurrentState(), _state.getCurrentSvg());
  });

  ipcMain.on("drag-lock", (event, locked) => {
    dragLocked = !!locked;
    if (locked) mouseOverPet = true;
  });

  // Reaction relay: hitWin → main → renderWin
  ipcMain.on("start-drag-reaction", () => sendToRenderer("start-drag-reaction"));
  ipcMain.on("end-drag-reaction", () => sendToRenderer("end-drag-reaction"));
  ipcMain.on("play-click-reaction", (_, svg, duration) => {
    sendToRenderer("play-click-reaction", svg, duration);
  });

  ipcMain.on("drag-end", () => {
    if (!_mini.getMiniMode() && !_mini.getMiniTransitioning()) {
      checkMiniModeSnap();
    }
  });

  ipcMain.on("exit-mini-mode", () => {
    if (_mini.getMiniMode()) exitMiniMode();
  });

  ipcMain.on("focus-terminal", () => {
    // Find the best session to focus: prefer highest priority (non-idle), then most recent
    let best = null, bestTime = 0, bestPriority = -1;
    for (const [, s] of sessions) {
      if (!s.sourcePid) continue;
      const pri = STATE_PRIORITY[s.state] || 0;
      if (pri > bestPriority || (pri === bestPriority && s.updatedAt > bestTime)) {
        best = s;
        bestTime = s.updatedAt;
        bestPriority = pri;
      }
    }
    if (best) focusTerminalWindow(best.sourcePid, best.cwd, best.editor, best.pidChain);
  });

  ipcMain.on("show-session-menu", () => {
    popupMenuAt(Menu.buildFromTemplate(buildSessionSubmenu()));
  });

  ipcMain.on("bubble-height", (event, height) => _perm.handleBubbleHeight(event, height));
  ipcMain.on("permission-decide", (event, behavior) => _perm.handleDecide(event, behavior));

  // ── Chat window IPC ──
  ipcMain.handle("chat-get-init", () => {
    let raw;
    if (chatContextSnapshotPending) {
      chatContextSnapshotPending = false;
      raw = chatContextSnapshot;
    } else {
      raw = "";
    }
    const result = { context: truncateContextPreview(raw, 500) };
    if (_accessibilityWarningShown) {
      result.accessibilityWarning = true;
      _accessibilityWarningShown = false;
    }
    return result;
  });
  ipcMain.on("chat-send", (_, text) => {
    if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; }
    if (text && text.trim()) {
      sendToClaude(text.trim());
      _interestProfile.recordSignal(text.trim(), "select");
    }
  });
  ipcMain.on("chat-close", () => {
    if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; }
  });
  ipcMain.on("chat-resize", (_, height) => {
    if (chatWin && !chatWin.isDestroyed()) {
      const safeH = Math.max(80, Math.min(height, 400));
      const [w] = chatWin.getContentSize();
      chatWin.setContentSize(w, safeH);
    }
  });
  ipcMain.on("chat-add-task", (_, text) => {
    if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; }
    if (text && text.trim()) {
      _tasks.addTask(text.trim());
      _interestProfile.recordSignal(text.trim(), "ask");
    }
  });

  // ── Quick-task window IPC ──
  ipcMain.on("quick-task-add", (_, text) => {
    if (quickTaskWin && !quickTaskWin.isDestroyed()) { quickTaskWin.close(); quickTaskWin = null; }
    if (text && text.trim()) {
      _tasks.addTask(text.trim());
      _interestProfile.recordSignal(text.trim(), "ask");
    }
  });
  ipcMain.on("quick-task-close", () => {
    if (quickTaskWin && !quickTaskWin.isDestroyed()) { quickTaskWin.close(); quickTaskWin = null; }
  });

  // ── Task-notify window IPC ──
  ipcMain.handle("task-notify-get-data", () => taskNotifyData || { task: "", missing: "" });
  ipcMain.on("task-notify-submit", (_, supplement) => {
    if (taskNotifyData && supplement) {
      const appended = _tasks.appendToTaskByText(taskNotifyData.task, supplement);
      const rerun = _tasks.rerunTask(taskNotifyData.task);
      console.log(`Mr. Krabs Tasks: supplement submitted, appended=${appended}, rerun=${rerun}`);
    }
    if (taskNotifyWin && !taskNotifyWin.isDestroyed()) { taskNotifyWin.close(); }
  });
  ipcMain.on("task-notify-dismiss", () => {
    if (taskNotifyWin && !taskNotifyWin.isDestroyed()) { taskNotifyWin.close(); }
  });

  // ── Proposal-notify window IPC ──
  ipcMain.handle("proposal-notify-get-data", () => proposalNotifyData || { proposals: [] });
  ipcMain.on("proposal-notify-accept", (_, lineIndex) => {
    _tasks.updateTaskStatus(lineIndex, "pending");
    _tasks.prioritizeTask(lineIndex);
    console.log(`Mr. Krabs Tasks: accepted proposal from notify, line=${lineIndex}, running=${_tasks.isRunning()}`);
    if (!_tasks.isRunning()) {
      _tasks.runTaskQueue();
    }
    // 兴趣画像反馈：采纳 → 权重 +1.5
    try {
      const taskList = _tasks.getTaskList();
      const task = taskList.find(t => t.line === lineIndex);
      if (task) _interestProfile.onAdopt(task.text);
    } catch (e) { console.warn("Mr. Krabs: interest adopt feedback failed:", e.message); }
    // 同步刷新任务面板
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-refresh");
    }
  });
  ipcMain.on("proposal-notify-reject", (_, lineIndex) => {
    // 兴趣画像反馈：拒绝 → 权重 -0.8
    try {
      const taskList = _tasks.getTaskList();
      const task = taskList.find(t => t.line === lineIndex);
      if (task) _interestProfile.onReject(task.text);
    } catch (e) { console.warn("Mr. Krabs: interest reject feedback failed:", e.message); }
    _tasks.deleteTask(lineIndex);
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      taskPanelWin.webContents.send("task-refresh");
    }
  });
  ipcMain.on("proposal-notify-supplement", (_, lineIndex, supplementText) => {
    if (supplementText && supplementText.trim()) {
      _tasks.appendToTask(lineIndex, supplementText.trim());
      _tasks.updateTaskStatus(lineIndex, "pending");
      _tasks.prioritizeTask(lineIndex);
      console.log(`Mr. Krabs Tasks: supplemented & accepted proposal, line=${lineIndex}`);
      // 兴趣画像反馈：补充并采纳 → 权重 +1.5（含补充文本）
      try {
        const taskList = _tasks.getTaskList();
        const task = taskList.find(t => t.line === lineIndex);
        if (task) _interestProfile.onAdopt(task.text + " " + supplementText.trim());
      } catch (e) { console.warn("Mr. Krabs: interest adopt feedback failed:", e.message); }
      if (!_tasks.isRunning()) {
        _tasks.runTaskQueue();
      }
      if (taskPanelWin && !taskPanelWin.isDestroyed()) {
        taskPanelWin.webContents.send("task-refresh");
      }
    }
  });
  ipcMain.on("proposal-notify-resize", (_, height) => {
    if (proposalNotifyWin && !proposalNotifyWin.isDestroyed()) {
      const safeH = Math.max(220, Math.min(600, height));
      const [w] = proposalNotifyWin.getContentSize();
      proposalNotifyWin.setContentSize(w, safeH);
    }
  });
  ipcMain.on("proposal-notify-dismiss", () => {
    if (proposalNotifyWin && !proposalNotifyWin.isDestroyed()) { proposalNotifyWin.close(); }
  });

  // ── Task panel IPC ──
  ipcMain.handle("task-get-tasks", () => _tasks.getTaskList());
  ipcMain.handle("task-get-results", () => _tasks.getResults());
  ipcMain.handle("task-add", (_, text, section) => { _tasks.addTask(text, section); });
  ipcMain.handle("task-get-status", () => _tasks.getStatus());
  ipcMain.handle("task-trigger-proposals", () => _contextMonitor.triggerNow());
  ipcMain.on("task-run-now", () => _tasks.runTaskQueue());
  ipcMain.on("task-stop", () => _tasks.stopTaskQueue());
  ipcMain.on("task-pause", () => _tasks.pauseTaskQueue());
  ipcMain.handle("task-update-status", (_, lineIndex, newStatus) => {
    _tasks.updateTaskStatus(lineIndex, newStatus);
  });
  ipcMain.handle("task-edit", (_, lineIndex, newText) => {
    _tasks.editTask(lineIndex, newText);
  });
  ipcMain.handle("task-delete", (_, lineIndex) => {
    _tasks.deleteTask(lineIndex);
  });
  ipcMain.handle("task-move", (_, fromLine, toLine) => {
    return _tasks.moveTask(fromLine, toLine);
  });
  ipcMain.handle("task-append", (_, lineIndex, supplement) => {
    _tasks.appendToTask(lineIndex, supplement);
  });
  ipcMain.handle("task-follow-up", (_, originalText, followUpPrompt) => {
    _tasks.createFollowUp(originalText, followUpPrompt);
  });
  ipcMain.handle("task-open-file", (_, filepath) => {
    return _tasks.openDeliverable(filepath);
  });
  ipcMain.handle("task-get-deliverables", () => {
    return _tasks.getDeliverables();
  });
  ipcMain.handle("task-accept-proposal", (_, lineIndex) => {
    _tasks.updateTaskStatus(lineIndex, "pending");
    _tasks.prioritizeTask(lineIndex);
    console.log(`Mr. Krabs Tasks: accepted proposal from panel, line=${lineIndex}, running=${_tasks.isRunning()}`);
    // 兴趣画像反馈：采纳 → 权重 +1.5
    try {
      const taskList = _tasks.getTaskList();
      const task = taskList.find(t => t.line === lineIndex);
      if (task) _interestProfile.onAdopt(task.text);
    } catch (e) { console.warn("Mr. Krabs: interest adopt feedback failed:", e.message); }
    // 采纳建议后，如果队列当前空闲，自动启动执行
    if (!_tasks.isRunning()) {
      _tasks.runTaskQueue();
    }
    // 主动推送最新执行状态给任务面板（让状态栏立刻更新，不依赖轮询）
    if (taskPanelWin && !taskPanelWin.isDestroyed()) {
      // 稍等一个 tick 让 runTaskQueue 内部 updateTaskStatus("running") 先落盘
      setTimeout(() => {
        if (taskPanelWin && !taskPanelWin.isDestroyed()) {
          const st = _tasks.getStatus();
          taskPanelWin.webContents.send("task-status", st);
          taskPanelWin.webContents.send("task-refresh");
        }
      }, 50);
    }
  });
  // ── Shortcut settings IPC ──
  ipcMain.handle("shortcuts-get", () => ({
    chatShortcut,
    quickTaskShortcut,
    defaultChatShortcut: DEFAULT_CHAT_SHORTCUT,
    defaultQuickTaskShortcut: DEFAULT_QUICK_TASK_SHORTCUT,
  }));
  ipcMain.handle("shortcuts-set", (_, which, accel) => {
    if (!accel || typeof accel !== "string") return false;
    const prev = which === "chat" ? chatShortcut : quickTaskShortcut;
    // Try registering the new shortcut
    globalShortcut.unregisterAll();
    const newChat  = which === "chat"  ? accel : chatShortcut;
    const newTask  = which === "task"  ? accel : quickTaskShortcut;
    const okChat = globalShortcut.register(newChat, openChatWindow);
    const okTask = globalShortcut.register(newTask, openQuickTaskWindow);
    if ((which === "chat" && !okChat) || (which === "task" && !okTask)) {
      // Rollback
      globalShortcut.unregisterAll();
      globalShortcut.register(chatShortcut, openChatWindow);
      globalShortcut.register(quickTaskShortcut, openQuickTaskWindow);
      return false;
    }
    if (which === "chat")  chatShortcut = accel;
    if (which === "task")  quickTaskShortcut = accel;
    savePrefs();
    return true;
  });

  ipcMain.handle("task-reject-proposal", (_, lineIndex) => {
    // 兴趣画像反馈：拒绝 → 权重 -0.8
    try {
      const taskList = _tasks.getTaskList();
      const task = taskList.find(t => t.line === lineIndex);
      if (task) _interestProfile.onReject(task.text);
    } catch (e) { console.warn("Mr. Krabs: interest reject feedback failed:", e.message); }
    _tasks.deleteTask(lineIndex);
  });

  initFocusHelper();
  startMainTick();
  startHttpServer();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-finish-load", () => {
    if (_mini.getMiniMode()) {
      sendToRenderer("mini-mode-change", true);
    sendToHitWin("hit-state-sync", { miniMode: true });
    }
    if (doNotDisturb) {
      sendToRenderer("dnd-change", true);
    sendToHitWin("hit-state-sync", { dndEnabled: true });
      if (_mini.getMiniMode()) {
        applyState("mini-sleep");
      } else {
        applyState("sleeping");
      }
    } else if (_mini.getMiniMode()) {
      applyState("mini-idle");
    } else if (sessions.size > 0) {
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    } else {
      applyState("idle", "clawd-idle-follow.svg");
      // Startup recovery: delay 5s to let HWND/z-order/drag systems stabilize,
      // then detect running Claude Code processes → suppress sleep sequence
      setTimeout(() => {
        if (sessions.size > 0 || doNotDisturb) return; // hook arrived during wait
        detectRunningAgentProcesses((found) => {
          if (found && sessions.size === 0 && !doNotDisturb) {
            _startStartupRecovery();
            resetIdleTimer();
          }
        });
      }, 5000);
    }
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer crashed:", details.reason);
    dragLocked = false;
    idlePaused = false;
    mouseOverPet = false;
    win.webContents.reload();
  });

  guardAlwaysOnTop(win);
  startTopmostWatchdog();

  // ── Display change: re-clamp window to prevent off-screen ──
  screen.on("display-metrics-changed", () => {
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniMode()) {
      _mini.handleDisplayChange();
      return;
    }
    const { x, y, width, height } = win.getBounds();
    const clamped = clampToScreen(x, y, width, height);
    if (clamped.x !== x || clamped.y !== y) {
      win.setBounds({ ...clamped, width, height });
    }
  });
  screen.on("display-removed", () => {
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniMode()) {
      exitMiniMode();
      return;
    }
    const { x, y, width, height } = win.getBounds();
    const clamped = clampToScreen(x, y, width, height);
    win.setBounds({ ...clamped, width, height });
  });
}

function getNearestWorkArea(cx, cy) {
  const displays = screen.getAllDisplays();
  let nearest = displays[0].workArea;
  let minDist = Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    const dx = Math.max(wa.x - cx, 0, cx - (wa.x + wa.width));
    const dy = Math.max(wa.y - cy, 0, cy - (wa.y + wa.height));
    const dist = dx * dx + dy * dy;
    if (dist < minDist) { minDist = dist; nearest = wa; }
  }
  return nearest;
}

function clampToScreen(x, y, w, h) {
  const nearest = getNearestWorkArea(x + w / 2, y + h / 2);
  const mLeft  = Math.round(w * 0.25);
  const mRight = Math.round(w * 0.25);
  const mTop   = Math.round(h * 0.6);
  const mBot   = Math.round(h * 0.04);
  return {
    x: Math.max(nearest.x - mLeft, Math.min(x, nearest.x + nearest.width - w + mRight)),
    y: Math.max(nearest.y - mTop,  Math.min(y, nearest.y + nearest.height - h + mBot)),
  };
}

// ── Mini Mode — initialized here after state module ──
const _miniCtx = {
  get win() { return win; },
  get currentSize() { return currentSize; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  SIZES,
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  applyState,
  resolveDisplayState,
  getSvgOverride,
  stopWakePoll,
  clampToScreen,
  getNearestWorkArea,
  get bubbleFollowPet() { return bubbleFollowPet; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionBubbles(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
};
const _mini = require("./mini")(_miniCtx);
const { enterMiniMode, exitMiniMode, enterMiniViaMenu, miniPeekIn, miniPeekOut,
        checkMiniModeSnap, cancelMiniTransition, animateWindowX, animateWindowParabola } = _mini;

// Convenience getters for mini state (used throughout main.js)
Object.defineProperties(this || {}, {}); // no-op placeholder
// Mini state is accessed via _mini getters in ctx objects below

// ── Auto-install VS Code / Cursor terminal-focus extension ──
const EXT_ID = "mr-krabs.mr-krabs-terminal-focus";
const EXT_VERSION = "0.1.0";
const EXT_DIR_NAME = `${EXT_ID}-${EXT_VERSION}`;

function installTerminalFocusExtension() {
  const os = require("os");
  const home = os.homedir();

  // Extension source — in dev: ../extensions/vscode/, in packaged: app.asar.unpacked/
  let extSrc = path.join(__dirname, "..", "extensions", "vscode");
  extSrc = extSrc.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);

  if (!fs.existsSync(extSrc)) {
    console.log("Mr. Krabs: terminal-focus extension source not found, skipping auto-install");
    return;
  }

  const targets = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];

  const filesToCopy = ["package.json", "extension.js"];
  let installed = 0;

  for (const extRoot of targets) {
    if (!fs.existsSync(extRoot)) continue; // editor not installed
    const dest = path.join(extRoot, EXT_DIR_NAME);
    // Skip if already installed (check package.json exists)
    if (fs.existsSync(path.join(dest, "package.json"))) continue;
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const file of filesToCopy) {
        fs.copyFileSync(path.join(extSrc, file), path.join(dest, file));
      }
      installed++;
      console.log(`Mr. Krabs: installed terminal-focus extension to ${dest}`);
    } catch (err) {
      console.warn(`Mr. Krabs: failed to install extension to ${dest}:`, err.message);
    }
  }
  if (installed > 0) {
    console.log(`Mr. Krabs: terminal-focus extension installed to ${installed} editor(s). Restart VS Code/Cursor to activate.`);
  }
}

// ── Single instance lock ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) win.showInactive();
    if (hitWin && !hitWin.isDestroyed()) hitWin.showInactive();
  });

  // macOS: hide dock icon early if user previously disabled it
  if (isMac && app.dock) {
    const prefs = loadPrefs();
    if (prefs && prefs.showDock === false) {
      app.dock.hide();
    }
  }

  app.whenReady().then(() => {
    permDebugLog = path.join(app.getPath("userData"), "permission-debug.log");
    updateDebugLog = path.join(app.getPath("userData"), "update-debug.log");
    createWindow();

    // Register global shortcuts (user-customizable, loaded from prefs above)
    reregisterShortcuts();

    // Start context monitor for proactive task proposals
    _contextMonitor.start();

    // Auto-register Claude Code hooks on every launch (dedup-safe)
    syncMrKrabsHooks();

    // Start Codex CLI JSONL log monitor
    try {
      const CodexLogMonitor = require("../agents/codex-log-monitor");
      const codexAgent = require("../agents/codex");
      _codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra) => {
        updateSession(sid, state, event, extra.sourcePid, extra.cwd, null, null, extra.agentPid, "codex");
      });
      _codexMonitor.start();
    } catch (err) {
      console.warn("Mr. Krabs: Codex log monitor not started:", err.message);
    }

    // Auto-install VS Code/Cursor terminal-focus extension
    try { installTerminalFocusExtension(); } catch (err) {
      console.warn("Mr. Krabs: failed to auto-install terminal-focus extension:", err.message);
    }

    // Auto-updater: check for new version on startup (silent) and on manual request
    setupAutoUpdater();
    setTimeout(() => checkForUpdates(false), 8000); // 8s delay so app fully loads first

    // Autonomous task system: start scheduled execution (default: 02:00, 14:00)
    _tasks.startScheduledExecution([2, 14]);
  });

  app.on("before-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    savePrefs();
    _perm.cleanup();
    _server.cleanup();
    _state.cleanup();
    _tick.cleanup();
    _mini.cleanup();
    if (_codexMonitor) _codexMonitor.stop();
    stopTopmostWatchdog();
    if (hwndRecoveryTimer) { clearTimeout(hwndRecoveryTimer); hwndRecoveryTimer = null; }
    _focus.cleanup();
    _tasks.cleanup();
    _contextMonitor.stop();
    if (hitWin && !hitWin.isDestroyed()) hitWin.destroy();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
