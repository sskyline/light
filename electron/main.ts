import { panelPlacement, WINDOW_WIDTH, WINDOW_HEIGHT, CAPSULE_TOP, type PanelLayout } from "./panelPlacement";
import type { ConnectionReport } from "../shared/diagnostics";
import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, powerMonitor } from "electron";
import path from "node:path";
import fs from "node:fs";
import { StateStore, type AgentId, type LightEvent, type AppState } from "./state";
import { DEFAULT_PORT, startServer } from "./server";
import { formatInstallHooksResult, installHooks, readHookConnections } from "./hookInstaller";
import { openJumpTarget, type JumpTarget } from "./sessionNavigation";
import { PresenceWatcher, type PresenceState } from "./appPresence";
import { CodexReviewWatcher } from "./codexReviews";
import { readCodexThreadTitle } from "./codexTitles";
import { readClaudeSessionTitle } from "./claudeTitles";
import { createClaudeDesktopLookup } from "./claudeDesktopSessions";
import { readAntigravitySessionTitle } from "./antigravityTitles";

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

interface SavedWindowPosition extends WindowPosition {
  displayId?: number;
  displayKey?: string;
}

interface WindowDrag {
  startCursor: Electron.Point;
  startWindow: WindowPosition;
  lastX: number;
  lastY: number;
  timer: NodeJS.Timeout;
}

const HIT_PADDING = 6;
const CURSOR_POLL_MS = 60;
const WINDOW_DRAG_POLL_MS = 16;
const POSITION_SAVE_DEBOUNCE_MS = 250;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let refreshTrayMenu: (() => void) | null = null;
let cursorTimer: NodeJS.Timeout | null = null;
let positionSaveTimer: NodeJS.Timeout | null = null;
let displayCorrectionTimer: NodeJS.Timeout | null = null;
let windowDrag: WindowDrag | null = null;
let suppressNextMoveSave = false;
let currentlyIgnoring: boolean | null = null;
let hotZones: HotZone[] = [];
let panelLayout: PanelLayout | undefined;
let lastHoverSent: boolean | null = null;

const store = new StateStore();
const codexReviews = new CodexReviewWatcher((thread, reason) => store.recordCodexDenial(thread, reason));
// 安装态探测只在 macOS 启用;其他平台 getPresence 返回 null,UI 保持原样。
const presenceWatcher = process.platform === "darwin"
  ? new PresenceWatcher({
      onChange: (state: PresenceState) => mainWindow?.webContents.send("light:presence", state),
    })
  : null;
let currentDisplayId: number | null = null;
let currentDisplayKey: string | null = null;

function getDevServerUrl(): string | undefined {
  return process.env.VITE_DEV_SERVER_URL;
}

function isWindowPosition(value: unknown): value is SavedWindowPosition {
  if (!value || typeof value !== "object") return false;
  const pos = value as Partial<WindowPosition>;
  return Number.isFinite(pos.x) && Number.isFinite(pos.y);
}

function windowPositionPath(): string {
  return path.join(app.getPath("userData"), "window-position.json");
}

