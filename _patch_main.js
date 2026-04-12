// Patch script — run once with `node _patch_main.js` then delete
const fs = require("fs");
const path = require("path");
const f = path.join(__dirname, "src/main.js");
let c = fs.readFileSync(f, "utf8");
const res = {};

// ── P1: add sendToClaudeDesktop function before openChatWindow ──
const DESKTOP_FN = `
// ── Send text to Claude Desktop App via AppleScript ──
function sendToClaudeDesktop(text) {
  if (!isMac) {
    console.warn("Mr. Krabs: Claude Desktop send only supported on macOS");
    return;
  }
  const prevClipboard = clipboard.readText();
  clipboard.writeText(text);
  // Activate Claude Desktop, paste via Cmd+V, press Enter, then restore prior focus.
  // Claude Desktop (Electron) has a text input that accepts Cmd+V + Enter submission.
  const script = \`
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
end tell\`;
  execFile("osascript", ["-e", script], { timeout: 6000 }, (err) => {
    if (err) {
      console.warn("Mr. Krabs: send to Claude Desktop failed:", err.message);
      dialog.showMessageBox({
        type: "warning",
        title: "Claude Desktop not running",
        message: "Cannot send to Claude Desktop App.\\nPlease make sure Claude Desktop is open, or switch the send target to Claude Code via right-click menu.",
        buttons: ["OK"],
      }).catch(() => {});
    }
    setTimeout(() => clipboard.writeText(prevClipboard), 800);
  });
}

`;

const MARKER = "\nfunction openChatWindow() {";
if (!c.includes("function sendToClaudeDesktop(")) {
  if (c.includes(MARKER)) {
    c = c.replace(MARKER, DESKTOP_FN + MARKER);
    res.p1 = "OK - inserted sendToClaudeDesktop";
  } else {
    res.p1 = "FAIL - MARKER not found";
  }
} else {
  res.p1 = "SKIP - already exists";
}

// ── P2: expose claudeTarget in _menuCtx ──
const P2_OLD = "  get bubbleFollowPet() { return bubbleFollowPet; },\n  set bubbleFollowPet(v) { bubbleFollowPet = v; },\n  get pendingPermissions()";
const P2_NEW = "  get bubbleFollowPet() { return bubbleFollowPet; },\n  set bubbleFollowPet(v) { bubbleFollowPet = v; },\n  get claudeTarget() { return claudeTarget; },\n  set claudeTarget(v) { claudeTarget = v; },\n  get pendingPermissions()";
if (!c.includes("get claudeTarget()")) {
  if (c.includes(P2_OLD)) {
    c = c.replace(P2_OLD, P2_NEW);
    res.p2 = "OK - claudeTarget in _menuCtx";
  } else {
    res.p2 = "FAIL - P2_OLD not found";
  }
} else {
  res.p2 = "SKIP - already exists";
}

fs.writeFileSync(f, c);
console.log(JSON.stringify(res, null, 2));
