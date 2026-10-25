import { build } from "esbuild";
await build({
  entryPoints: ["src/worker/main.ts"],
  outfile: "dist/worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  packages: "external",
  plugins: [
    {
      name: "server-only-worker",
      setup(build) {
        build.onResolve({ filter: /^server-only$/ }, () => ({
          path: "server-only",
          namespace: "worker",
        }));
        build.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
          contents: "",
          loader: "js",
        }));
      },
    },
  ],
});
