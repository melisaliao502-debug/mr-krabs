// src/updater.js — Auto-update system (electron-updater + GitHub API version check)
// Extracted from main.js L1877-2271

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");
const { app, dialog, shell, BrowserWindow } = require("electron");

const isMac = process.platform === "darwin";

module.exports = function initUpdater(ctx) {

let _autoUpdater = null;
function getAutoUpdater() {
  if (!_autoUpdater) {
    try {
      _autoUpdater = require("electron-updater").autoUpdater;
      _autoUpdater.autoDownload = false;
      _autoUpdater.autoInstallOnAppQuit = true;
      ctx.updateLog("Auto-updater initialized successfully");
    } catch (err) {
      const errMsg = `electron-updater load failed: ${err.message}`;
      console.warn("Mr. Krabs:", errMsg);
      ctx.updateLog(`ERROR: ${errMsg}`);
      ctx.updateLog(`Stack: ${err.stack}`);
      return null;
    }
  }
  return _autoUpdater;
}

let updateStatus = "idle"; // idle | checking | available | downloading | ready | error
let manualUpdateCheck = false;

function setupAutoUpdater() {
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) {
    ctx.updateLog("setupAutoUpdater: autoUpdater is null, skipping event setup");
    return;
  }
  ctx.updateLog("Setting up auto-updater event handlers");

  autoUpdater.on("update-available", (info) => {
    ctx.updateLog(`Update available: v${info.version} (current: v${app.getVersion()})`);
    const wasManual = manualUpdateCheck;
    manualUpdateCheck = false;
    // Silent check during DND/mini: skip dialog, stay idle so user can check later
    if (!wasManual && (ctx.doNotDisturb || ctx.miniMode)) {
      ctx.updateLog("Silent mode (DND/mini), skipping dialog");
      updateStatus = "idle";
      ctx.rebuildAllMenus();
      return;
    }
    updateStatus = "available";
    ctx.rebuildAllMenus();
    if (isMac) {
      // macOS: no code signing → can't auto-update, open GitHub Releases page instead
      ctx.updateLog("macOS detected: will open GitHub Releases page");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateAvailable"),
        message: ctx.t("updateAvailableMacMsg").replace("{version}", info.version),
        buttons: [ctx.t("download"), ctx.t("restartLater")],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          ctx.updateLog("User chose to download, opening GitHub Releases");
          shell.openExternal("https://github.com/melisaliao502-debug/mr-krabs/releases/latest");
        } else {
          ctx.updateLog("User chose to download later");
        }
        updateStatus = "idle";
        ctx.rebuildAllMenus();
      });
    } else {
      // Windows: auto-download
      ctx.updateLog("Windows detected: will offer auto-download");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateAvailable"),
        message: ctx.t("updateAvailableMsg").replace("{version}", info.version),
        buttons: [ctx.t("download"), ctx.t("restartLater")],
        defaultId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0) {
          ctx.updateLog("User chose to download, starting download");
          updateStatus = "downloading";
          ctx.rebuildAllMenus();
          autoUpdater.downloadUpdate();
        } else {
          ctx.updateLog("User chose to download later");
          updateStatus = "idle";
          ctx.rebuildAllMenus();
        }
      });
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    ctx.updateLog(`No update available: current v${app.getVersion()} is latest`);
    updateStatus = "idle";
    ctx.rebuildAllMenus();
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      ctx.updateLog("Showing 'up to date' dialog");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateNotAvailable"),
        message: ctx.t("updateNotAvailableMsg").replace("{version}", app.getVersion()),
        noLink: true,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    ctx.updateLog(`Update downloaded: v${info.version}`);
    updateStatus = "ready";
    ctx.rebuildAllMenus();
    dialog.showMessageBox({
      type: "info",
      title: ctx.t("updateReady"),
      message: ctx.t("updateReadyMsg").replace("{version}", info.version),
      buttons: [ctx.t("restartNow"), ctx.t("restartLater")],
      defaultId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        ctx.updateLog("User chose to restart now");
        autoUpdater.quitAndInstall(false, true);
      } else {
        ctx.updateLog("User chose to restart later");
      }
    });
  });

  autoUpdater.on("error", (err) => {
    ctx.updateLog(`ERROR: AutoUpdater error: ${err.message}`);
    ctx.updateLog(`Error code: ${err.code || 'none'}`);
    ctx.updateLog(`Error stack: ${err.stack}`);

    // Note: 404 errors during download might mean:
    // 1. Release files not uploaded yet (check GitHub first)
    // 2. Real network error
    // Since we now check GitHub API first, 404 here likely means
    // the release exists but files aren't ready
    // For auto-checks (not manual), just log silently
    if (!manualUpdateCheck) {
      ctx.updateLog("Auto-check error, not showing dialog");
      updateStatus = "error";
      ctx.rebuildAllMenus();
      return;
    }

    // For manual checks, show user-friendly error
    manualUpdateCheck = false;
    if (isUpdate404Error(err)) {
      // 404 after GitHub API check = release exists but files missing
      updateStatus = "idle";
      ctx.rebuildAllMenus();
      ctx.updateLog("404 error: release files not ready, showing 'up to date'");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateNotAvailable"),
        message: ctx.t("updateNotAvailableMsg").replace("{version}", app.getVersion()),
        noLink: true,
      });
    } else {
      // Real error: network, permissions, corrupted download, etc.
      updateStatus = "error";
      ctx.rebuildAllMenus();
      ctx.updateLog("Real error: showing error dialog");
      dialog.showMessageBox({
        type: "error",
        title: ctx.t("updateError"),
        message: ctx.t("updateErrorMsg"),
        noLink: true,
      });
    }
  });
}

