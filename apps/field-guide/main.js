const { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// One-time userData migration. Electron resolves `app.getPath("userData")`
// from `productName` (or, if unset, the package name). Every time we
// rename the app — `srwk-wall` → `srwk-visualizer` → `Shape Rotator` →
// `Shape Rotator Field Guide` — the userData path changes and a fresh
// launch finds no saved state. This walks the historical names and
// copies any prior contents into the current dir.
//
// We migrate files (not the directory itself) so any pre-existing
// new-path entries win, and we never *delete* the old paths — leaving
// them intact lets users roll back to an older build without losing data.
//
// To add a future rename: prepend the old name to `legacyNames` below.
function migrateLegacyUserData() {
  try {
    const newDir = app.getPath("userData");
    const parent = path.dirname(newDir);
    // Earlier names this app ever used for its userData folder, in
    // descending recency order. The first one that exists wins.
    const legacyNames = ["Shape Rotator", "srwk-visualizer", "srwk-wall"];
    let chosen = null;
    for (const n of legacyNames) {
      const candidate = path.join(parent, n);
      if (candidate === newDir) continue; // already running under that name
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        chosen = candidate; break;
      }
    }
    if (!chosen) return;
    fs.mkdirSync(newDir, { recursive: true });
    const copyTree = (src, dst) => {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copyTree(s, d);
        } else if (entry.isFile()) {
          if (fs.existsSync(d)) continue; // don't clobber newer state
          try { fs.copyFileSync(s, d); } catch {}
        }
      }
    };
    copyTree(chosen, newDir);
    process.stderr.write(`[viz:log] migrated userData from ${chosen} → ${newDir}\n`);
  } catch (e) {
    process.stderr.write(`[viz:warn] userData migration failed: ${e && e.message}\n`);
  }
}

migrateLegacyUserData();

const STATE_DIR = app.getPath("userData");
const WINDOW_STATE = path.join(STATE_DIR, "window_state.json");
const PREFS_FILE = path.join(STATE_DIR, "viz_prefs.json");
const LEGACY_PREFS_FILE = path.join(STATE_DIR, "wall_prefs.json");

// If a `wall_prefs.json` survived from before the rename (either from this
// install or copied over by migrateLegacyUserData()), promote it to the new
// `viz_prefs.json` filename. We rename rather than copy so the next save
// produces a single canonical file.
function migratePrefsFile() {
  try {
    if (!fs.existsSync(PREFS_FILE) && fs.existsSync(LEGACY_PREFS_FILE)) {
      fs.renameSync(LEGACY_PREFS_FILE, PREFS_FILE);
      process.stderr.write(`[viz:log] migrated prefs ${LEGACY_PREFS_FILE} → ${PREFS_FILE}\n`);
    }
  } catch (e) {
    process.stderr.write(`[viz:warn] prefs migration failed: ${e && e.message}\n`);
  }
}

migratePrefsFile();

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }
function writeJSON(p, d) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, p);
}

function createWindow() {
  const ws = readJSON(WINDOW_STATE, { width: 1600, height: 1000 });
  // Bounds-validate the saved x/y against currently-attached displays —
  // if the user disconnected a secondary monitor between launches, the
  // saved position lands the window invisibly off-screen and the app
  // looks frozen. Drop the saved position when no display contains it;
  // Electron will then center on the active display.
  if (typeof ws.x === "number" && typeof ws.y === "number") {
    try {
      const probe = { x: ws.x + 50, y: ws.y + 50 };
      const onScreen = screen.getAllDisplays().some(d => {
        const b = d.bounds;
        return probe.x >= b.x && probe.x < b.x + b.width
            && probe.y >= b.y && probe.y < b.y + b.height;
      });
      if (!onScreen) {
        process.stderr.write(`[viz:log] saved window position (${ws.x},${ws.y}) is off-screen — centering on active display\n`);
        delete ws.x; delete ws.y;
      }
    } catch {}
  }
  const win = new BrowserWindow({
    width: ws.width, height: ws.height, x: ws.x, y: ws.y,
    minWidth: 960, minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#03020c",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  if (ws.fullscreen) win.setFullScreen(true);
  if (process.env.SRWK_ALWAYS_ON_TOP === "1") win.setAlwaysOnTop(true);
  win.loadFile(path.join(__dirname, "src", "index.html"));
  if (process.env.SRWK_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });

  let t = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    clearTimeout(t);
    t = setTimeout(() => {
      if (win.isDestroyed()) return;
      writeJSON(WINDOW_STATE, { ...win.getBounds(), fullscreen: win.isFullScreen() });
    }, 250);
  };
  // On close, cancel the pending debounce + write synchronously — otherwise
  // the 250ms timer fires after the window is destroyed and throws.
  win.on("resize", save);
  win.on("move", save);
  win.on("close", () => {
    clearTimeout(t);
    if (win.isDestroyed()) return;
    try { writeJSON(WINDOW_STATE, { ...win.getBounds(), fullscreen: win.isFullScreen() }); } catch {}
  });

  win.webContents.on("console-message", (_e, lvl, msg) => {
    process.stderr.write(`[viz:${["log","warn","error"][lvl]||"log"}] ${msg}\n`);
  });
  return win;
}

