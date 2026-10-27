import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const docker =
  process.env.DOCKER_BIN ??
  (process.platform === "win32"
    ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe"
    : "docker");
const prefix = "privateflix-processing-test-" + randomBytes(6).toString("hex");
const directory = mkdtempSync(join(tmpdir(), prefix));
const password = randomBytes(32).toString("hex"),
  access = randomBytes(16).toString("hex");
const containers = [];
let network = false;
function run(command, args, env = process.env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env,
    });
    const chunks = [];
    let bytes = 0;
    child.stdout?.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("Verification command failed: " + code)),
    );
  });
}
function envFile(name, values) {
  const path = join(directory, name + ".env");
  writeFileSync(
    path,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    { mode: 0o600 },
  );
  return path;
}
async function container(name, args) {
  const full = prefix + "-" + name;
  await run(docker, [
    "run",
    "--rm",
    "-d",
    "--name",
    full,
    "--network",
    prefix,
    ...args,
  ]);
  containers.push(full);
  return full;
}
try {
  await run(docker, ["network", "create", prefix]);
  network = true;
  const pg = await container("pg", [
    "-p",
    "127.0.0.1:55434:5432",
    "--env-file",
    envFile("pg", {
      POSTGRES_PASSWORD: password,
      POSTGRES_USER: "privateflix",
      POSTGRES_DB: "privateflix_security_test",
    }),
    "postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
  ]);
  const redis = await container("redis", [
    "redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499",
    "redis-server",
    "--maxmemory-policy",
    "noeviction",
  ]);
  const minio = await container("minio", [
    "-p",
    "127.0.0.1:19000:9000",
    "--env-file",
    envFile("minio", {
      MINIO_ROOT_USER: access,
      MINIO_ROOT_PASSWORD: password,
    }),
    "privateflix-minio:2025-10-15",
  ]);
  const env = {
    ...process.env,
    STORAGE_PROVIDER: "s3",
    GOOGLE_DRIVE_CLIENT_ID: "",
    GOOGLE_DRIVE_CLIENT_SECRET: "",
    GOOGLE_DRIVE_REFRESH_TOKEN: "",
    GOOGLE_DRIVE_FOLDER_ID: "",
    NODE_ENV: "test",
    PRIVATEFLIX_BUILD_DIR: ".next-verify",
    PRIVATEFLIX_SECURITY_TEST: "1",
    DATABASE_URL: `postgresql://privateflix:${password}@127.0.0.1:55434/privateflix_security_test`,
    S3_ENDPOINT: "http://127.0.0.1:19000",
    S3_ACCESS_KEY: access,
    S3_SECRET_KEY: password,
    S3_BUCKET: "privateflix-processing-test",
    REDIS_URL: `redis://${redis}:6379`,
    SESSION_SECRET: randomBytes(64).toString("hex"),
    APP_URL: "https://privateflix.test",
    FFMPEG_TIMEOUT: "30",
  };
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await run(
        docker,
        ["exec", pg, "pg_isready", "-U", "privateflix"],
        process.env,
        true,
      );
      if (
        (
          await fetch(env.S3_ENDPOINT + "/minio/health/live", {
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
  if (!ready) throw new Error("Test services failed to become ready");
  await run(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    env,
  );
  if (!["browser", "worker"].includes(process.env.PRIVATEFLIX_TEST_FOCUS)) {
    await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run"], env);
  } else {
    console.info("Focused verification; unit/database suite is not rerun.");
  }
  // Generate actual decoder fixtures with an isolated, credential-free FFmpeg process.
  for (const type of ["png", "mp4"]) {
    const args =
      type === "png"
        ? ["-frames:v", "1", "-c:v", "png", "-f", "image2pipe"]
        : [
            "-t",
            "12",
            "-c:v",
            "libx264",
            "-movflags",
            "frag_keyframe+empty_moov",
            "-f",
            "mp4",
          ];
    const fixture = await run(
      docker,
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "ffmpeg",
        "privateflix-worker:local",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=purple:s=320x240:r=10",
        "-threads",
        "1",
        ...args,
        "pipe:1",
      ],
      process.env,
      true,
    );
    writeFileSync(join(directory, "fixture." + type), fixture);
  }
  const workerEnv = {
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://privateflix:${password}@${pg}:5432/privateflix_security_test`,
    S3_ENDPOINT: `http://${minio}:9000`,
    S3_ACCESS_KEY: access,
    S3_SECRET_KEY: password,
    S3_BUCKET: env.S3_BUCKET,
    REDIS_URL: env.REDIS_URL,
    SESSION_SECRET: env.SESSION_SECRET,
    APP_URL: env.APP_URL,
    FFMPEG_TIMEOUT: "30",
  };
  // Verify the current worker source, rather than a stale locally tagged image.
  await run(docker, [
    "build",
    "--file",
    "deploy/Dockerfile.worker",
    "--tag",
    "privateflix-worker:local",
    ".",
  ]);
  await container("worker", [
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/work:uid=1000,gid=1000,mode=700,size=64m",
    "--tmpfs",
    "/tmp:size=64m",
    "--env-file",
    envFile("worker", workerEnv),
    "privateflix-worker:local",
  ]);
  await run(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/integration/processing-live.test.ts",
    ],
    {
      ...env,
      PRIVATEFLIX_PROCESSING_TEST: "1",
      PRIVATEFLIX_FIXTURES: directory,
    },
  );
  const modes =
    process.env.PRIVATEFLIX_TEST_FOCUS === "worker"
      ? []
      : process.env.PRIVATEFLIX_E2E_MODE
        ? [process.env.PRIVATEFLIX_E2E_MODE]
        : ["production", "development"];
  // Browser verification must exercise this source tree, never a stale build.
  if (modes.includes("production")) {
    await run(
      process.execPath,
      ["node_modules/next/dist/bin/next", "build", "--webpack"],
      { ...env, NODE_ENV: "production" },
    );
  }
  for (const mode of modes) {
    console.info("Playback browser verification: " + mode);
    await run(
      process.execPath,
      [
        "scripts/test-e2e.mjs",
        "tests/e2e/processing.spec.ts",
        "tests/e2e/playlists.spec.ts",
        "tests/e2e/photos.spec.ts",
        "tests/e2e/bulk.spec.ts",
      ],
      { ...env, PRIVATEFLIX_E2E_MODE: mode, PRIVATEFLIX_PROCESSING_TEST: "1" },
    );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Processing verification failed",
  );
  process.exitCode = 1;
} finally {
  for (const name of containers.reverse())
    await run(docker, ["stop", "-t", "10", name]).catch(() => {
      process.exitCode = 1;
    });
  if (network)
    await run(docker, ["network", "rm", prefix]).catch(() => {
      process.exitCode = 1;
    });
  // Only this script's freshly created temporary directory is removed.
  rmSync(directory, { recursive: true, force: true });
}