// ── Version comparison utilities ──
// Compare two version strings (e.g., "0.5.0" vs "0.5.1")
// Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
function compareVersions(v1, v2) {
  const parts1 = v1.replace('v', '').split('.').map(Number);
  const parts2 = v2.replace('v', '').split('.').map(Number);
  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

// Fetch latest release version from GitHub API (10s timeout)
function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/melisaliao502-debug/mr-krabs/releases/latest',
      headers: {
        'User-Agent': 'Mr-Krabs'
      }
    };

    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            if (!release.tag_name) return reject(new Error('No tag_name in release'));
            resolve(release.tag_name);
          } catch (err) {
            reject(new Error(`Failed to parse GitHub response: ${err.message}`));
          }
        } else if (res.statusCode === 404) {
          reject(new Error('No releases found'));
        } else {
          reject(new Error(`GitHub API returned ${res.statusCode}`));
        }
      });
    }).on('error', reject);

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('GitHub API request timed out (10s)'));
    });
  });
}

function isUpdate404Error(err) {
  return err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
         err.message?.includes('404') ||
         err.message?.includes('Cannot find latest.yml');
}

async function checkForUpdates(manual = false) {
  try { return await _checkForUpdatesInner(manual); }
  catch (e) {
    ctx.updateLog(`ERROR: unhandled in checkForUpdates: ${e.message}`);
    updateStatus = "idle";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
  }
}