ipcMain.handle("prefs:load", async () => readJSON(PREFS_FILE, {}));
ipcMain.handle("prefs:save", async (_e, d) => { writeJSON(PREFS_FILE, d); return true; });
ipcMain.handle("env:get", async () => ({
  // Point at a local swf-node --full. The aggregator routes (/graph,
  // /events, /admin/*) live on the same port as the peer-server;
  // 7777 is the swf-node default. Override with SWF_NODE_URL or the
  // legacy SRWK_SERVER for back-compat.
  serverUrl: process.env.SWF_NODE_URL
    || process.env.SRWK_SERVER
    || "http://127.0.0.1:7777",
  mode: process.env.SRWK_ROLE === "bench" ? "bench" : "visualizer",
}));
ipcMain.handle("shell:openExternal", async (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ─── electron-updater (release-driven app binary updates) ────────────
// Reads the `latest-{mac,win,linux}.yml` feed published by
// .github/workflows/field-guide-release.yml on each tag push. No-op in
// dev — `npm run dev` users still update via git pull / npm install.
function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;          // wait for explicit user click
    autoUpdater.autoInstallOnAppQuit = true;   // apply on next quit if downloaded
    autoUpdater.on("error", (err) => process.stderr.write(`[viz:warn] updater error: ${err && err.message}\n`));
    autoUpdater.on("update-available", (info) => process.stderr.write(`[viz:log] update available: ${info && info.version}\n`));
    autoUpdater.on("update-not-available", () => process.stderr.write(`[viz:log] no update available\n`));
    autoUpdater.on("download-progress", (p) => {
      process.stderr.write(`[viz:log] downloading update: ${Math.round(p.percent || 0)}%\n`);
      // Forward to the renderer so the inline update panel can render a
      // live % bar. The field-guide only ever has one window, so first-of
      // is fine; guard for "no window yet" (the updater can technically
      // fire before the renderer is created if a check is triggered early).
      try {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) win.webContents.send("fg:update-progress", {
          percent: p.percent || 0,
          bytesPerSecond: p.bytesPerSecond || 0,
          transferred: p.transferred || 0,
          total: p.total || 0,
        });
      } catch {}
    });
    autoUpdater.on("update-downloaded", (info) => process.stderr.write(`[viz:log] update downloaded: ${info && info.version}\n`));
    // Defer the first check ~30s so it doesn't race the boot-path fetch to swf-node on 127.0.0.1:7777.
    // Then re-check every 6h so long-running sessions still notice new releases.
    setTimeout(() => {
      try { autoUpdater.checkForUpdates().catch((err) => process.stderr.write(`[viz:warn] updater check failed: ${err && err.message}\n`)); }
      catch (e) { process.stderr.write(`[viz:warn] updater check threw: ${e.message}\n`); }
      setInterval(() => {
        try { autoUpdater.checkForUpdates().catch((err) => process.stderr.write(`[viz:warn] updater check failed: ${err && err.message}\n`)); }
        catch (e) { process.stderr.write(`[viz:warn] updater check threw: ${e.message}\n`); }
      }, 6 * 60 * 60 * 1000);
    }, 30 * 1000);
  } catch (e) {
    process.stderr.write(`[viz:warn] electron-updater init failed: ${e.message}\n`);
  }
}

