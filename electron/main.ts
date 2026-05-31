import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import { StateStore, type LightEvent, type AppState } from "./state";
import { DEFAULT_PORT, startServer } from "./server";
import { MemoStore, type Memo } from "./memos";
import { SystemStore, type SystemState } from "./system";
import { WinBridge, type MediaAction } from "./winbridge";

interface HotZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 520;
const CURSOR_POLL_MS = 60;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let cursorTimer: NodeJS.Timeout | null = null;
let currentlyIgnoring = true;
let hotZones: HotZone[] = [];
let lastHoverSent: boolean | null = null;

const store = new StateStore();
const systemStore = new SystemStore();
let memoStore: MemoStore | null = null;
let winBridge: WinBridge | null = null;

function getDevServerUrl(): string | undefined {
  return process.env.VITE_DEV_SERVER_URL;
}

// The branded icon, resolved for both layouts:
//   packaged → resources/app/icon.ico   (staged by scripts/stage.mjs)
//   dev      → <root>/installer/light.ico
function resolveIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "icon.ico"),
    path.join(__dirname, "..", "installer", "light.ico"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay();
  const { width: screenW } = display.workAreaSize;

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: Math.round((screenW - WINDOW_WIDTH) / 2),
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    icon: resolveIcon(),
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setIgnore(true);

  const devUrl = getDevServerUrl();
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.showInactive();
    startCursorPoll();
  });

  // Click outside the island/panel (focus moves to another app) → collapse panel.
  mainWindow.on("blur", () => {
    mainWindow?.webContents.send("light:blur");
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    stopCursorPoll();
  });
}

function setIgnore(ignore: boolean): void {
  if (!mainWindow) return;
  if (ignore === currentlyIgnoring) return;
  if (ignore) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
  currentlyIgnoring = ignore;
}

function startCursorPoll(): void {
  stopCursorPoll();
  cursorTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const localX = cursor.x - bounds.x;
    const localY = cursor.y - bounds.y;
    const overHotZone = hotZones.some(
      (z) => localX >= z.x && localX < z.x + z.w && localY >= z.y && localY < z.y + z.h,
    );
    setIgnore(!overHotZone);

    // Authoritative hover signal. DOM mouseenter/leave are unreliable while the
    // window is click-through (the OS stops delivering events once the cursor
    // leaves a hot zone, so the renderer's `mouseleave` may never fire and the
    // pill stays stuck "expanded"). The cursor poll always knows the truth, so
    // we drive hover from here and only emit on change.
    if (overHotZone !== lastHoverSent) {
      lastHoverSent = overHotZone;
      mainWindow.webContents.send("light:hover", overHotZone);
    }
  }, CURSOR_POLL_MS);
}

function stopCursorPoll(): void {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
  lastHoverSent = null;
}

function buildTrayIcon(): Electron.NativeImage {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAY0lEQVR42mNgGAWjYBQMfMD0n4Ghj+E/A+M/A+M/Iw" +
      "MTAxMDAyMDIwMjAyMDIwMzAxMjEwMTIxMDEwMzExMTM/+gM4ABAAYGRgYGBkYGRgZGBgZGBgYAAFLgC2sFqFQ0AAAAA" +
      "SUVORK5CYII=",
    "base64",
  );
  return nativeImage.createFromBuffer(png);
}

function createTray(): void {
  const iconPath = resolveIcon();
  const trayImg = iconPath ? nativeImage.createFromPath(iconPath) : buildTrayIcon();
  tray = new Tray(trayImg);
  tray.setToolTip("Light · 桌面状态胶囊");
  const refresh = () => {
    const menu = Menu.buildFromTemplate([
      {
        label: mainWindow?.isVisible() ? "Hide" : "Show",
        click: () => {
          if (!mainWindow) return;
          if (mainWindow.isVisible()) mainWindow.hide();
          else mainWindow.showInactive();
        },
      },
      { type: "separator" },
      { label: `HTTP :${DEFAULT_PORT}`, enabled: false },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray?.setContextMenu(menu);
  };
  refresh();
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.showInactive();
    refresh();
  });
}

function wireIpc(): void {
  ipcMain.handle("light:get-state", (): AppState => store.getState());
  ipcMain.handle("light:get-memos", (): Memo[] => memoStore?.list() ?? []);
  ipcMain.handle("light:get-system", (): SystemState => systemStore.getState());
  ipcMain.on("light:media-control", (_evt, action: MediaAction) => {
    winBridge?.control(action);
  });
  ipcMain.on("light:set-hot-zones", (_evt, zones: HotZone[]) => {
    if (!Array.isArray(zones)) return;
    hotZones = zones.filter(
      (z) =>
        z && typeof z.x === "number" && typeof z.y === "number" &&
        typeof z.w === "number" && typeof z.h === "number",
    );
  });
  ipcMain.on("light:add-memo", (_evt, text: string) => {
    if (typeof text !== "string") return;
    memoStore?.add(text);
  });
  ipcMain.on("light:toggle-memo", (_evt, id: string) => {
    if (typeof id !== "string") return;
    memoStore?.toggle(id);
  });
  ipcMain.on("light:delete-memo", (_evt, id: string) => {
    if (typeof id !== "string") return;
    memoStore?.delete(id);
  });
  ipcMain.on("light:clear-events", () => {
    store.clearEvents();
  });
  ipcMain.on("light:remove-session", (_evt, key: string) => {
    if (typeof key === "string") store.removeSession(key);
  });
  ipcMain.on("light:quit", () => app.quit());

  store.on("state", (state: AppState) => {
    mainWindow?.webContents.send("light:state", state);
  });
  store.on("event", (evt: LightEvent) => {
    mainWindow?.webContents.send("light:event", evt);
  });

  systemStore.on("change", (state: SystemState) => {
    mainWindow?.webContents.send("light:system", state);
  });
}

app.whenReady().then(() => {
  const memosPath = path.join(app.getPath("userData"), "memos.json");
  memoStore = new MemoStore(memosPath);
  memoStore.on("change", (list: Memo[]) => {
    mainWindow?.webContents.send("light:memos", list);
  });

  startServer(store, DEFAULT_PORT);
  createWindow();
  createTray();
  wireIpc();

  // Windows bridge: SMTC media + notification listener. Dev: <root>/bridge.
  const bridgeDir = path.join(__dirname, "..", "bridge");
  winBridge = new WinBridge(systemStore, bridgeDir);
  winBridge.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  winBridge?.stop();
});

app.on("window-all-closed", (e: Electron.Event) => {
  e.preventDefault();
});