async function _checkForUpdatesInner(manual) {
  if (updateStatus === "checking" || updateStatus === "downloading") {
    ctx.updateLog(`Check skipped: already ${updateStatus}`);
    return;
  }

  const currentVersion = app.getVersion();
  ctx.updateLog(`Starting update check (manual: ${manual}, current version: v${currentVersion})`);
  manualUpdateCheck = manual;
  updateStatus = "checking";
  ctx.rebuildAllMenus();

  // Step 1: Check GitHub API for latest version
  ctx.updateLog("Fetching latest version from GitHub API...");
  let latestVersion;
  try {
    latestVersion = await fetchLatestVersion();
    ctx.updateLog(`Latest version on GitHub: ${latestVersion}`);
  } catch (err) {
    ctx.updateLog(`ERROR: Failed to fetch latest version: ${err.message}`);

    // Network error or GitHub API issue
    updateStatus = "error";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
    if (manual) {
      ctx.updateLog("Showing error dialog (GitHub API failed)");
      dialog.showMessageBox({
        type: "error",
        title: ctx.t("updateError"),
        message: ctx.t("updateErrorMsg"),
        noLink: true,
      });
    }
    return;
  }

  // Step 2: Compare versions
  const versionCompare = compareVersions(currentVersion, latestVersion);
  ctx.updateLog(`Version comparison: ${currentVersion} vs ${latestVersion} = ${versionCompare}`);

  if (versionCompare >= 0) {
    // Current version is up-to-date or newer
    ctx.updateLog("Current version is up-to-date or newer");
    updateStatus = "idle";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
    if (manual) {
      ctx.updateLog("Showing 'up to date' dialog");
      dialog.showMessageBox({
        type: "info",
        title: ctx.t("updateNotAvailable"),
        message: ctx.t("updateNotAvailableMsg").replace("{version}", currentVersion),
        noLink: true,
      });
    }
    return;
  }

  // Step 3: Newer version available
  ctx.updateLog(`Newer version available: ${latestVersion}`);

  if (isMac) {
    // macOS: unsigned app — download DMG, mount, replace .app, relaunch
    ctx.updateLog(`macOS: auto-update flow for ${latestVersion}`);
    updateStatus = "available";
    ctx.rebuildAllMenus();

    const { response } = await dialog.showMessageBox({
      type: "info",
      title: ctx.t("updateAvailable"),
      message: ctx.t("updateAvailableMacMsg").replace("{version}", latestVersion),
      buttons: [ctx.t("autoUpdate") || "自动更新", ctx.t("restartLater") || "稍后"],
      defaultId: 0,
      noLink: true,
    });

    if (response !== 0) {
      ctx.updateLog("User deferred update");
      updateStatus = "idle";
      manualUpdateCheck = false;
      ctx.rebuildAllMenus();
      return;
    }

    // Start auto-update
    ctx.updateLog("User accepted auto-update, starting download…");
    updateStatus = "downloading";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();

    try {
      await _macAutoUpdate(latestVersion);
    } catch (err) {
      ctx.updateLog(`ERROR: macOS auto-update failed: ${err.message}`);
      // Fallback: open browser
      ctx.updateLog("Falling back to browser download");
      updateStatus = "idle";
      ctx.rebuildAllMenus();
      const { response: fb } = await dialog.showMessageBox({
        type: "error",
        title: ctx.t("updateError") || "更新失败",
        message: `自动安装失败，已为你打开下载页面。

错误：${err.message}`,
        buttons: ["打开下载页面", "取消"],
        defaultId: 0,
        noLink: true,
      });
      if (fb === 0) shell.openExternal("https://github.com/melisaliao502-debug/mr-krabs/releases/latest");
    }
    return;
  }

  // Windows: use electron-updater for auto-download
  ctx.updateLog("Windows: proceeding with electron-updater");
  const au = getAutoUpdater();
  if (!au) {
    ctx.updateLog("ERROR: AutoUpdater not available");
    updateStatus = "error";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
    if (manual) {
      dialog.showMessageBox({
        type: "error",
        title: ctx.t("updateError"),
        message: ctx.t("updateErrorMsg"),
        noLink: true,
      });
    }
    return;
  }
  au.checkForUpdates().then((result) => {
    if (!result) {
      ctx.updateLog("Update check returned null (likely dev mode)");
      updateStatus = "idle";
      manualUpdateCheck = false;
      ctx.rebuildAllMenus();
    }
  }).catch((err) => {
    ctx.updateLog(`ERROR: checkForUpdates promise rejected: ${err.message}`);
    updateStatus = "error";
    manualUpdateCheck = false;
    ctx.rebuildAllMenus();
    if (manual) {
      dialog.showMessageBox({
        type: "error",
        title: ctx.t("updateError"),
        message: ctx.t("updateErrorMsg"),
        noLink: true,
      });
    }
  });
}