ipcMain.handle("fg:check-update", async () => {
  if (!app.isPackaged) {
    return { ok: false, reason: "dev_mode", current: app.getVersion(), detail: "auto-update is disabled in dev (npm run dev). git pull && npm install instead." };
  }
  try {
    const { autoUpdater } = require("electron-updater");
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version || null;
    const available = !!latest && latest !== app.getVersion();
    return { ok: true, current: app.getVersion(), latest, available };
  } catch (e) {
    return { ok: false, reason: "check_failed", detail: e.message, current: app.getVersion() };
  }
});

ipcMain.handle("fg:apply-update", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev_mode" };
  try {
    const { autoUpdater } = require("electron-updater");
    await autoUpdater.downloadUpdate();
    return { ok: true, detail: "downloaded · will install on next quit (or click 'install + restart' to apply now)" };
  } catch (e) {
    return { ok: false, reason: "download_failed", detail: e.message };
  }
});

ipcMain.handle("fg:apply-update-and-restart", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev_mode" };
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "install_failed", detail: e.message };
  }
});

ipcMain.handle("fg:get-app-info", () => ({
  version: app.getVersion(),
  isPackaged: app.isPackaged,
}));

// ─── calendar export — PNG / PDF ────────────────────────────────────
// Renderer hands us a base64 data URL (the canvas snapshot). We pop a
// native save dialog so the user can pick where the file lands. PNG
// is recommended for messaging — renders inline in iMessage, Slack,
// Discord. PDF route uses Electron's offscreen window + printToPDF
// with a sized HTML wrapper around the same image.
function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || "").match(/^data:.+;base64,(.+)$/);
  if (!m) throw new Error("invalid data url");
  return Buffer.from(m[1], "base64");
}
ipcMain.handle("fg:export-calendar", async (_e, opts = {}) => {
  const format = opts.format === "pdf" ? "pdf" : "png";
  const stamp = new Date().toISOString().slice(0, 10);
  // Caller can pass `filename` to override the default; used by the
  // dossier export so the file doesn't land as "cohort-calendar".
  const baseName = (typeof opts.filename === "string" && opts.filename.trim())
    ? opts.filename.trim()
    : `cohort-calendar-${stamp}`;
  const defaultName = `${baseName}.${format}`;
  try {
    const win = BrowserWindow.getFocusedWindow();
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: format === "pdf" ? "Export cohort calendar (PDF)" : "Export cohort calendar (PNG)",
      defaultPath: path.join(app.getPath("desktop"), defaultName),
      filters: format === "pdf"
        ? [{ name: "PDF", extensions: ["pdf"] }]
        : [{ name: "PNG image", extensions: ["png"] }],
    });
    if (canceled || !filePath) return { ok: false, reason: "cancelled" };

    if (format === "png") {
      const buf = dataUrlToBuffer(opts.dataUrl);
      fs.writeFileSync(filePath, buf);
      return { ok: true, path: filePath };
    }

    // PDF path: open an offscreen BrowserWindow at the canvas's pixel
    // size, render the image, ask the chromium engine for a PDF, save.
    const w = Math.max(800, Math.round(opts.w || 1400));
    const h = Math.max(600, Math.round(opts.h || 1100));
    const pdfWin = new BrowserWindow({
      show: false,
      width: Math.min(w, 4000),
      height: Math.min(h, 4000),
      webPreferences: { offscreen: false, sandbox: false, contextIsolation: true },
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#0b0a08;}
      img{display:block;width:${w}px;height:${h}px;}
      @page{size:${w}px ${h}px;margin:0;}
    </style></head><body><img src="${opts.dataUrl}"></body></html>`;
    await pdfWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const pdfBuf = await pdfWin.webContents.printToPDF({
      pageSize: { width: w * 1000, height: h * 1000 },   // micrometers
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.writeFileSync(filePath, pdfBuf);
    pdfWin.destroy();
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, reason: "export_failed", detail: String(e && e.message || e) };
  }
});

app.whenReady().then(() => {
  // Dev-mode dock icon. Packaged builds get their icon from electron-builder
  // (build-resources/icon.icns); in `npm run field-guide` we'd otherwise see
  // the generic Electron dock icon. Set it explicitly here.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, "build-resources", "icon.png")); }
    catch (e) { process.stderr.write(`[viz:warn] dock icon set failed: ${e && e.message}\n`); }
  }
  createWindow();
  initAutoUpdater();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
