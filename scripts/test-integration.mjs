import { spawnSync } from "node:child_process";
const database = process.env.DATABASE_URL;
if (!database || new URL(database).pathname !== "/privateflix_security_test") {
  console.error(
    "Set DATABASE_URL to a disposable database named privateflix_security_test. This command resets its test records.",
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/integration/security.test.ts",
      "tests/integration/upload.test.ts",
      "tests/integration/multipart.test.ts",
      "tests/integration/processing.test.ts",
      "tests/integration/streaming.test.ts",
      "tests/integration/drive-registry.test.ts",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, PRIVATEFLIX_SECURITY_TEST: "1" },
    },
  );
  process.exitCode = result.status ?? 1;
}
