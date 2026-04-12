"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * 解析本机 claude CLI 路径：优先 CLAUDE_BIN，再常见安装位置，最后回退到 PATH 上的 "claude"。
 */
function resolveClaudeBin() {
  const home = os.homedir();
  const fromEnv = process.env.CLAUDE_BIN;
  if (fromEnv) {
    try {
      if (fs.existsSync(fromEnv)) return fromEnv;
    } catch { /* ignore */ }
    return fromEnv;
  }
  const candidates = [
    path.join(home, ".local/nodejs/bin/claude"),
    path.join(home, ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return "claude";
}

module.exports = resolveClaudeBin;
