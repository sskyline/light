import { contextBridge, ipcRenderer } from "electron";

interface HotZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  onMemos: (cb: (memos: unknown) => void) => {
    const listener = (_: unknown, memos: unknown) => cb(memos);
    ipcRenderer.on("light:memos", listener);
    return () => ipcRenderer.off("light:memos", listener);
  },
  onSystem: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on("light:system", listener);
    return () => ipcRenderer.off("light:system", listener);
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
  getState: () => ipcRenderer.invoke("light:get-state"),
  getMemos: () => ipcRenderer.invoke("light:get-memos"),
  getSystem: () => ipcRenderer.invoke("light:get-system"),
  addMemo: (text: string) => ipcRenderer.send("light:add-memo", text),
  toggleMemo: (id: string) => ipcRenderer.send("light:toggle-memo", id),
  deleteMemo: (id: string) => ipcRenderer.send("light:delete-memo", id),
  clearEvents: () => ipcRenderer.send("light:clear-events"),
  removeSession: (key: string) => ipcRenderer.send("light:remove-session", key),
  mediaControl: (action: string) => ipcRenderer.send("light:media-control", action),
  startWindowDrag: () => ipcRenderer.send("light:start-window-drag"),
  endWindowDrag: () => ipcRenderer.send("light:end-window-drag"),
  setHotZones: (zones: HotZone[]) => ipcRenderer.send("light:set-hot-zones", zones),
  quit: () => ipcRenderer.send("light:quit"),
});
