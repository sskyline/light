import type { JumpTarget, OpenJumpResult, ResumeSpec } from "./sessionNavigation";

export interface OpenSessionResponse {
  opened: boolean;
  message?: string;
}

export interface SessionOpenGateDeps {
  resolveTarget: (key: string) => Promise<JumpTarget | undefined>;
  getResumeContext: (key: string) => ResumeSpec | undefined;
  openTarget: (
    target: JumpTarget,
    resume?: ResumeSpec,
    onTargetUpdated?: (target: JumpTarget) => void,
  ) => Promise<OpenJumpResult>;
  updateJumpTarget: (key: string, target: JumpTarget) => void;
  onFailure?: (target: JumpTarget | undefined, reason: string) => void;
}

function sameTarget(a: JumpTarget | undefined, b: JumpTarget | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.id !== b.id) return false;
  if (a.kind === "rex" && b.kind === "rex") return a.session === b.session;
  return true;
}

export function createSessionOpenGate(deps: SessionOpenGateDeps): (key: unknown) => Promise<OpenSessionResponse> {
  const inFlight = new Map<string, Promise<OpenSessionResponse>>();

  return async (key: unknown): Promise<OpenSessionResponse> => {
    if (typeof key !== "string" || !key) {
      const reason = "找不到这条会话的跳转目标。";
      deps.onFailure?.(undefined, reason);
      return { opened: false, message: reason };
    }

    const existing = inFlight.get(key);
    if (existing) return existing;

    const pending = (async (): Promise<OpenSessionResponse> => {
      let target: JumpTarget | undefined;
      let savedTarget: JumpTarget | undefined;
      const rememberTarget = (next: JumpTarget) => {
        if (sameTarget(savedTarget, next)) return;
        savedTarget = next;
        target = next;
        deps.updateJumpTarget(key, next);
      };

      try {
        target = await deps.resolveTarget(key);
        if (!target) throw new Error("找不到这条会话的跳转目标。");
        const resume = deps.getResumeContext(key);
        const result = await deps.openTarget(target, resume, rememberTarget);
        if (!result.opened) throw new Error("系统未能打开目标。");
        if (result.updatedTarget) {
          rememberTarget(result.updatedTarget);
        }
        return { opened: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "跳转失败。";
        deps.onFailure?.(target, message);
        return { opened: false, message };
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, pending);
    return pending;
  };
}
