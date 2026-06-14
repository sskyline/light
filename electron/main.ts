import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, powerMonitor } from "electron";
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

interface WindowPosition {
  x: number;
  y: number;
}

interface WindowDrag {
  startCursor: Electron.Point;
  startWindow: WindowPosition;
  lastX: number;
  lastY: number;
  timer: NodeJS.Timeout;
}

const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 520;
const ISLAND_SAFE_WIDTH = 420;
const ISLAND_SAFE_HEIGHT = 72;
const CURSOR_POLL_MS = 60;
const WINDOW_DRAG_POLL_MS = 16;
const POSITION_SAVE_DEBOUNCE_MS = 250;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let cursorTimer: NodeJS.Timeout | null = null;
let positionSaveTimer: NodeJS.Timeout | null = null;
let displayCorrectionTimer: NodeJS.Timeout | null = null;
let windowDrag: WindowDrag | null = null;
let currentlyIgnoring: boolean | null = null;
let hotZones: HotZone[] = [];
let lastHoverSent: boolean | null = null;

const store = new StateStore();
const systemStore = new SystemStore();
let memoStore: MemoStore | null = null;
let winBridge: WinBridge | null = null;

function getDevServerUrl(): string | undefined {
  return process.env.VITE_DEV_SERVER_URL;
}

function isWindowPosition(value: unknown): value is WindowPosition {
  if (!value || typeof value !== "object") return false;
  const pos = value as Partial<WindowPosition>;
  return Number.isFinite(pos.x) && Number.isFinite(pos.y);
}

function windowPositionPath(): string {
  return path.join(app.getPath("userData"), "window-position.json");
}

function readWindowPosition(): WindowPosition | null {
  try {
    const raw = fs.readFileSync(windowPositionPath(), "utf8");
    const parsed = JSON.parse(raw);
    return isWindowPosition(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function islandSafeRect(pos: WindowPosition): Electron.Rectangle {
  return {
    x: pos.x + Math.round((WINDOW_WIDTH - ISLAND_SAFE_WIDTH) / 2),
    y: pos.y,
    width: ISLAND_SAFE_WIDTH,
    height: ISLAND_SAFE_HEIGHT,
  };
}

function containsRect(outer: Electron.Rectangle, inner: Electron.Rectangle): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function clamp(n: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(n, min), max);
}

function islandCenterPoint(pos: WindowPosition): Electron.Point {
  const safe = islandSafeRect(pos);
  return {
    x: safe.x + Math.round(safe.width / 2),
    y: safe.y + Math.round(safe.height / 2),
  };
}

function displayForWindowPosition(pos: WindowPosition): Electron.Display {
  return screen.getDisplayNearestPoint(islandCenterPoint(pos));
}

function displayById(id: number | null): Electron.Display | null {
  if (id == null) return null;
  return screen.getAllDisplays().find((display) => display.id === id) ?? null;
}

function clampPositionToDisplay(pos: WindowPosition, display: Electron.Display): WindowPosition {
  const area = display.workArea;
  return {
    x: clamp(pos.x, area.x, area.x + area.width - WINDOW_WIDTH),
    y: clamp(pos.y, area.y, area.y + area.height - ISLAND_SAFE_HEIGHT),
  };
}

function isWindowPositionValidOnDisplay(pos: WindowPosition, display: Electron.Display): boolean {
  const area = display.workArea;
  return (
    pos.x >= area.x &&
    pos.x + WINDOW_WIDTH <= area.x + area.width &&
    containsRect(area, islandSafeRect(pos))
  );
}

function isWindowPositionValid(pos: WindowPosition): boolean {
  return screen.getAllDisplays().some((display) => isWindowPositionValidOnDisplay(pos, display));
}

function centeredPosition(display: Electron.Display): WindowPosition {
  const area = display.workArea;
  return {
    x: area.x + Math.round((area.width - WINDOW_WIDTH) / 2),
    y: area.y,
  };
}

function initialWindowPosition(display: Electron.Display): WindowPosition {
  const saved = readWindowPosition();
  if (saved) {
    if (isWindowPositionValid(saved)) return saved;
    return clampPositionToDisplay(saved, displayForWindowPosition(saved));
  }
  return centeredPosition(display);
}

function correctWindowPositionForDisplays(): void {
  if (!mainWindow || mainWindow.isDestroyed() || windowDrag) return;
  const [x, y] = mainWindow.getPosition();
  const pos = { x, y };
  const display = displayById(currentDisplayId) ?? displayForWindowPosition(pos);
  const next = isWindowPositionValidOnDisplay(pos, display)
    ? pos
    : clampPositionToDisplay(pos, display);

  currentDisplayId = display.id;
  if (next.x === x && next.y === y) return;
  mainWindow.setPosition(next.x, next.y);
  scheduleWindowPositionSave();
}

function scheduleDisplayCorrection(delayMs = 300): void {
  if (displayCorrectionTimer) clearTimeout(displayCorrectionTimer);
  displayCorrectionTimer = setTimeout(() => {
    displayCorrectionTimer = null;
    correctWindowPositionForDisplays();
  }, delayMs);
}

function saveWindowPositionNow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  try {
    const file = windowPositionPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ x, y }, null, 2), "utf8");
  } catch (err) {
    console.error("[window] save position failed:", err);
  }
}

