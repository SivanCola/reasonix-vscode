import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildPromptBlocks, mentionTokenForPath, resolveFileMentions } from "../src/resourceMentions";

test("mentionTokenForPath keeps non-ASCII paths readable", () => {
  assert.equal(mentionTokenForPath("src/file.ts", false), "src/file.ts");
  assert.equal(mentionTokenForPath("明星合集类/旁白分析/字幕.srt", false), "明星合集类/旁白分析/字幕.srt");
  assert.equal(mentionTokenForPath("src/dir", true), "src/dir/");
  assert.equal(mentionTokenForPath("", true), "./");
  assert.equal(mentionTokenForPath("README", false), "./README");
});

test("mentionTokenForPath quotes only token-breaking characters", () => {
  assert.equal(mentionTokenForPath("a b/c d.txt", false), "\"a b/c d.txt\"");
  assert.equal(mentionTokenForPath("Jim Carrey's cut (final).txt", false), "\"Jim Carrey's cut (final).txt\"");
  assert.equal(mentionTokenForPath("a\"b.txt", false), "'a\"b.txt'");
  // "%" cannot survive decodeURIComponent verbatim, so it falls back to percent encoding.
  assert.equal(mentionTokenForPath("100% done.txt", false), "100%25%20done.txt");
  assert.equal(mentionTokenForPath("明星合集类/旁白分析/Jim Carrey Crashes Jeff Daniels' CONAN Interview.srt", false), "\"明星合集类/旁白分析/Jim Carrey Crashes Jeff Daniels' CONAN Interview.srt\"");
});

test("mentionTokenForPath tokens resolve back to the original path", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.mkdir(path.join(workspace, "明星合集类"), { recursive: true });
  await fs.writeFile(path.join(workspace, "明星合集类", "a b.txt"), "hello\n");

  const token = mentionTokenForPath("明星合集类/a b.txt", false);
  assert.equal(token, "\"明星合集类/a b.txt\"");

  const mentions = await resolveFileMentions(`check @${token}`, workspace);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].relativePath, "明星合集类/a b.txt");
  assert.match(mentions[0].text, /hello/);
});

test("resolveFileMentions resolves quoted tokens with quotes inside", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-mentions-"));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "Jim's file.txt"), "quoted content\n");

  const mentions = await resolveFileMentions("check @\"src/Jim's file.txt\"", workspace);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].relativePath, "src/Jim's file.txt");
  assert.match(mentions[0].text, /quoted content/);
});

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
