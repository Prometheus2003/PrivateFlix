import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const docker =
  process.env.DOCKER_BIN ??
  (process.platform === "win32"
    ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe"
    : "docker");
const name = "privateflix-storage-test-" + randomBytes(6).toString("hex");
const directory = mkdtempSync(join(tmpdir(), "privateflix-storage-test-"));
const envFile = join(directory, "container.env");
const access = randomBytes(16).toString("hex"),
  secret = randomBytes(32).toString("hex");
writeFileSync(
  envFile,
  "MINIO_ROOT_USER=" + access + "\nMINIO_ROOT_PASSWORD=" + secret + "\n",
  { mode: 0o600 },
);
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Test command failed with exit " + code)),
    );
  });
}
let started = false;
try {
  await run(docker, [
    "run",
    "--rm",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1:19000:9000",
    "--env-file",
    envFile,
    "privateflix-minio:2025-10-15",
  ]);
  started = true;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      if (
        (
          await fetch("http://127.0.0.1:19000/minio/health/live", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  if (!ready) throw new Error("Isolated MinIO startup timed out");
  const env = {
    ...process.env,
    PRIVATEFLIX_STORAGE_TEST: "1",
    S3_ENDPOINT: "http://127.0.0.1:19000",
    S3_ACCESS_KEY: access,
    S3_SECRET_KEY: secret,
    S3_BUCKET: "privateflix-test-http",
  };
  await run(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/integration/storage-live.test.ts",
    ],
    env,
  );
  if (process.env.PRIVATEFLIX_SECURITY_TEST === "1")
    await run(process.execPath, ["scripts/test-e2e.mjs"], env);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Storage verification failed",
  );
  process.exitCode = 1;
} finally {
  if (started)
    await run(docker, ["stop", name]).catch(() => {
      console.error("Could not stop test container: " + name);
      process.exitCode = 1;
    });
  // This directory contains only the generated test credential file created above.
  rmSync(envFile, { force: true });
  rmdirSync(directory);
}