function scheduleWindowPositionSave(): void {
  if (positionSaveTimer) clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(() => {
    positionSaveTimer = null;
    saveWindowPositionNow();
  }, POSITION_SAVE_DEBOUNCE_MS);
}

function updateWindowDrag(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !windowDrag) return;
  const cursor = screen.getCursorScreenPoint();
  const nextX = Math.round(windowDrag.startWindow.x + cursor.x - windowDrag.startCursor.x);
  const nextY = Math.round(windowDrag.startWindow.y + cursor.y - windowDrag.startCursor.y);
  if (nextX === windowDrag.lastX && nextY === windowDrag.lastY) return;
  windowDrag.lastX = nextX;
  windowDrag.lastY = nextY;
  mainWindow.setPosition(nextX, nextY);
}

function startWindowDrag(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopWindowDrag(false);
  const cursor = screen.getCursorScreenPoint();
  const [x, y] = mainWindow.getPosition();
  windowDrag = {
    startCursor: cursor,
    startWindow: { x, y },
    lastX: x,
    lastY: y,
    timer: setInterval(updateWindowDrag, WINDOW_DRAG_POLL_MS),
  };
  setIgnore(false);
  updateWindowDrag();
}

function stopWindowDrag(savePosition = true): void {
  if (!windowDrag) return;
  clearInterval(windowDrag.timer);
  windowDrag = null;
  if (savePosition) scheduleWindowPositionSave();
}

