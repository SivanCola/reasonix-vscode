import test from "node:test";
import assert from "node:assert/strict";
import { applySessionUpdate, type ChatItem } from "../src/chatState";

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
