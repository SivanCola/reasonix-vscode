#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const vsixPath = process.argv[2] || "dist/reasonix-vscode.vsix";

if (!existsSync(vsixPath)) {
  console.error(`VSIX not found: ${vsixPath}`);
  process.exit(1);
}

let files;
try {
  files = execFileSync("unzip", ["-Z1", vsixPath], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
} catch (err) {
  console.error(`Failed to inspect VSIX ${vsixPath}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const fileSet = new Set(files);
const required = [
  "extension/package.json",
  "extension/readme.md",
  "extension/README.zh-CN.md",
  "extension/changelog.md",
  "extension/LICENSE.txt",
  "extension/dist/extension.js",
  "extension/media/webview.js",
  "extension/media/styles.css",
  "extension/media/icon.svg",
  "extension/media/icon.png",
  "extension/scripts/acp-smoke.mjs",
  "extension/scripts/verify-vsix-contents.mjs",
];

const forbidden = [
  /^extension\/src\//,
  /^extension\/test\//,
  /^extension\/designs\//,
  /^extension\/\.github\//,
  /^extension\/\.codegraph\//,
  /^extension\/node_modules\//,
  /^extension\/reasonix\.toml$/,
];

const missing = required.filter((file) => !fileSet.has(file));
const forbiddenMatches = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));

if (missing.length > 0 || forbiddenMatches.length > 0) {
  if (missing.length > 0) {
    console.error("Missing required VSIX files:");
    for (const file of missing) {
      console.error(`- ${file}`);
    }
  }
  if (forbiddenMatches.length > 0) {
    console.error("Forbidden files included in VSIX:");
    for (const file of forbiddenMatches) {
      console.error(`- ${file}`);
    }
  }
  process.exit(1);
}

console.log(`VSIX content check passed: ${vsixPath}`);
console.log(`Checked ${files.length} packaged files.`);
