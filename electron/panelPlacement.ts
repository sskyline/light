import type { Rectangle } from "electron";

// All coordinates are Electron screen DIPs. The saved point is the origin of
// the old, top-centered layout so existing window-position.json files still fit.
export const WINDOW_WIDTH = 880;
export const WINDOW_HEIGHT = 520;
export const CAPSULE_TOP = 10;
const GAP = 9;
const EDGE = 8;
const PANEL_HEIGHT = 452;

export function panelPlacement(anchor: { x: number; y: number }, area: Rectangle, capsuleHeight: number) {
  const center = anchor.x + WINDOW_WIDTH / 2;
  const top = anchor.y + CAPSULE_TOP;
  const bottom = top + capsuleHeight;
  const roomBelow = area.y + area.height - bottom - GAP - EDGE;
  const roomAbove = top - area.y - GAP - EDGE;
  const above = roomBelow < PANEL_HEIGHT && roomAbove > roomBelow;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

  // Move the transparent canvas as well: CSS alone cannot draw above its top.
  const x = clamp(anchor.x, area.x, area.x + area.width - WINDOW_WIDTH);
  const y = clamp(above ? bottom + EDGE - WINDOW_HEIGHT : anchor.y, area.y, area.y + area.height - WINDOW_HEIGHT);
  const panelWidth = Math.min(384, area.width - 2 * EDGE);
  const panelLeft = clamp(center - panelWidth / 2, area.x + EDGE, area.x + area.width - EDGE - panelWidth);
  const roomInWindow = above ? top - y - GAP - EDGE : y + WINDOW_HEIGHT - bottom - GAP - EDGE;
  return {
    x, y,
    layout: {
      capsuleX: anchor.x - x, capsuleY: anchor.y - y,
      panelShiftX: panelLeft + panelWidth / 2 - center, panelWidth, above,
      panelMaxHeight: Math.max(0, Math.min(above ? roomAbove : roomBelow, roomInWindow)),
    },
  };
}

export type PanelLayout = ReturnType<typeof panelPlacement>["layout"];
