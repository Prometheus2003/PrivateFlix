import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const bin = "node_modules/next/dist/bin/next";
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000),
  ]);
}
const invalid = spawn(
  process.execPath,
  [bin, "start", "--hostname", "127.0.0.1", "--port", "3317"],
  {
    env: {
      ...process.env,
      SESSION_SECRET: "invalid-secret-for-startup-check",
      APP_URL: "https://localhost:3317",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let invalidLog = "";
invalid.stdout.on("data", (data) => {
  invalidLog += data;
});
invalid.stderr.on("data", (data) => {
  invalidLog += data;
});
try {
  const exit = await Promise.race([
    new Promise((resolve) => invalid.once("exit", (code) => resolve(code))),
    delay(30000).then(() => "timeout"),
  ]);
  if (
    exit === "timeout" ||
    exit === 0 ||
    !invalidLog.includes("SESSION_SECRET") ||
    invalidLog.includes("invalid-secret-for-startup-check")
  )
    throw new Error("Invalid configuration startup/redaction check failed");
  console.log("PASS: invalid configuration refuses startup and redacts values");
} finally {
  await stop(invalid);
}
const server = spawn(
  process.execPath,
  [bin, "start", "--hostname", "127.0.0.1", "--port", "3317"],
  {
    env: { ...process.env, APP_URL: "https://localhost:3317" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.resume();
server.stderr.resume();
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null)
      throw new Error("Server exited before startup");
    try {
      const response = await fetch("http://127.0.0.1:3317/", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  if (!ready) throw new Error("Startup timed out");
  for (const [path, expected] of [
    ["/", 200],
    ["/api/auth/session", 401],
    ["/api/system/health", 200],
  ]) {
    const response = await fetch("http://127.0.0.1:3317" + path, {
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== expected)
      throw new Error(`Unexpected ${path} status ${response.status}`);
    if (
      path.includes("session") &&
      !response.headers.get("cache-control")?.includes("no-store")
    )
      throw new Error("Missing session privacy header");
    console.log(`PASS: ${path} returns ${expected}`);
  }
} finally {
  await stop(server);
}
