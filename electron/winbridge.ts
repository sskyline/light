import { spawn, type ChildProcess, execFile } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { SystemStore } from "./system";

export type MediaAction = "next" | "prev" | "playpause" | "play" | "pause";

const POWERSHELL = "powershell.exe";

export class WinBridge {
  private store: SystemStore;
  private bridgeScript: string;
  private controlScript: string;
  private child: ChildProcess | null = null;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(store: SystemStore, bridgeDir: string) {
    this.store = store;
    this.bridgeScript = path.join(bridgeDir, "win-bridge.ps1");
    this.controlScript = path.join(bridgeDir, "media-control.ps1");
  }

  start(): void {
    if (process.platform !== "win32") {
      console.log("[winbridge] non-Windows platform, skipping");
      return;
    }
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
  }

  private spawnChild(): void {
    if (this.stopped) return;
    this.child = spawn(
      POWERSHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.bridgeScript],
      { windowsHide: true },
    );

    this.child.stdout?.setEncoding("utf8");
    const rl = readline.createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (d) => {
      const s = String(d).trim();
      if (s) console.error("[winbridge:stderr]", s.slice(0, 200));
    });

    this.child.on("exit", (code) => {
      console.log("[winbridge] exited", code);
      this.child = null;
      if (!this.stopped) {
        this.restartTimer = setTimeout(() => this.spawnChild(), 3000);
      }
    });
    this.child.on("error", (err) => {
      console.error("[winbridge] spawn error", err.message);
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    switch (obj.kind) {
      case "ready":
        this.store.setReady(Boolean(obj.media));
        break;
      case "media":
        if (obj.none) {
          this.store.clearMedia();
        } else {
          this.store.setMedia(Boolean(obj.playing), obj.title, obj.artist, obj.app);
        }
        break;
    }
  }

  control(action: MediaAction): void {
    if (process.platform !== "win32") return;
    const valid: MediaAction[] = ["next", "prev", "playpause", "play", "pause"];
    if (!valid.includes(action)) return;
    execFile(
      POWERSHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.controlScript, action],
      { windowsHide: true, timeout: 4000 },
      (err) => {
        if (err) console.error("[winbridge] control error", action, err.message);
      },
    );
  }
}
