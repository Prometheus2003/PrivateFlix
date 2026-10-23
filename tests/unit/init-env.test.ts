import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("generates unique secrets without printing them and refuses overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "privateflix-env-test-"));
  try {
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts", "init-env.mjs");
    copyFileSync(resolve("scripts/init-env.mjs"), script);
    const first = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(first.status).toBe(0);
    const content = readFileSync(join(root, ".env"), "utf8");
    const secrets = [
      ...content.matchAll(
        /^(?:POSTGRES_PASSWORD|S3_ACCESS_KEY|S3_SECRET_KEY|REDIS_PASSWORD|SESSION_SECRET)=(.+)$/gm,
      ),
    ].map((match) => match[1]);
    expect(secrets).toHaveLength(5);
    expect(new Set(secrets).size).toBe(5);
    for (const secret of secrets) {
      expect(secret).toMatch(/^[a-f0-9]{32,128}$/);
      expect(first.stdout + first.stderr).not.toContain(secret);
    }
    const second = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(second.status).toBe(1);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(content);
  } finally {
    // Only the unique directory created by this test is removed.
    rmSync(root, { recursive: true, force: true });
  }
});