// The branded icon, resolved for both layouts:
//   packaged → resources/app/icon.ico   (staged by scripts/stage.mjs)
//   dev      → <root>/installer/light.ico
function resolveIcon(): string | undefined {
  const isMac = process.platform === "darwin";
  const resourcesDir = process.resourcesPath;
  const candidates = isMac
    ? [
        path.join(resourcesDir, "installer", "tray-icon-macTemplate@4x.png"),
        path.join(resourcesDir, "installer", "tray-icon-macTemplate@2x.png"),
        path.join(resourcesDir, "installer", "tray-icon-macTemplate.png"),
        path.join(__dirname, "..", "installer", "tray-icon-macTemplate@4x.png"),
        path.join(__dirname, "..", "installer", "tray-icon-macTemplate@2x.png"),
        path.join(__dirname, "..", "installer", "tray-icon-macTemplate.png"),
        path.join(__dirname, "..", "icon.ico"),
        path.join(__dirname, "..", "installer", "light.ico"),
      ]
    : [
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

let currentDisplayId: number | null = null;

function moveToDisplay(display: Electron.Display): void {
  if (!mainWindow) return;
  currentDisplayId = display.id;
  const pos = centeredPosition(display);
  mainWindow.setPosition(pos.x, pos.y);
  scheduleWindowPositionSave();
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay();
  const pos = initialWindowPosition(display);
  currentDisplayId = displayForWindowPosition(pos).id;

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: pos.x,
    y: pos.y,
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

  hotZones = [];
  currentlyIgnoring = null;
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
    scheduleDisplayCorrection();
    startCursorPoll();
  });

  // Click outside the island/panel (focus moves to another app) → collapse panel.
  mainWindow.on("blur", () => {
    mainWindow?.webContents.send("light:blur");
  });

  mainWindow.on("closed", () => {
    stopWindowDrag(false);
    mainWindow = null;
    stopCursorPoll();
  });
  mainWindow.on("move", () => {
    if (!windowDrag) scheduleWindowPositionSave();
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
    if (windowDrag) {
      setIgnore(false);
      if (lastHoverSent !== true) {
        lastHoverSent = true;
        mainWindow.webContents.send("light:hover", true);
      }
      return;
    }
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
  // macOS-friendly 22×22 RGBA PNG (white circle on transparent)
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAmElEQVR4nO2UywnAIAyGe3Uuz55dx028O0pXcYg00ggihvqIpYf+8CP4+Igx5jh+9QgAFNqgHdqjA42O5tUMVBMkQluR1vUI1KJPBlgr7bO9kfZCSzgfOeXUD0Kz0rl2zuF+EC6nT0rnDAd2k9Asx4H9Ithz4LAIDq9HvC3H26piTx0TXP7nFXD5XlFFnq4n190KuHw//qwuL2q89iPzIToAAAAASUVORK5CYII=",
    "base64",
  );
  return nativeImage.createFromBuffer(png);
}

function createTray(): void {
  const iconPath = resolveIcon();
  const trayImg = iconPath ? nativeImage.createFromPath(iconPath) : buildTrayIcon();
  if (process.platform === "darwin") trayImg.setTemplateImage(true);
  tray = new Tray(trayImg);
  tray.setToolTip("Light · 桌面状态胶囊");
  const refresh = () => {
    const displays = screen.getAllDisplays();
    const displayItems: Electron.MenuItemConstructorOptions[] = displays.map((d, i) => {
      const isCurrent = d.id === currentDisplayId;
      const label = d.id === screen.getPrimaryDisplay().id
        ? `Built-in Display`
        : `Display ${i + 1} (${d.size.width}×${d.size.height})`;
      return {
        label: isCurrent ? `● ${label}` : `  ${label}`,
        click: () => { moveToDisplay(d); refresh(); },
      };
    });

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
      ...displayItems,
      { type: "separator" },
      { label: `HTTP :${DEFAULT_PORT}`, enabled: false },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray?.setContextMenu(menu);
  };
  refresh();
  tray.on("click", () => { refresh(); tray?.popUpContextMenu(); });
}

function wireIpc(): void {
  ipcMain.handle("light:get-state", (): AppState => store.getState());
  ipcMain.handle("light:get-memos", (): Memo[] => memoStore?.list() ?? []);
  ipcMain.handle("light:get-system", (): SystemState => systemStore.getState());
  ipcMain.on("light:media-control", (_evt, action: MediaAction) => {
    winBridge?.control(action);
  });
  ipcMain.on("light:start-window-drag", () => startWindowDrag());
  ipcMain.on("light:end-window-drag", () => stopWindowDrag());
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

  screen.on("display-added", () => scheduleDisplayCorrection(600));
  screen.on("display-removed", () => scheduleDisplayCorrection(600));
  screen.on("display-metrics-changed", () => scheduleDisplayCorrection(600));
  powerMonitor.on("resume", () => scheduleDisplayCorrection(900));
  powerMonitor.on("unlock-screen", () => scheduleDisplayCorrection(900));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  stopWindowDrag(false);
  if (displayCorrectionTimer) {
    clearTimeout(displayCorrectionTimer);
    displayCorrectionTimer = null;
  }
  if (positionSaveTimer) {
    clearTimeout(positionSaveTimer);
    positionSaveTimer = null;
  }
  saveWindowPositionNow();
  winBridge?.stop();
});

app.on("window-all-closed", (e: Electron.Event) => {
  e.preventDefault();
});
