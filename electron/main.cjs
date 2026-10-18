// Standalone desktop shell for pm. Boots the existing Express server
// (server/index.mjs) as a child process on a private port and shows it in a
// dedicated Chromium window — no browser, own dock icon, cmd+Q.
//
// The server still reads the live workspace files under PM_ROOT
// (default ~/Projects for the packaged app), exactly as under `npm run dev`.
const { app, BrowserWindow, ipcMain, Menu, globalShortcut, screen, shell } = require("electron");
const { fork } = require("node:child_process");

// If the shell that launched us had ELECTRON_RUN_AS_NODE set, Electron booted as
// plain Node and `app` is the CLI path string, not the API. Fail loudly instead
// of a cryptic "cannot read requestSingleInstanceLock of undefined".
if (!app || typeof app.whenReady !== "function") {
  console.error("Run this with Electron, and without ELECTRON_RUN_AS_NODE set. Use `npm run app`.");
  process.exit(1);
}
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const { HOVER_MIN, sanitizePrefs, hoverBounds } = require("./hover.cjs");

const HOVER_KEY = "CommandOrControl+Alt+P";
let prefs = { hover: false, hoverBounds: null };
let normalBounds = null;
let prefsFile = "";

function loadPrefs() {
  prefsFile = path.join(app.getPath("userData"), "shell-prefs.json");
  try {
    prefs = sanitizePrefs(JSON.parse(fs.readFileSync(prefsFile, "utf8")));
  } catch {
    prefs = sanitizePrefs(null);
  }
}

function savePrefs() {
  try {
    fs.writeFileSync(prefsFile, JSON.stringify(prefs));
  } catch (e) {
    console.error("could not save shell prefs:", e.message);
  }
}

// Hover mode: a compact always-on-top copy of the same window that follows you
// across spaces and over fullscreen apps. Normal size is restored on exit.
function applyHover(on) {
  if (!win) return;
  if (on) {
    normalBounds = win.getBounds();
    win.setMinimumSize(HOVER_MIN.width, HOVER_MIN.height);
    win.setBounds(hoverBounds(prefs.hoverBounds, screen.getAllDisplays().map((d) => d.workArea)));
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    if (win.isAlwaysOnTop()) prefs.hoverBounds = win.getBounds();
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
    win.setMinimumSize(720, 480);
    if (normalBounds) win.setBounds(normalBounds);
  }
  prefs.hover = on;
  savePrefs();
}

function toggleHover() {
  if (!win) return;
  applyHover(!prefs.hover);
  buildMenu();
  win.webContents.send("hover:changed", prefs.hover);
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else {
    win.show();
    win.focus();
  }
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Hover mode", type: "checkbox", checked: prefs.hover, accelerator: "CommandOrControl+Shift+H", click: toggleHover },
          { label: "Show / hide PM", accelerator: HOVER_KEY, registerAccelerator: false, click: toggleVisible },
          { type: "separator" },
          { role: "reload" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

const ROOT = path.join(__dirname, "..");
let server = null;
let win = null;
let serverPort = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, tries = 100) {
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (--tries <= 0) return reject(new Error("pm server did not come up"));
      setTimeout(hit, 150);
    };
    const hit = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: 1000 },
        (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    hit();
  });
}

async function startServer() {
  serverPort = process.env.PM_PORT ? Number(process.env.PM_PORT) : await freePort();
  // In the packaged app ROOT is inside app.asar, which is not a real directory —
  // fork() would fail ENOENT. The server reads paths from PM_ROOT, not cwd, so
  // any real directory is fine here.
  const childCwd = app.isPackaged ? process.resourcesPath : ROOT;
  // The server defaults PM_ROOT to its cwd, which here is not the workspace —
  // pass it explicitly so the packaged app reads the user's ~/Projects.
  const pmRoot = process.env.PM_ROOT || path.join(app.getPath("home"), "Projects");
  server = fork(path.join(ROOT, "server", "index.mjs"), [], {
    cwd: childCwd,
    env: { ...process.env, PM_ROOT: pmRoot, PORT: String(serverPort), ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  server.on("exit", (code) => {
    server = null;
    if (!app.isQuitting) {
      console.error("pm server exited early:", code);
      app.quit();
    }
  });
  await waitForHealth(serverPort);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: "PM",
    backgroundColor: "#0b0b0c",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  win.loadURL(`http://127.0.0.1:${serverPort}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${serverPort}`)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    win = null;
  });
  let saveTimer = null;
  const rememberSpot = () => {
    if (!prefs.hover || !win) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win && prefs.hover) {
        prefs.hoverBounds = win.getBounds();
        savePrefs();
      }
    }, 400);
  };
  win.on("moved", rememberSpot);
  win.on("resized", rememberSpot);
  if (prefs.hover) win.once("ready-to-show", () => applyHover(true));
  win.once("ready-to-show", () => win && win.show());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      loadPrefs();
      ipcMain.handle("hover:get", () => prefs.hover);
      ipcMain.handle("hover:toggle", () => {
        toggleHover();
        return prefs.hover;
      });
      buildMenu();
      await startServer();
      createWindow();
      globalShortcut.register(HOVER_KEY, toggleVisible);
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    } catch (e) {
      console.error(e);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    globalShortcut.unregisterAll();
    if (server) server.kill();
  });
}
