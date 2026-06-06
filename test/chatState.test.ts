import test from "node:test";
import assert from "node:assert/strict";
import { appendApproval, applySessionUpdate, resolveApproval, type ChatItem } from "../src/chatState";

test("applySessionUpdate appends streamed assistant chunks", () => {
  const items: ChatItem[] = [];
  applySessionUpdate(items, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } });
  applySessionUpdate(items, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });

  assert.deepEqual(items, [{ type: "message", role: "assistant", text: "hello" }]);
});

test("applySessionUpdate tracks tool lifecycle", () => {
  const items: ChatItem[] = [];
  applySessionUpdate(items, {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "read_file",
    kind: "read",
    status: "pending",
    rawInput: { path: "README.md" },
  });
  applySessionUpdate(items, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "ok" } }],
  });

  assert.deepEqual(items, [
    {
      type: "tool",
      id: "call-1",
      title: "read_file",
      kind: "read",
      status: "completed",
      rawInput: { path: "README.md" },
      content: "ok",
    },
  ]);
});

test("applySessionUpdate records usage updates compactly", () => {
  const items: ChatItem[] = [];
  applySessionUpdate(items, {
    sessionUpdate: "usage",
    usage: {
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
      cacheHitTokens: 80,
      cacheMissTokens: 20,
      sessionCacheHitTokens: 180,
      sessionCacheMissTokens: 20,
    },
  });
  applySessionUpdate(items, {
    sessionUpdate: "usage",
    usage: {
      promptTokens: 200,
      completionTokens: 50,
      totalTokens: 250,
      cacheHitTokens: 100,
      cacheMissTokens: 100,
      sessionCacheHitTokens: 280,
      sessionCacheMissTokens: 120,
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.type, "usage");
  assert.equal(items[0]?.type === "usage" ? items[0].usage.totalTokens : 0, 250);
});

test("appendApproval and resolveApproval track inline approval state", () => {
  const items: ChatItem[] = [];
  appendApproval(items, {
    sessionId: "s1",
    toolCall: {
      toolCallId: "approval-1",
      title: "edit_file",
      kind: "edit",
      rawInput: { path: "src/app.ts" },
      preview: { path: "src/app.ts", kind: "edit", added: 1, removed: 1, diff: "@@ -1 +1 @@" },
    },
    options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
  });

  assert.equal(items[0]?.type, "approval");
  assert.equal(items[0]?.type === "approval" ? items[0].status : "", "pending");

  resolveApproval(items, "approval-1", true);
  assert.equal(items[0]?.type === "approval" ? items[0].status : "", "selected");
});
