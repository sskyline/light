import { spawn } from "node:child_process";
import { createServer } from "node:net";

const VITE_PORT = 5173;

function log(tag, msg) {
  process.stdout.write(`[${tag}] ${msg}\n`);
}

function waitForPort(port, host = "127.0.0.1", timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = createServer();
      // Quick probe: try connecting instead.
      import("node:net").then(({ connect }) => {
        const c = connect(port, host);
        c.once("connect", () => {
          c.destroy();
          resolve();
        });
        c.once("error", () => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Timed out waiting for ${host}:${port}`));
          } else {
            setTimeout(tryOnce, 200);
          }
        });
      });
      sock.close();
    };
    tryOnce();
  });
}

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log("dev", `${cmd} exited with code ${code}`);
      process.exit(code);
    }
  });
  return child;
}

async function main() {
  log("dev", "Starting Vite...");
  const vite = run("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"]);

  log("dev", `Waiting for Vite on :${VITE_PORT}...`);
  await waitForPort(VITE_PORT, "localhost");
  log("dev", "Vite is ready.");

  log("dev", "Compiling Electron main...");
  await new Promise((resolve, reject) => {
    const tsc = run("npx", ["tsc", "-p", "tsconfig.electron.json"]);
    tsc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tsc exited ${code}`))));
  });

  log("dev", "Launching Electron...");
  const env = {
    ...process.env,
    VITE_DEV_SERVER_URL: `http://localhost:${VITE_PORT}`,
    ...(process.env.ELECTRON_CACHE
      ? { ELECTRON_CACHE: process.env.ELECTRON_CACHE }
      : process.env.LOCALAPPDATA
        ? { ELECTRON_CACHE: `${process.env.LOCALAPPDATA}\\electron\\Cache` }
        : {}),
  };
  const electron = run("npx", ["electron", "."], { env });

  const shutdown = () => {
    log("dev", "Shutting down...");
    try { electron.kill(); } catch {}
    try { vite.kill(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  electron.on("exit", shutdown);
}

main().catch((err) => {
  log("dev", `Fatal: ${err.message}`);
  process.exit(1);
});
