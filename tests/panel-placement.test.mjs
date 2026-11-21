import assert from "node:assert/strict";
import test from "node:test";
import placement from "../dist-electron/panelPlacement.js";

const { panelPlacement, WINDOW_WIDTH, WINDOW_HEIGHT } = placement;

test("panels fit the capsule's work area and native window at every edge", () => {
  for (const area of [
    { x: 0, y: 32, width: 1512, height: 884 },
    { x: -1280, y: -200, width: 1280, height: 700 },
    { x: 1512, y: 75, width: 760, height: 440 },
    { x: -320, y: 0, width: 320, height: 500 },
  ]) {
    for (const height of [36, 72]) {
      for (const cx of [area.x + 28, area.x + area.width / 2, area.x + area.width - 28]) {
        for (const top of [area.y + 10, area.y + area.height / 2, area.y + area.height - height - 6]) {
          const anchor = { x: cx - WINDOW_WIDTH / 2, y: top - 10 };
          const { x, y, layout } = panelPlacement(anchor, area, height);
          assert.equal(x + layout.capsuleX + WINDOW_WIDTH / 2, cx);
          assert.equal(y + layout.capsuleY + 10, top);
          const left = cx + layout.panelShiftX - layout.panelWidth / 2;
          const panelTop = layout.above ? top - 9 - layout.panelMaxHeight : top + height + 9;
          assert.ok(left >= Math.max(x, area.x));
          assert.ok(left + layout.panelWidth <= Math.min(x + WINDOW_WIDTH, area.x + area.width));
          assert.ok(panelTop >= Math.max(y, area.y));
          assert.ok(panelTop + layout.panelMaxHeight <= Math.min(y + WINDOW_HEIGHT, area.y + area.height));
          assert.ok(layout.panelMaxHeight > 100);
          if (top === area.y + 10) assert.equal(layout.above, false);
          if (top === area.y + area.height - height - 6) assert.equal(layout.above, true);
        }
      }
    }
  }
});
