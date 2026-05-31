import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

export interface Memo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  completedAt?: string;
}

const MEMO_LIMIT = 50;
const TEXT_LIMIT = 200;

function newId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

export class MemoStore extends EventEmitter {
  private memos: Memo[] = [];
  private filePath: string;
  private saving = false;
  private pendingSave = false;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.memos = parsed
            .filter((m) => m && typeof m.id === "string" && typeof m.text === "string")
            .map((m) => ({
              id: String(m.id),
              text: String(m.text).slice(0, TEXT_LIMIT),
              completed: Boolean(m.completed),
              createdAt: typeof m.createdAt === "string" ? m.createdAt : new Date().toISOString(),
              completedAt: typeof m.completedAt === "string" ? m.completedAt : undefined,
            }));
        }
      }
    } catch (err) {
      console.error("[memos] load failed:", err);
      this.memos = [];
    }
  }

  private async save(): Promise<void> {
    if (this.saving) {
      this.pendingSave = true;
      return;
    }
    this.saving = true;
    try {
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = this.filePath + ".tmp";
      await fs.promises.writeFile(tmp, JSON.stringify(this.memos, null, 2), "utf8");
      await fs.promises.rename(tmp, this.filePath);
    } catch (err) {
      console.error("[memos] save failed:", err);
    } finally {
      this.saving = false;
      if (this.pendingSave) {
        this.pendingSave = false;
        this.save();
      }
    }
  }

  list(): Memo[] {
    return JSON.parse(JSON.stringify(this.memos));
  }

  add(rawText: string): Memo | null {
    const text = String(rawText ?? "").trim();
    if (!text) return null;
    if (this.memos.length >= MEMO_LIMIT) {
      // drop the oldest completed memo to make room
      const dropIdx = this.memos.findIndex((m) => m.completed);
      if (dropIdx >= 0) this.memos.splice(dropIdx, 1);
      else this.memos.shift();
    }
    const memo: Memo = {
      id: newId(),
      text: text.slice(0, TEXT_LIMIT),
      completed: false,
      createdAt: new Date().toISOString(),
    };
    this.memos.push(memo);
    this.save();
    this.emit("change", this.list());
    return memo;
  }

  toggle(id: string): void {
    const m = this.memos.find((x) => x.id === id);
    if (!m) return;
    m.completed = !m.completed;
    m.completedAt = m.completed ? new Date().toISOString() : undefined;
    this.save();
    this.emit("change", this.list());
  }

  delete(id: string): void {
    const idx = this.memos.findIndex((x) => x.id === id);
    if (idx < 0) return;
    this.memos.splice(idx, 1);
    this.save();
    this.emit("change", this.list());
  }
}
