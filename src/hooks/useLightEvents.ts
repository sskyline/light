import { useEffect, useState } from "react";
import type { AppState, LightEvent, Memo, SystemState } from "../types";

const EMPTY_STATE: AppState = { sessions: [] };
const EMPTY_SYSTEM: SystemState = {
  media: null,
  bridgeReady: false,
};

function getBridge() {
  return typeof window !== "undefined" ? window.light : undefined;
}

export function useLightState(): AppState {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.getState().then((s) => {
      if (!cancelled) setState(s);
    });
    const off = bridge.onState((s) => setState(s as AppState));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return state;
}

export function useLatestEvent(): LightEvent | null {
  const [evt, setEvt] = useState<LightEvent | null>(null);
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.onEvent((e) => setEvt(e as LightEvent));
  }, []);
  return evt;
}

export function useMemos(): Memo[] {
  const [memos, setMemos] = useState<Memo[]>([]);
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.getMemos().then((m) => {
      if (!cancelled) setMemos(m);
    });
    const off = bridge.onMemos((m) => setMemos(m as Memo[]));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return memos;
}

export function useSystem(): SystemState {
  const [sys, setSys] = useState<SystemState>(EMPTY_SYSTEM);
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.getSystem().then((s) => {
      if (!cancelled) setSys(s);
    });
    const off = bridge.onSystem((s) => setSys(s as SystemState));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return sys;
}

