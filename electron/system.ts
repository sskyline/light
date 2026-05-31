import { EventEmitter } from "node:events";

export interface MediaState {
  playing: boolean;
  title: string;
  artist: string;
  app: string;
  updatedAt: string;
}

export interface SystemState {
  media: MediaState | null;
  bridgeReady: boolean;
}

const TEXT_LIMIT = 300;

function clamp(s: unknown, max = TEXT_LIMIT): string {
  if (typeof s !== "string") return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export class SystemStore extends EventEmitter {
  private state: SystemState = {
    media: null,
    bridgeReady: false,
  };

  getState(): SystemState {
    return JSON.parse(JSON.stringify(this.state));
  }

  setReady(mediaOk: boolean): void {
    this.state.bridgeReady = true;
    void mediaOk;
    this.emit("change", this.getState());
  }

  setMedia(playing: boolean, title?: string, artist?: string, app?: string): void {
    // No title at all = nothing meaningful to show.
    if (!title || title.length === 0) {
      this.state.media = null;
    } else {
      this.state.media = {
        playing,
        title: clamp(title, 160),
        artist: clamp(artist, 120),
        app: clamp(app, 120),
        updatedAt: new Date().toISOString(),
      };
    }
    this.emit("change", this.getState());
  }

  clearMedia(): void {
    if (this.state.media !== null) {
      this.state.media = null;
      this.emit("change", this.getState());
    }
  }
}
