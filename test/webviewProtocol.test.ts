import test from "node:test";
import assert from "node:assert/strict";
import { parseWebviewMessage } from "../src/webviewProtocol";

test("parseWebviewMessage accepts valid prompt messages", () => {
  assert.deepEqual(parseWebviewMessage({ command: "sendPrompt", text: "hi" }), {
    command: "sendPrompt",
    text: "hi",
  });
});

test("parseWebviewMessage rejects malformed messages", () => {
  assert.equal(parseWebviewMessage({ command: "sendPrompt" }), undefined);
  assert.equal(parseWebviewMessage({ command: "approvalDecision", id: "1" }), undefined);
  assert.equal(parseWebviewMessage({ command: "unknown", text: "x" }), undefined);
  assert.equal(parseWebviewMessage(null), undefined);
});

test("parseWebviewMessage accepts approval decisions with stable ids", () => {
  assert.deepEqual(parseWebviewMessage({ command: "approvalDecision", id: "gate-1", optionId: "allow_once" }), {
    command: "approvalDecision",
    id: "gate-1",
    optionId: "allow_once",
  });
});

test("parseWebviewMessage accepts pickModel", () => {
  assert.deepEqual(parseWebviewMessage({ command: "pickModel" }), { command: "pickModel" });
});

test("parseWebviewMessage accepts openPreview with valid id", () => {
  assert.deepEqual(parseWebviewMessage({ command: "openPreview", id: "tool-1" }), {
    command: "openPreview",
    id: "tool-1",
  });
});

test("parseWebviewMessage rejects openPreview without id", () => {
  assert.equal(parseWebviewMessage({ command: "openPreview" }), undefined);
  assert.equal(parseWebviewMessage({ command: "openPreview", id: 123 }), undefined);
});
