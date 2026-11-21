import { useEffect, useState } from "react";
import type { AppState, LightEvent, PresenceState } from "../types";

const EMPTY_STATE: AppState = { sessions: [] };

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

export function useSessionTitle(key?: string): string | null {
  const [sessionTitle, setSessionTitle] = useState<{ key: string; title: string | null }>();
  useEffect(() => {
    const getTitle = getBridge()?.getSessionTitle;
    if (!key || !getTitle) return;
    let cancelled = false;
    const setTitle = (title: string | null) => {
      if (!cancelled) setSessionTitle({ key, title });
    };
    getTitle(key).then(setTitle, () => setTitle(null));
    return () => { cancelled = true; };
  }, [key]);
  return sessionTitle && sessionTitle.key === key ? sessionTitle.title : null;
}

export function usePresence(): PresenceState | null {
  const [presence, setPresence] = useState<PresenceState | null>(null);
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.getPresence().then((s) => {
      if (!cancelled) setPresence(s);
    });
    const off = bridge.onPresence((s) => setPresence(s as PresenceState | null));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return presence;
}

