import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function launch(args, env = process.env, stdio = "inherit") {
  const child = spawn(process.execPath, args, { env, stdio });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return { child, exited };
}
async function stop(process) {
  if (!process || process.child.exitCode !== null) return;
  process.child.kill();
  await Promise.race([process.exited, delay(5000, undefined, { ref: false })]);
}
// Own only the processes we start. Avoid Playwright's process-group teardown
// on restricted Windows hosts. No existing server is reused.
const server = launch(
  [
    "node_modules/next/dist/bin/next",
    ...(process.env.PRIVATEFLIX_E2E_MODE === "development"
      ? ["dev", "--webpack"]
      : ["start"]),
    "--hostname",
    "127.0.0.1",
    "--port",
    "3319",
  ],
  {
    ...process.env,
    APP_URL: "https://localhost:3319",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  ["ignore", "pipe", "pipe"],
);
server.child.stdout.resume();
server.child.stderr.resume();
let runner;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.child.exitCode !== null)
      throw new Error("E2E server exited before startup");
    try {
      const response = await fetch("http://127.0.0.1:3319", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Server may still be starting. */
    }
    await delay(500);
  }
  if (!ready)
    throw new Error(
      "E2E server startup timed out; build and configure the app first",
    );
  runner = launch([
    "node_modules/@playwright/test/cli.js",
    "test",
    ...process.argv.slice(2),
  ]);
  const code = await Promise.race([
    runner.exited,
    delay(120000, 124, { ref: false }),
  ]);
  if (code === 124) console.error("E2E runner exceeded its 120-second limit");
  process.exitCode = code;
} finally {
  await stop(runner);
  await stop(server);
}
