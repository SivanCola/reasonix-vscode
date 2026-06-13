import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  sourcesContent: false,
  logLevel: "info",
};

const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/webview.ts"],
    outfile: "media/webview.js",
    platform: "browser",
    format: "iife",
  },
  {
    ...common,
    entryPoints: ["test/jsonRpc.test.ts", "test/chatState.test.ts", "test/webviewProtocol.test.ts", "test/sanitize.test.ts", "test/keyboard.test.ts"],
    outdir: "dist/test",
    platform: "node",
    format: "cjs",
    external: ["node:test", "node:assert/strict"],
  },
  {
    ...common,
    entryPoints: ["test/vscode/runTest.ts", "test/vscode/suite/index.ts"],
    outdir: "dist/test/vscode",
    platform: "node",
    format: "cjs",
    external: ["vscode", "@vscode/test-electron"],
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((opts) => esbuild.context(opts)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("watching Reasonix VS Code extension sources...");
} else {
  await Promise.all(builds.map((opts) => esbuild.build(opts)));
}
