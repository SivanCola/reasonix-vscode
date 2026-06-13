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

test("parseWebviewMessage accepts product UI commands", () => {
  assert.deepEqual(parseWebviewMessage({ command: "setContextMode", mode: "nearby" }), {
    command: "setContextMode",
    mode: "nearby",
  });
  assert.deepEqual(parseWebviewMessage({ command: "quickPrompt", action: "fixSelection" }), {
    command: "quickPrompt",
    action: "fixSelection",
  });
  assert.deepEqual(parseWebviewMessage({ command: "loadSession", sessionId: "session-1" }), {
    command: "loadSession",
    sessionId: "session-1",
  });
  assert.deepEqual(parseWebviewMessage({ command: "openToolPreview", index: 2 }), {
    command: "openToolPreview",
    index: 2,
  });
});

test("parseWebviewMessage rejects malformed product UI commands", () => {
  assert.equal(parseWebviewMessage({ command: "setContextMode", mode: "fullFile" }), undefined);
  assert.equal(parseWebviewMessage({ command: "quickPrompt", action: "deleteRepo" }), undefined);
  assert.equal(parseWebviewMessage({ command: "loadSession", sessionId: "" }), undefined);
  assert.equal(parseWebviewMessage({ command: "retryMessage", index: -1 }), undefined);
  assert.equal(parseWebviewMessage({ command: "insertMessage", index: 1.5 }), undefined);
});
