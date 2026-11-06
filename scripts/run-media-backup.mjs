import { spawn } from "node:child_process";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/lib/backup/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  packages: "external",
  write: false,
  alias: { "server-only": "./scripts/server-only-stub.mjs" },
});
const runner = spawn(
  process.execPath,
  ["--input-type=commonjs", "-", ...process.argv.slice(2)],
  { stdio: ["pipe", "inherit", "inherit"] },
);
runner.once("error", () => {
  console.error("Could not start the media backup tool.");
  process.exitCode = 1;
});
runner.stdin.on("error", () => {
  process.exitCode = 1;
});
runner.once("exit", (code) => {
  if (code !== 0) process.exitCode = code ?? 1;
});
runner.stdin.end(outputFiles[0].contents);
