#!/usr/bin/env node
// Mr. Krabs Desktop Pet — Auto-Start Script
// Registered as a SessionStart hook BEFORE mr-krabs-hook.js.
// Checks if the Electron app is running; if not, launches it detached.
// Uses shared server discovery helpers and should exit quickly in normal cases.

const { spawn } = require("child_process");
const path = require("path");
const { discoverMrKrabsPort } = require("./server-config");

const TIMEOUT_MS = 300;

discoverMrKrabsPort({ timeoutMs: TIMEOUT_MS }, (port) => {
  if (port) {
    process.exit(0);
    return;
  }
  launchApp();
  process.exit(0);
});

function launchApp() {
  const isPackaged = __dirname.includes("app.asar");
  const isWin = process.platform === "win32";

  try {
    if (isPackaged) {
      if (isWin) {
        // __dirname: <install>/resources/app.asar.unpacked/hooks
        // exe:       <install>/Mr. Krabs.exe
        const installDir = path.resolve(__dirname, "..", "..", "..");
        const exe = path.join(installDir, "Mr. Krabs.exe");
        spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
      } else {
        // __dirname: <name>.app/Contents/Resources/app.asar.unpacked/hooks
        // .app bundle: 4 levels up
        const appBundle = path.resolve(__dirname, "..", "..", "..", "..");
        spawn("open", ["-a", appBundle], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }
    } else {
      // Source / development mode
      const projectDir = path.resolve(__dirname, "..");
      const npm = isWin ? "npm.cmd" : "npm";
      spawn(npm, ["start"], {
        cwd: projectDir,
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } catch (err) {
    process.stderr.write(`mr-krabs auto-start: ${err.message}\n`);
  }
}