function readWindowPosition(): SavedWindowPosition | null {
  try {
    const raw = fs.readFileSync(windowPositionPath(), "utf8");
    const parsed = JSON.parse(raw);
    return isWindowPosition(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function visibleCapsuleRect(pos: WindowPosition): Electron.Rectangle {
  // Hot zones include padding. On startup use the minimal capsule until its
  // first measurement, so restoring a corner does not move it toward center.
  const width = hotZones[0] ? Math.round(hotZones[0].w) : 56 + 2 * HIT_PADDING;
  const height = hotZones[0] ? Math.round(hotZones[0].h) : 36 + 2 * HIT_PADDING;
  return {
    x: pos.x + Math.round((WINDOW_WIDTH - width) / 2),
    y: pos.y + CAPSULE_TOP - HIT_PADDING,
    width, height,
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
  const safe = visibleCapsuleRect(pos);
  return {
    x: safe.x + Math.round(safe.width / 2),
    y: safe.y + Math.round(safe.height / 2),
  };
}

function displayForWindowPosition(pos: WindowPosition): Electron.Display {
  return screen.getDisplayNearestPoint(islandCenterPoint(pos));
}

function displayKey(display: Electron.Display): string {
  const d = display as Electron.Display & { label?: string; internal?: boolean };
  const label = typeof d.label === "string" ? d.label : "";
  const internal = typeof d.internal === "boolean" ? d.internal : false;
  return [
    internal ? "internal" : "external",
    label,
    `${display.size.width}x${display.size.height}`,
    `scale:${display.scaleFactor}`,
  ].join("|");
}

function displayById(id: number | null): Electron.Display | null {
  if (id == null) return null;
  return screen.getAllDisplays().find((display) => display.id === id) ?? null;
}

function displayByKey(key: string | null): Electron.Display | null {
  if (!key) return null;
  return screen.getAllDisplays().find((display) => displayKey(display) === key) ?? null;
}

function rememberDisplay(display: Electron.Display): void {
  const changed = currentDisplayId !== display.id;
  currentDisplayId = display.id;
  currentDisplayKey = displayKey(display);
  if (changed) refreshTrayMenu?.();
}

function displayFromPreference(saved?: SavedWindowPosition | null): Electron.Display | null {
  return displayById(saved?.displayId ?? currentDisplayId) ??
    displayByKey(saved?.displayKey ?? currentDisplayKey);
}

function clampPositionToDisplay(pos: WindowPosition, display: Electron.Display): WindowPosition {
  const area = display.workArea;
  const capsule = visibleCapsuleRect({ x: 0, y: 0 });
  return {
    x: clamp(pos.x, area.x - capsule.x, area.x + area.width - capsule.x - capsule.width),
    y: clamp(pos.y, area.y - capsule.y, area.y + area.height - capsule.y - capsule.height),
  };
}

function isWindowPositionValidOnDisplay(pos: WindowPosition, display: Electron.Display): boolean {
  return containsRect(display.workArea, visibleCapsuleRect(pos));
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
    const preferredDisplay = displayFromPreference(saved);
    if (preferredDisplay) {
      rememberDisplay(preferredDisplay);
      if (isWindowPositionValidOnDisplay(saved, preferredDisplay)) return saved;
      return clampPositionToDisplay(saved, preferredDisplay);
    }

    const fallbackDisplay = displayForWindowPosition(saved);
    rememberDisplay(fallbackDisplay);
    if (isWindowPositionValidOnDisplay(saved, fallbackDisplay)) return saved;
    return clampPositionToDisplay(saved, fallbackDisplay);
  }
  rememberDisplay(display);
  return centeredPosition(display);
}

// Store and drag the capsule anchor, independently of the native canvas origin.
function capsulePosition(win: BrowserWindow): WindowPosition {
  const [x, y] = win.getPosition();
  return { x: x + (panelLayout?.capsuleX ?? 0), y: y + (panelLayout?.capsuleY ?? 0) };
}

function placeWindow(anchor: WindowPosition, display: Electron.Display): void {
  if (!mainWindow) return;
  const height = hotZones[0] ? Math.max(1, Math.round(hotZones[0].h) - 2 * HIT_PADDING) : 36;
  const next = panelPlacement(anchor, display.workArea, height);
  const changed = JSON.stringify(panelLayout) !== JSON.stringify(next.layout);
  panelLayout = next.layout;
  const [x, y] = mainWindow.getPosition();
  if (x !== next.x || y !== next.y) mainWindow.setPosition(next.x, next.y);
  if (changed) mainWindow.webContents.send("light:panel-layout", panelLayout);
}

function correctWindowPositionForDisplays(): void {
  if (!mainWindow || mainWindow.isDestroyed() || windowDrag) return;
  const pos = capsulePosition(mainWindow);
  const preferredDisplay = displayFromPreference();
  const display = preferredDisplay ?? displayForWindowPosition(pos);
  const next = isWindowPositionValidOnDisplay(pos, display)
    ? pos
    : clampPositionToDisplay(pos, display);

  if (preferredDisplay || currentDisplayId == null) rememberDisplay(display);
  suppressNextMoveSave = !preferredDisplay;
  placeWindow(next, display);
  if (preferredDisplay && (next.x !== pos.x || next.y !== pos.y)) scheduleWindowPositionSave();
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
  const { x, y } = capsulePosition(mainWindow);
  const preferredDisplay = displayFromPreference();
  if ((currentDisplayId != null || currentDisplayKey) && !preferredDisplay) return;
  const display = preferredDisplay ?? displayForWindowPosition({ x, y });
  try {
    const file = windowPositionPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ x, y, displayId: display.id, displayKey: displayKey(display) }, null, 2),
      "utf8",
    );
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
  const anchor = { x: nextX, y: nextY };
  placeWindow(anchor, displayForWindowPosition(anchor));
}

function startWindowDrag(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopWindowDrag(false);
  const cursor = screen.getCursorScreenPoint();
  const { x, y } = capsulePosition(mainWindow);
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
  if (savePosition && mainWindow && !mainWindow.isDestroyed()) {
    const pos = capsulePosition(mainWindow);
    const display = displayForWindowPosition(pos);
    rememberDisplay(display);
    placeWindow(clampPositionToDisplay(pos, display), display);
    scheduleWindowPositionSave();
  }
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

function moveToDisplay(display: Electron.Display): void {
  if (!mainWindow) return;
  rememberDisplay(display);
  const pos = centeredPosition(display);
  placeWindow(pos, display);
  scheduleWindowPositionSave();
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay();
  hotZones = [];
  const pos = initialWindowPosition(display);
  const targetDisplay = displayForWindowPosition(pos);
  rememberDisplay(targetDisplay);
  const placement = panelPlacement(pos, targetDisplay.workArea, 36);
  panelLayout = placement.layout;

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: placement.x,
    y: placement.y,
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

  mainWindow.on("show", () => refreshTrayMenu?.());
  mainWindow.on("hide", () => refreshTrayMenu?.());

  mainWindow.on("closed", () => {
    stopWindowDrag(false);
    mainWindow = null;
    stopCursorPoll();
    refreshTrayMenu?.();
  });
  mainWindow.on("move", () => {
    if (suppressNextMoveSave) {
      suppressNextMoveSave = false;
      return;
    }
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

function sendHover(over: boolean): void {
  if (over === lastHoverSent) return;
  lastHoverSent = over;
  mainWindow?.webContents.send("light:hover", over);
}

function startCursorPoll(): void {
  stopCursorPoll();
  cursorTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (windowDrag) {
      setIgnore(false);
      sendHover(true);
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
    // leaves a hot zone).
    sendHover(overHotZone);
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

let eventServer: ReturnType<typeof startServer>;
let serverError = "";
const lastReceived = new Map<AgentId, Date>();
let lastJumpFailure: { at: Date; target: string; reason: string } | undefined;
let lastInstall: ConnectionReport["lastInstall"];
const targetNames: Record<JumpTarget["kind"], string> = {
  codex: "Codex", "claude-desktop": "Claude 桌面版", rex: "Rex", iterm: "iTerm2", ghostty: "Ghostty",
};

function connectionReport(): ConnectionReport {
  const adapters: ConnectionReport["adapters"] = readHookConnections().map(adapter => ({
    ...adapter, received: lastReceived.get(adapter.agent)?.toLocaleString("zh-CN", { hour12: false }),
  }));
  const trae = lastReceived.get("trae");
  if (trae) adapters.push({ name: "Trae", status: "外部事件源", configured: true, received: trae.toLocaleString("zh-CN", { hour12: false }) });
  const address = eventServer.address();
  return {
    service: {
      running: eventServer.listening,
      status: eventServer.listening ? "运行正常" : serverError || "未连接",
      address: `127.0.0.1:${address && typeof address === "object" ? address.port : DEFAULT_PORT}`,
    },
    adapters,
    lastInstall,
    lastFailure: lastJumpFailure && { ...lastJumpFailure, at: lastJumpFailure.at.toLocaleString("zh-CN", { hour12: false }) },
  };
}

function showDiagnostics(): void {
  const win = mainWindow;
  if (!win) return;
  win.show();
  win.focus();
  const open = () => win.webContents.send("light:open-diagnostics");
  if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", open);
  else open();
}

function displayMenuLabel(display: Electron.Display, index: number, counts: Map<string, number>): string {
  const resolution = `${display.size.width}×${display.size.height}`;
  const rawLabel = (display as Electron.Display & { label?: string }).label?.trim();
  if (!rawLabel) return `显示器 ${index + 1}（${resolution}）`;
  return (counts.get(rawLabel) ?? 0) > 1 ? `${rawLabel}（${index + 1} · ${resolution}）` : rawLabel;
}

function createTray(): void {
  const iconPath = resolveIcon();
  const trayImg = iconPath ? nativeImage.createFromPath(iconPath) : buildTrayIcon();
  if (process.platform === "darwin") trayImg.setTemplateImage(true);
  tray = new Tray(trayImg);
  tray.setToolTip("Light · 桌面状态胶囊");
  const refresh = () => {
    const displays = screen.getAllDisplays();
    const labelCounts = new Map<string, number>();
    for (const d of displays) {
      const label = (d as Electron.Display & { label?: string }).label?.trim();
      if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const activeDisplayId = currentDisplayId ??
      (mainWindow && !mainWindow.isDestroyed() ? displayForWindowPosition(capsulePosition(mainWindow)).id : null);
    const displaySection: Electron.MenuItemConstructorOptions[] = displays.length > 1
      ? [
          { type: "separator" },
          {
            label: "移动到显示器",
            submenu: displays.map((d, i) => ({
              label: displayMenuLabel(d, i, labelCounts),
              type: "radio",
              checked: d.id === activeDisplayId,
              click: () => moveToDisplay(d),
            })),
          },
        ]
      : [];

    const menu = Menu.buildFromTemplate([
      { label: `Light v${app.getVersion()}`, enabled: false },
      { type: "separator" },
      {
        label: mainWindow?.isVisible() ? "隐藏胶囊" : "显示胶囊",
        click: () => {
          if (!mainWindow) return;
          if (mainWindow.isVisible()) mainWindow.hide();
          else mainWindow.showInactive();
        },
      },
      ...displaySection,
      { type: "separator" },
      { label: "连接与诊断…", click: showDiagnostics },
      { type: "separator" },
      {
        label: "退出 Light",
        accelerator: process.platform === "darwin" ? "Command+Q" : undefined,
        click: () => app.quit(),
      },
    ]);
    tray?.setContextMenu(menu);
  };
  refreshTrayMenu = refresh;
  refresh();
  if (process.platform !== "darwin") {
    tray.on("click", () => { refresh(); tray?.popUpContextMenu(); });
  }
}

function installLightHooks(): void {
  try {
    const execPath = resolveHookExecPath();
    const result = installHooks({
      appPath: app.getAppPath(),
      execPath,
      userDataPath: app.getPath("userData"),
    });
    const targets = [result.claude, result.codex, result.antigravity];
    const failures = targets.filter(target => target.error);
    const summary = failures.length === targets.length ? "Hooks 接入失败"
      : failures.length ? failures.map(target => target.target).join("、") + " 接入失败"
      : targets.some(target => target.changed) ? "Hooks 配置已更新" : "Hooks 配置已是最新";
    lastInstall = { ok: failures.length === 0, summary, detail: formatInstallHooksResult(result) };
  } catch (error) {
    lastInstall = { ok: false, summary: "Hooks 接入失败", detail: error instanceof Error ? error.message : String(error) };
  }
}

function resolveHookExecPath(): string {
  if (process.platform !== "darwin" || !process.execPath.startsWith("/Volumes/")) {
    return process.execPath;
  }
  const bundleName = path.basename(path.resolve(path.dirname(process.execPath), "../../.."));
  const candidate = path.join(
    "/Applications",
    bundleName.endsWith(".app") ? bundleName : `${app.getName()}.app`,
    "Contents",
    "MacOS",
    path.basename(process.execPath),
  );
  if (fs.existsSync(candidate)) return candidate;
  throw new Error("请先把 Light 从磁盘映像拖到“应用程序”，打开后再接入 Hooks。");
}

function wireIpc(): void {
  const findDesktopSession = createClaudeDesktopLookup();
  async function jumpTargetFor(key: unknown, refresh = false) {
    if (process.platform !== "darwin" || typeof key !== "string") return undefined;
    const direct = store.getJumpTarget(key);
    if (direct) return direct;
    const session = store.getTitleSession(key);
    if (session?.agent !== "claude-code") return undefined;
    const id = await findDesktopSession(session.id, refresh);
    // A terminal event or session_end can arrive while metadata is loading.
    return store.getJumpTarget(key) ?? (id && store.getTitleSession(key)?.id === session.id
      ? { kind: "claude-desktop" as const, id } : undefined);
  }
  ipcMain.handle("light:get-session-jump-kind", async (_evt, key: unknown) => (await jumpTargetFor(key))?.kind);
  ipcMain.handle("light:open-session", async (_evt, key: unknown) => {
    let target: JumpTarget | undefined;
    try {
      target = await jumpTargetFor(key, true);
      if (!target) throw new Error("找不到这条会话的跳转目标。");
      if (!(await openJumpTarget(target))) throw new Error("系统未能打开目标。");
      return { opened: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "跳转失败。";
      lastJumpFailure = { at: new Date(), target: target ? targetNames[target.kind] : "会话", reason: message };
      return { opened: false, message };
    }
  });
  ipcMain.handle("light:get-diagnostics", connectionReport);
  ipcMain.handle("light:install-hooks", event => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无法接入 Hooks");
    return installLightHooks();
  });
  ipcMain.handle("light:get-state", (): AppState => store.getState());
  ipcMain.handle("light:get-session-title", (_evt, sessionKey: unknown) => {
    if (typeof sessionKey !== "string") return null;
    const session = store.getTitleSession(sessionKey);
    if (!session) return null;
    switch (session.agent) {
      case "codex": return readCodexThreadTitle(session.id);
      case "claude-code": return readClaudeSessionTitle(session.id);
      case "antigravity": return readAntigravitySessionTitle(session.id);
    }
  });
  ipcMain.handle("light:get-presence", (): PresenceState | null => presenceWatcher?.getState() ?? null);
  ipcMain.on("light:request-panel-layout", event => event.reply("light:panel-layout", panelLayout));
  ipcMain.on("light:start-window-drag", () => startWindowDrag());
  ipcMain.on("light:end-window-drag", () => stopWindowDrag());
  ipcMain.on("light:set-hot-zones", (_evt, zones: HotZone[]) => {
    if (!Array.isArray(zones)) return;
    const previous = hotZones[0];
    hotZones = zones.filter(
      (z) =>
        z && typeof z.x === "number" && typeof z.y === "number" &&
        typeof z.w === "number" && typeof z.h === "number",
    );
    const island = hotZones[0];
    if (island && !windowDrag && (!previous || island.w > previous.w || Math.round(island.h) !== Math.round(previous.h))) {
      correctWindowPositionForDisplays();
    }
  });
  ipcMain.on("light:acknowledge-approval", (_evt, key: unknown, id: unknown) => {
    if (typeof key === "string" && typeof id === "number") store.acknowledgeApproval(key, id);
  });
  ipcMain.on("light:clear-events", () => {
    store.clearEvents();
  });
  ipcMain.on("light:remove-session", (_evt, key: string) => {
    if (typeof key === "string") store.removeSession(key);
  });
  ipcMain.on("light:panel-opened", () => presenceWatcher?.probeNow());
  ipcMain.on("light:quit", () => app.quit());

  store.on("state", (state: AppState) => {
    mainWindow?.webContents.send("light:state", state);
  });
  store.on("event", (evt: LightEvent) => {
    mainWindow?.webContents.send("light:event", evt);
  });
}

app.whenReady().then(() => {
  eventServer = startServer(store, DEFAULT_PORT, (thread, turn, type) => codexReviews.track(thread, turn, type),
    agent => lastReceived.set(agent, new Date()));
  eventServer.on("error", (error: NodeJS.ErrnoException) => {
    serverError = error.code === "EADDRINUSE" ? "端口已被占用" : error.message;
  });
  createWindow();
  createTray();
  wireIpc();
  presenceWatcher?.start();

  screen.on("display-added", () => { refreshTrayMenu?.(); scheduleDisplayCorrection(600); });
  screen.on("display-removed", () => { refreshTrayMenu?.(); scheduleDisplayCorrection(600); });
  screen.on("display-metrics-changed", () => { refreshTrayMenu?.(); scheduleDisplayCorrection(600); });
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
  codexReviews.stop();
  presenceWatcher?.stop();
});

app.on("window-all-closed", (e: Electron.Event) => {
  e.preventDefault();
});
