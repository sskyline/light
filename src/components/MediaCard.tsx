import { motion } from "framer-motion";
import type { MediaState } from "../types";

// Friendly names for common players (best-effort; falls back to raw id).
function appLabel(app: string): string {
  const a = app.toLowerCase();
  if (a.includes("cloudmusic") || a.includes("netease")) return "网易云音乐";
  if (a.includes("qqmusic") || a.includes("tencent")) return "QQ 音乐";
  if (a.includes("spotify")) return "Spotify";
  if (a.includes("chrome")) return "Chrome";
  if (a.includes("msedge") || a.includes("edge")) return "Edge";
  if (a.includes("foobar")) return "foobar2000";
  if (a.includes("apple") || a.includes("itunes")) return "Apple Music";
  if (a.includes("potplayer")) return "PotPlayer";
  return app || "media";
}

// Four little bars that dance while audio plays, and rest flat when paused.
// Pure CSS scaleY animation (see styles.css .eq) — compositor-cheap, no JS.
function Equalizer({ playing }: { playing: boolean }) {
  return (
    <span className={`eq ${playing ? "playing" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export function MediaCompact({ media }: { media: MediaState }) {
  const text = media.artist ? `${media.title} · ${media.artist}` : media.title;
  return (
    <div className="media-compact">
      <Equalizer playing={media.playing} />
      <span className="media-text">{text || appLabel(media.app)}</span>
    </div>
  );
}

function IconPrev() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d="M7 6v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M19 6.5v11a.6.6 0 0 1-.92.5l-8.5-5.5a.6.6 0 0 1 0-1l8.5-5.5a.6.6 0 0 1 .92.5Z" fill="currentColor" />
    </svg>
  );
}
function IconNext() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d="M17 6v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M5 6.5v11a.6.6 0 0 0 .92.5l8.5-5.5a.6.6 0 0 0 0-1l-8.5-5.5a.6.6 0 0 0-.92.5Z" fill="currentColor" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M7 5.5v13a.6.6 0 0 0 .92.5l10.5-6.5a.6.6 0 0 0 0-1L7.92 5a.6.6 0 0 0-.92.5Z" fill="currentColor" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <rect x="6.5" y="5" width="4" height="14" rx="1.4" fill="currentColor" />
      <rect x="13.5" y="5" width="4" height="14" rx="1.4" fill="currentColor" />
    </svg>
  );
}

export function MediaFull({ media }: { media: MediaState }) {
  const ctl = (action: "prev" | "playpause" | "next") => () =>
    window.light?.mediaControl(action);
  return (
    <motion.div
      className="media-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <div className="media-art" aria-hidden="true">
        <Equalizer playing={media.playing} />
      </div>
      <div className="media-meta">
        <div className="media-title">{media.title || "—"}</div>
        <div className="media-artist">
          {[media.artist, appLabel(media.app)].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="media-controls">
        <button className="media-btn" onClick={ctl("prev")} title="上一曲" aria-label="上一曲">
          <IconPrev />
        </button>
        <button
          className="media-btn play"
          onClick={ctl("playpause")}
          title="播放/暂停"
          aria-label="播放/暂停"
        >
          {media.playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="media-btn" onClick={ctl("next")} title="下一曲" aria-label="下一曲">
          <IconNext />
        </button>
      </div>
    </motion.div>
  );
}
