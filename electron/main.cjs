// Standalone desktop shell for pm. Boots the existing Express server
// (server/index.mjs) as a child process on a private port and shows it in a
// dedicated Chromium window — no browser, own dock icon, cmd+Q.
//
// The server still reads the live workspace files under PM_ROOT
// (default ~/Projects for the packaged app), exactly as under `npm run dev`.
const { app, BrowserWindow, shell } = require("electron");
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
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
      await startServer();
      createWindow();
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
    if (server) server.kill();
  });
}
