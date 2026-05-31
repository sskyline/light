// Assemble a self-contained, runnable Light app folder under release/Light/.
//
// We DON'T use electron-builder/electron-packager — instead we reuse the
// Electron binary already cached in node_modules (no extra download) and lay
// the app out by hand. This works because Light's main process only uses Node
// built-ins + electron (zero third-party runtime deps), and the renderer is
// fully bundled by Vite — so resources/app needs no node_modules at all.
//
// Output tree (what Inno Setup then packages into the installer):
//   release/Light/
//     Light.exe              (renamed electron.exe)
//     *.dll, *.pak, *.bin, icudtl.dat, locales/, resources/   (electron runtime)
//     resources/app/
//       package.json         (trimmed, main -> dist-electron/main.js)
//       dist/                (renderer build)
//       dist-electron/       (compiled main + preload)
//       bridge/              (SMTC / notification PowerShell helpers)
//       icon.ico             (tray + window icon)
//     hooks/                 (Claude Code / Codex integration scripts)
//     light.ico
//
// Run AFTER `npm run build`.  npm run dist == build + stage.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "release", "Light");
const appDir = path.join(out, "resources", "app");

const log = (m) => process.stdout.write(`[stage] ${m}\n`);
const die = (m) => {
  process.stderr.write(`[stage] ERROR: ${m}\n`);
  process.exit(1);
};

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

// ---- preconditions --------------------------------------------------------
const distRenderer = path.join(root, "dist");
const distElectron = path.join(root, "dist-electron");
const electronDist = path.join(root, "node_modules", "electron", "dist");
const iconSrc = path.join(root, "installer", "light.ico");

if (!fs.existsSync(path.join(distRenderer, "index.html")))
  die("dist/index.html missing — run `npm run build` first.");
if (!fs.existsSync(path.join(distElectron, "main.js")))
  die("dist-electron/main.js missing — run `npm run build` first.");
if (!fs.existsSync(path.join(electronDist, "electron.exe")))
  die("node_modules/electron/dist/electron.exe missing — run `npm install`.");
if (!fs.existsSync(iconSrc)) die("installer/light.ico missing.");

// ---- clean ----------------------------------------------------------------
log("cleaning release/Light …");
rmrf(out);
fs.mkdirSync(appDir, { recursive: true });

// ---- electron runtime -----------------------------------------------------
log("copying Electron runtime …");
copyDir(electronDist, out);

// Rename the launcher and drop Electron's bundled demo app.
fs.renameSync(path.join(out, "electron.exe"), path.join(out, "Light.exe"));
rmrf(path.join(out, "resources", "default_app.asar"));

// ---- app payload ----------------------------------------------------------
log("copying app payload …");
copyDir(distRenderer, path.join(appDir, "dist"));
copyDir(distElectron, path.join(appDir, "dist-electron"));
copyDir(path.join(root, "bridge"), path.join(appDir, "bridge"));
fs.copyFileSync(iconSrc, path.join(appDir, "icon.ico"));

// Trimmed production package.json (no devDeps, no scripts).
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const appPkg = {
  name: pkg.name,
  productName: "Light",
  version: pkg.version,
  description: pkg.description,
  main: "dist-electron/main.js",
  author: pkg.author || "Light",
  license: pkg.license || "MIT",
};
fs.writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify(appPkg, null, 2),
  "utf8",
);

// ---- integration scripts + icon at install root ---------------------------
log("copying hooks + icon …");
copyDir(path.join(root, "hooks"), path.join(out, "hooks"));
fs.copyFileSync(iconSrc, path.join(out, "light.ico"));

// ---- done -----------------------------------------------------------------
function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(fp) : fs.statSync(fp).size;
  }
  return total;
}
const mb = (dirSize(out) / 1024 / 1024).toFixed(1);
log(`done → ${path.relative(root, out)}  (${mb} MB)`);
log("next: open installer/light.iss in Inno Setup and Compile.");
