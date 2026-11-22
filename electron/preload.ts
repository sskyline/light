import type { PanelLayout } from "./panelPlacement";
import { contextBridge, ipcRenderer } from "electron";

interface HotZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A tray command can arrive before React mounts its listener.
let openDiagnostics: (() => void) | undefined;
let pendingDiagnostics = false;
ipcRenderer.on("light:open-diagnostics", () => {
  if (openDiagnostics) openDiagnostics();
  else pendingDiagnostics = true;
});

contextBridge.exposeInMainWorld("light", {
  onEvent: (cb: (evt: unknown) => void) => {
    const listener = (_: unknown, evt: unknown) => cb(evt);
    ipcRenderer.on("light:event", listener);
    return () => ipcRenderer.off("light:event", listener);
  },
  onState: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on("light:state", listener);
    return () => ipcRenderer.off("light:state", listener);
  },
  onPresence: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on("light:presence", listener);
    return () => ipcRenderer.off("light:presence", listener);
  },
  onBlur: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("light:blur", listener);
    return () => ipcRenderer.off("light:blur", listener);
  },
  onHover: (cb: (over: boolean) => void) => {
    const listener = (_: unknown, over: boolean) => cb(over);
    ipcRenderer.on("light:hover", listener);
    return () => ipcRenderer.off("light:hover", listener);
  },
  onPanelLayout: (cb: (layout: PanelLayout) => void) => {
    const listener = (_: unknown, layout: PanelLayout) => cb(layout);
    ipcRenderer.on("light:panel-layout", listener);
    ipcRenderer.send("light:request-panel-layout");
    return () => ipcRenderer.off("light:panel-layout", listener);
  },
  onOpenDiagnostics: (cb: () => void) => {
    openDiagnostics = cb;
    if (pendingDiagnostics) {
      pendingDiagnostics = false;
      cb();
    }
    return () => { openDiagnostics = undefined; };
  },
  installHooks: () => ipcRenderer.invoke("light:install-hooks"),
  getDiagnostics: () => ipcRenderer.invoke("light:get-diagnostics"),
  getState: () => ipcRenderer.invoke("light:get-state"),
  getSessionTitle: (key: string) => ipcRenderer.invoke("light:get-session-title", key),
  openSession: (key: string) => ipcRenderer.invoke("light:open-session", key),
  getSessionJumpKind: (key: string) => ipcRenderer.invoke("light:get-session-jump-kind", key),
  getPresence: () => ipcRenderer.invoke("light:get-presence"),
  acknowledgeApproval: (key: string, id: number) => ipcRenderer.send("light:acknowledge-approval", key, id),
  clearEvents: () => ipcRenderer.send("light:clear-events"),
  removeSession: (key: string) => ipcRenderer.send("light:remove-session", key),
  setSessionPinned: (key: string, pinned: boolean) => ipcRenderer.send("light:set-session-pinned", key, pinned),
  panelOpened: () => ipcRenderer.send("light:panel-opened"),
  startWindowDrag: () => ipcRenderer.send("light:start-window-drag"),
  endWindowDrag: () => ipcRenderer.send("light:end-window-drag"),
  setHotZones: (zones: HotZone[]) => ipcRenderer.send("light:set-hot-zones", zones),
  quit: () => ipcRenderer.send("light:quit"),
});
