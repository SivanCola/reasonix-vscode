import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildPromptBlocks, resolveFileMentions } from "../src/resourceMentions";

test("resolveFileMentions reads workspace-relative @ file references", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, "src", "sample.ts"), "export const answer = 42;\n");

  const mentions = await resolveFileMentions("please review @src/sample.ts", workspace);

  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].relativePath, "src/sample.ts");
  assert.match(mentions[0].text, /answer = 42/);
});

test("resolveFileMentions appends bounded directory listings", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "src", "nested"));
  await fs.writeFile(path.join(workspace, "src", "sample.ts"), "const answer = 42;\n");

  const mentions = await resolveFileMentions("map @src/", workspace);

  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].kind, "directory");
  assert.equal(mentions[0].relativePath, "src");
  assert.match(mentions[0].text, /nested\//);
  assert.match(mentions[0].text, /sample\.ts/);
  assert.doesNotMatch(mentions[0].text, /const answer = 42/);
});

test("buildPromptBlocks emits ACP resource blocks instead of prompt XML", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.writeFile(path.join(workspace, "sample.ts"), "const answer = 42;\n");

  const result = await buildPromptBlocks("explain @sample.ts", workspace);

  assert.equal(result.blocks[0]?.type, "text");
  assert.equal(result.blocks[1]?.type, "resource");
  assert.match(result.blocks[1]?.type === "resource" ? result.blocks[1].resource.uri : "", /^file:/);
  assert.match(result.blocks[1]?.type === "resource" ? result.blocks[1].resource.text ?? "" : "", /File: sample\.ts[\s\S]*answer = 42/);
  assert.doesNotMatch(JSON.stringify(result.blocks), /reasonix_file_mentions/);
});

test("resolveFileMentions does not follow symlinks outside the workspace", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation requires extra privileges on Windows");
    return;
  }
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-outside-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(workspace, "escape.txt"));

  assert.deepEqual(await resolveFileMentions("read @escape.txt", workspace), []);
});

test("resolveFileMentions ignores non-path mentions and traversal", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.writeFile(path.join(workspace, "sample.ts"), "const answer = 42;\n");

  const mentions = await resolveFileMentions("talk to @alice and ignore @../sample.ts", workspace);

  assert.deepEqual(mentions, []);
});
