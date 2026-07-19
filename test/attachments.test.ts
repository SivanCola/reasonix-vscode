import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentToBlock,
  isPendingAttachment,
  mimeFromFileName,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_TEXT_BYTES,
  type PendingAttachment,
} from "../src/attachments";

const readFileStub = async (_uri: string): Promise<Uint8Array> => new TextEncoder().encode("hello");

test("mimeFromFileName detects images and falls back to text/plain", () => {
  assert.equal(mimeFromFileName("shot.png"), "image/png");
  assert.equal(mimeFromFileName("photo.JPG"), "image/jpeg");
  assert.equal(mimeFromFileName("icon.jpeg"), "image/jpeg");
  assert.equal(mimeFromFileName("anim.gif"), "image/gif");
  assert.equal(mimeFromFileName("notes.md"), "text/plain");
  assert.equal(mimeFromFileName("LICENSE"), "text/plain");
});

test("isPendingAttachment validates shape per kind", () => {
  assert.equal(isPendingAttachment({ kind: "file", name: "a.ts", uri: "file:///a.ts" }), true);
  assert.equal(isPendingAttachment({ kind: "image", name: "a.png", uri: "file:///a.png", mimeType: "image/png" }), true);
  assert.equal(isPendingAttachment({ kind: "session", name: "Fix bug", sessionId: "s-1" }), true);
  assert.equal(isPendingAttachment({ kind: "file", name: "a.ts" }), false);
  assert.equal(isPendingAttachment({ kind: "session", name: "Fix bug" }), false);
  assert.equal(isPendingAttachment({ kind: "folder", name: "src", uri: "file:///src" }), false);
  assert.equal(isPendingAttachment({ kind: "file", name: "", uri: "file:///a" }), false);
  assert.equal(isPendingAttachment(null), false);
});

test("attachmentToBlock builds a session reference without reading files", async () => {
  const attachment: PendingAttachment = { kind: "session", name: "Fix bug", sessionId: "s-1" };
  let reads = 0;
  const block = await attachmentToBlock(attachment, async () => {
    reads += 1;
    return new Uint8Array();
  });
  assert.equal(reads, 0);
  assert.deepEqual(block, {
    type: "resource",
    resource: {
      uri: "session://s-1",
      mimeType: "text/plain",
      text: "Referenced session: Fix bug (session s-1)",
    },
  });
});

test("attachmentToBlock embeds text file contents as a resource", async () => {
  const attachment: PendingAttachment = { kind: "file", name: "notes.md", uri: "file:///notes.md" };
  const block = await attachmentToBlock(attachment, readFileStub);
  assert.deepEqual(block, {
    type: "resource",
    resource: {
      uri: "file:///notes.md",
      mimeType: "text/plain",
      text: "File: notes.md\nhello",
    },
  });
});

test("attachmentToBlock truncates oversized text files", async () => {
  const attachment: PendingAttachment = { kind: "file", name: "big.log", uri: "file:///big.log" };
  const big = new Uint8Array(MAX_ATTACHMENT_TEXT_BYTES + 10).fill(97);
  const block = await attachmentToBlock(attachment, async () => big);
  assert.equal(block.type, "resource");
  if (block.type !== "resource") {
    return;
  }
  assert.match(block.resource.text ?? "", /^File: big\.log \(truncated\)\n/);
  assert.equal((block.resource.text ?? "").length, `File: big.log (truncated)\n`.length + MAX_ATTACHMENT_TEXT_BYTES);
});

test("attachmentToBlock encodes images as base64 image blocks", async () => {
  const attachment: PendingAttachment = { kind: "image", name: "shot.png", uri: "file:///shot.png", mimeType: "image/png" };
  const bytes = new TextEncoder().encode("fake-png-bytes");
  const block = await attachmentToBlock(attachment, async () => bytes);
  assert.equal(block.type, "image");
  if (block.type !== "image") {
    return;
  }
  assert.equal(block.mimeType, "image/png");
  assert.equal(Buffer.from(block.data, "base64").toString("utf8"), "fake-png-bytes");
});

test("attachmentToBlock rejects oversized images", async () => {
  const attachment: PendingAttachment = { kind: "image", name: "huge.png", uri: "file:///huge.png", mimeType: "image/png" };
  const big = new Uint8Array(MAX_ATTACHMENT_IMAGE_BYTES + 1);
  await assert.rejects(() => attachmentToBlock(attachment, async () => big), /Image too large/);
});

test("attachmentToBlock infers image kind from mime when kind is file", async () => {
  const attachment: PendingAttachment = { kind: "file", name: "shot.png", uri: "file:///shot.png", mimeType: "image/png" };
  const block = await attachmentToBlock(attachment, async () => new TextEncoder().encode("x"));
  assert.equal(block.type, "image");
});
