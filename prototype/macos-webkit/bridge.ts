import { installMockBridge } from "../../src/devMock";
import type { PanelLayout } from "../../electron/panelPlacement";

type NativeEvents = {
  hover: boolean;
  layout: PanelLayout;
  blur: undefined;
};

type WebKitWindow = Window & {
  webkit: { messageHandlers: { light: { postMessage: (message: object) => void } } };
  lightNative: <K extends keyof NativeEvents>(event: K, value: NativeEvents[K]) => void;
};

const host = window as unknown as WebKitWindow;
const listeners: { [K in keyof NativeEvents]: Set<(value: NativeEvents[K]) => void> } = {
  hover: new Set(), layout: new Set(), blur: new Set(),
};
const recent: Partial<NativeEvents> = {};

host.lightNative = (event, value) => {
  recent[event] = value;
  listeners[event].forEach(callback => callback(value));
};

function subscribe<K extends keyof NativeEvents>(event: K, callback: (value: NativeEvents[K]) => void) {
  listeners[event].add(callback);
  const value = recent[event];
  if (value !== undefined) callback(value);
  return () => { listeners[event].delete(callback); };
}

const send = (type: string, value?: unknown) => host.webkit.messageHandlers.light.postMessage({ type, value });

installMockBridge({ backdrop: false, defaultMode: "multi" });
Object.assign(window.light, {
  openSession: async () => ({ opened: false, message: "WebKit 原型使用示例会话。" }),
  onHover: callback => subscribe("hover", callback),
  onPanelLayout: callback => subscribe("layout", callback),
  onBlur: callback => subscribe("blur", callback),
  setHotZones: zones => send("hotZones", zones),
  startWindowDrag: () => send("startDrag"),
  endWindowDrag: () => send("endDrag"),
  quit: () => send("quit"),
} satisfies Partial<Window["light"]>);
