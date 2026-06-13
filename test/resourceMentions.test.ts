import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendFileMentions, resolveFileMentions } from "../src/resourceMentions";

test("resolveFileMentions reads workspace-relative @ file references", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, "src", "sample.ts"), "export const answer = 42;\n");

  const mentions = await resolveFileMentions("please review @src/sample.ts", workspace);

  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].relativePath, "src/sample.ts");
  assert.match(mentions[0].text, /answer = 42/);
});

test("appendFileMentions appends bounded file context blocks", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.writeFile(path.join(workspace, "sample.ts"), "const answer = 42;\n");

  const result = await appendFileMentions("explain @sample.ts", workspace);

  assert.match(result.prompt, /<reasonix_file_mentions>/);
  assert.match(result.prompt, /<file path="sample\.ts">/);
  assert.match(result.prompt, /const answer = 42/);
});

test("appendFileMentions appends bounded directory listings", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "src", "nested"));
  await fs.writeFile(path.join(workspace, "src", "sample.ts"), "const answer = 42;\n");

  const result = await appendFileMentions("map @src/", workspace);

  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0].kind, "directory");
  assert.equal(result.mentions[0].relativePath, "src");
  assert.match(result.prompt, /<directory path="src">/);
  assert.match(result.prompt, /nested\//);
  assert.match(result.prompt, /sample\.ts/);
  assert.doesNotMatch(result.prompt, /const answer = 42/);
});

test("resolveFileMentions ignores non-path mentions and traversal", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.writeFile(path.join(workspace, "sample.ts"), "const answer = 42;\n");

  const mentions = await resolveFileMentions("talk to @alice and ignore @../sample.ts", workspace);

  assert.deepEqual(mentions, []);
});