// ── macOS auto-update: download DMG → mount → replace app → relaunch ──
async function _macAutoUpdate(latestVersion) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const tag = latestVersion.startsWith("v") ? latestVersion : `v${latestVersion}`;
  // Filename must match what electron-builder generates (spaces replaced with dots by GitHub)
  const rawName = arch === "arm64"
    ? `Mr. Krabs-${tag.slice(1)}-arm64.dmg`
    : `Mr. Krabs-${tag.slice(1)}.dmg`;
  const ghName = rawName.replace(/ /g, ".");   // GitHub asset URL uses dots
  const downloadUrl = `https://github.com/melisaliao502-debug/mr-krabs/releases/download/${tag}/${ghName}`;
  const tmpDmg = path.join(os.tmpdir(), ghName);

  ctx.updateLog(`Downloading ${downloadUrl} → ${tmpDmg}`);

  // ── Step 1: Download DMG with progress ──
  await new Promise((resolve, reject) => {
    function doGet(url, redirectCount = 0) {
      if (redirectCount > 5) return reject(new Error("Too many redirects"));
      const u = new URL(url);
      const opts = { hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": "Mr-Krabs-Updater" } };
      const req = https.get(opts, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          ctx.updateLog(`Redirect → ${res.headers.location}`);
          return doGet(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));

        const total = parseInt(res.headers["content-length"] || "0", 10);
        let downloaded = 0;
        let lastPct = -1;
        const out = fs.createWriteStream(tmpDmg);
        res.on("data", chunk => {
          downloaded += chunk.length;
          out.write(chunk);
          if (total > 0) {
            const pct = Math.floor(downloaded / total * 100);
            if (pct !== lastPct && pct % 10 === 0) {
              lastPct = pct;
              ctx.updateLog(`Download progress: ${pct}% (${(downloaded/1024/1024).toFixed(1)} MB)`);
              // Update menu label to show progress
              ctx._updateDownloadPct = pct;
              ctx.rebuildAllMenus();
            }
          }
        });
        res.on("end", () => { out.end(); resolve(); });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(120000, () => { req.destroy(); reject(new Error("Download timed out")); });
    }
    doGet(downloadUrl);
  });

  ctx.updateLog(`Download complete: ${tmpDmg} (${(fs.statSync(tmpDmg).size/1024/1024).toFixed(1)} MB)`);
  ctx._updateDownloadPct = null;

  // ── Step 2: Mount DMG ──
  ctx.updateLog("Mounting DMG…");
  const mountOutput = execSync(`hdiutil attach "${tmpDmg}" -nobrowse -noverify -noautoopen 2>&1`).toString();
  ctx.updateLog(`Mount output: ${mountOutput.trim()}`);

  // Find mount point — look for /Volumes line
  const mountMatch = mountOutput.match(/\/Volumes\/[^\r\n]+/);
  if (!mountMatch) throw new Error("Could not find mount point in hdiutil output");
  const mountPoint = mountMatch[0].trim();
  ctx.updateLog(`Mounted at: ${mountPoint}`);

  // ── Step 3: Write updater shell script ──
  // The script runs after the app quits: copies .app, removes quarantine, relaunches
  const appPath = app.getPath("exe").split(".app")[0] + ".app";
  const scriptPath = path.join(os.tmpdir(), "mr-krabs-update.sh");
  const scriptContent = [
    "#!/bin/bash",
    "sleep 2",
    `ditto "${mountPoint}/Mr. Krabs.app" "${appPath}"`,
    `xattr -rd com.apple.quarantine "${appPath}" 2>/dev/null || true`,
    `hdiutil detach "${mountPoint}" -quiet 2>/dev/null || true`,
    `rm -f "${tmpDmg}"`,
    `open "${appPath}"`,
    `rm -f "${scriptPath}"`,
  ].join("\n");
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  ctx.updateLog(`Update script written to ${scriptPath}`);

  // ── Step 4: Show "ready to install" dialog ──
  updateStatus = "ready";
  ctx.rebuildAllMenus();

  const { response: installNow } = await dialog.showMessageBox({
    type: "info",
    title: ctx.t("updateReady") || "更新就绪",
    message: ctx.t("updateReadyMsg")?.replace("{version}", tag) || `v${tag} 已下载完成，点击「立即重启」完成更新。`,
    buttons: [ctx.t("restartNow") || "立即重启", ctx.t("restartLater") || "稍后"],
    defaultId: 0,
    noLink: true,
  });

  if (installNow === 0) {
    ctx.updateLog("Launching update script and quitting…");
    spawn("bash", [scriptPath], { detached: true, stdio: "ignore" }).unref();
    app.quit();
  } else {
    ctx.updateLog("User chose to install later — script left at " + scriptPath);
    // Leave status as "ready" so menu shows "Update Ready"
  }
}

function getUpdateMenuItem() {
  return {
    label: getUpdateMenuLabel(),
    enabled: updateStatus !== "checking" && updateStatus !== "downloading" && updateStatus !== "available",
    click: () => checkForUpdates(true),
  };
}

function getUpdateMenuLabel() {
  switch (updateStatus) {
    case "checking":    return ctx.t("checkingForUpdates");
    case "available":   return ctx.t("updateAvailableShort") || ctx.t("checkForUpdates");
    case "downloading": {
      const pct = ctx._updateDownloadPct;
      const base = ctx.t("updateDownloading");
      return pct != null ? `${base} ${pct}%` : base;
    }
    case "ready":       return ctx.t("updateReady");
    default:            return ctx.t("checkForUpdates");
  }
}

return { setupAutoUpdater, checkForUpdates, getUpdateMenuItem, getUpdateMenuLabel };

};
