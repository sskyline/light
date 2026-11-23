import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

if (process.platform !== "darwin") throw new Error("这个原型需要 macOS 和 Swift 编译器。");

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const output = join(root, "release/macos-webkit");
const app = join(output, "Light WebKit Prototype.app");
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
const renderer = join(resources, "renderer");
const executable = join(contents, "MacOS/LightWebKitPrototype");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
mkdirSync(dirname(executable), { recursive: true });

await build({
  root,
  build: { outDir: renderer, emptyOutDir: true, rollupOptions: { output: { inlineDynamicImports: true } } },
});
// Embed the two renderer entry assets so WebKit can load them from a local file.
const indexPath = join(renderer, "index.html");
const index = readFileSync(indexPath, "utf8");
const entry = index.match(/<script type="module" crossorigin src="\.\/([^\"]+)"><\/script>/);
const style = index.match(/<link rel="stylesheet" crossorigin href="\.\/([^\"]+)">/);
if (!entry || !style) throw new Error("找不到 React 构建入口或样式表。");
const entryPath = join(renderer, entry[1]);
const stylePath = join(renderer, style[1]);
const code = readFileSync(entryPath, "utf8").replace(/<\/script/gi, "<\\/script");
const css = readFileSync(stylePath, "utf8").replace(/<\/style/gi, "<\\/style");
writeFileSync(indexPath, index
  .replace(entry[0], () => `<script type="module">${code}</script>`)
  .replace(style[0], () => `<style>${css}</style>`));
unlinkSync(entryPath);
unlinkSync(stylePath);
await build({
  configFile: false,
  build: {
    outDir: join(resources, "host"),
    emptyOutDir: true,
    lib: { entry: join(here, "bridge.ts"), name: "LightPrototypeBridge", formats: ["iife"], fileName: () => "bridge.js" },
  },
});

cpSync(join(root, "installer/tray-icon-macTemplate.png"), join(resources, "tray.png"));
writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>LightWebKitPrototype</string>
  <key>CFBundleIdentifier</key><string>com.light.webkit-prototype</string>
  <key>CFBundleName</key><string>Light WebKit Prototype</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);

execFileSync("swiftc", [
  "-O", "-parse-as-library", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
  "-module-cache-path", join(output, "module-cache"),
  join(here, "Host.swift"), "-o", executable,
], { stdio: "inherit" });
execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
console.log(app);
