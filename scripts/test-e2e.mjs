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
    // Never let a disposable test server inherit an owner's live Drive setup
    // from the workstation's .env file.
    STORAGE_PROVIDER: "s3",
    GOOGLE_DRIVE_CLIENT_ID: "",
    GOOGLE_DRIVE_CLIENT_SECRET: "",
    GOOGLE_DRIVE_REFRESH_TOKEN: "",
    GOOGLE_DRIVE_FOLDER_ID: "",
    NODE_ENV:
      process.env.PRIVATEFLIX_E2E_MODE === "development"
        ? "development"
        : "production",
    APP_URL: "https://localhost:3319",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  ["ignore", "pipe", "pipe"],
);
server.child.stdout.resume();
let startupError = "";
server.child.stderr.on("data", (chunk) => {
  startupError = (startupError + chunk.toString()).slice(-4096);
});
let runner;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.child.exitCode !== null) {
      const fields = startupError.match(
        /Invalid environment configuration: ([A-Z0-9_, ]+)/,
      )?.[1];
      const hint = fields
        ? ` Invalid configuration fields: ${fields}.`
        : startupError.includes("EADDRINUSE")
          ? " Test port 3319 is occupied."
          : "";
      throw new Error(`E2E server exited before startup.${hint}`);
    }
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
  if (process.env.PRIVATEFLIX_E2E_MODE === "development") {
    // Compile protected bundles before measuring UI requests. No cookie is sent:
    // each handler must reject the request before validation or mutation.
    const sample = "00000000-0000-4000-8000-000000000001";
    const protectedRoutes = [
      ["GET", "/api/auth/session"],
      ["GET", "/api/auth/sessions"],
      ["GET", "/api/settings"],
      ["GET", "/api/library/summary"],
      ["GET", "/api/system/status"],
      ["GET", "/api/system/storage"],
      ["GET", "/api/media"],
      ["GET", "/api/collections"],
      ["GET", "/api/playback"],
      ["GET", "/api/playlists"],
      ["GET", "/api/media/uploads"],
      ["GET", "/api/media/upload-history"],
      ["GET", `/api/media/${sample}`],
      ["GET", `/api/media/${sample}/thumbnail`],
      ["GET", `/api/media/${sample}/stream`],
      ["GET", `/api/media/${sample}/download`],
      ["PUT", `/api/media/${sample}/favorite`],
      ["POST", `/api/media/${sample}/retry`],
      ["POST", "/api/media/bulk"],
      ["POST", "/api/media/duplicates"],
      ["POST", "/api/media/upload/start"],
      ["GET", `/api/media/upload/${sample}`],
      ["PUT", `/api/media/upload/${sample}/parts/1`],
      ["POST", `/api/media/upload/${sample}/complete`],
      ["POST", `/api/media/upload/${sample}/cancel`],
      ["PATCH", `/api/collections/${sample}`],
      ["PUT", `/api/collections/${sample}/items`],
      ["PUT", `/api/collections/${sample}/cover`],
      ["PUT", "/api/collections/layout"],
      ["GET", `/api/playlists/${sample}`],
      ["PUT", `/api/playlists/${sample}/items`],
      ["PUT", `/api/playlists/${sample}/order`],
      ["GET", `/api/playback/${sample}`],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/logout-all"],
    ];
    const deadline = Date.now() + 180000;
    for (const [method, path] of protectedRoutes) {
      if (Date.now() >= deadline)
        throw new Error("Development API compilation readiness timed out");
      const response = await fetch(`http://127.0.0.1:3319${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
        signal: AbortSignal.timeout(Math.min(60000, deadline - Date.now())),
      });
      await response.arrayBuffer();
      if (response.status !== 401)
        throw new Error(
          `Protected development readiness check returned ${response.status}: ${path}`,
        );
    }
    console.info(
      `Development API compilation ready (${protectedRoutes.length} unauthenticated checks).`,
    );
  }
  runner = launch([
    "node_modules/@playwright/test/cli.js",
    "test",
    ...process.argv.slice(2),
  ]);
  const code = await Promise.race([
    runner.exited,
    delay(180000, 124, { ref: false }),
  ]);
  if (code === 124) console.error("E2E runner exceeded its 180-second limit");
  process.exitCode = code;
} finally {
  await stop(runner);
  await stop(server);
}
