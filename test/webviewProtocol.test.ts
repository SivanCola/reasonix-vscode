import test from "node:test";
import assert from "node:assert/strict";
import { parseWebviewMessage } from "../src/webviewProtocol";

test("parseWebviewMessage accepts valid prompt messages", () => {
  assert.deepEqual(parseWebviewMessage({ command: "sendPrompt", text: "hi" }), {
    command: "sendPrompt",
    text: "hi",
  });
  assert.deepEqual(parseWebviewMessage({ command: "sendPrompt", text: "hi", collaborationMode: "plan", tokenMode: "economy", toolApprovalMode: "auto" }), {
    command: "sendPrompt",
    text: "hi",
    collaborationMode: "plan",
    tokenMode: "economy",
    toolApprovalMode: "auto",
  });
});

test("parseWebviewMessage rejects malformed messages", () => {
  assert.equal(parseWebviewMessage({ command: "sendPrompt" }), undefined);
  assert.equal(parseWebviewMessage({ command: "approvalDecision", id: "1" }), undefined);
  assert.equal(parseWebviewMessage({ command: "unknown", text: "x" }), undefined);
  assert.equal(parseWebviewMessage(null), undefined);
  assert.deepEqual(parseWebviewMessage({ command: "sendPrompt", text: "hi", collaborationMode: "bad", tokenMode: "bad", toolApprovalMode: "bad" }), {
    command: "sendPrompt",
    text: "hi",
  });
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
  assert.deepEqual(parseWebviewMessage({ command: "pickUiLanguage" }), {
    command: "pickUiLanguage",
  });
  assert.deepEqual(parseWebviewMessage({ command: "pickEffort" }), {
    command: "pickEffort",
  });
  assert.deepEqual(parseWebviewMessage({ command: "openNativeSettings" }), {
    command: "openNativeSettings",
  });
  assert.deepEqual(parseWebviewMessage({ command: "resourceSuggestions", requestId: 2, query: "src/we" }), {
    command: "resourceSuggestions",
    requestId: 2,
    query: "src/we",
  });
  assert.deepEqual(parseWebviewMessage({ command: "updateSetting", key: "uiLanguage", value: "zh-CN" }), {
    command: "updateSetting",
    key: "uiLanguage",
    value: "zh-CN",
  });
  assert.deepEqual(parseWebviewMessage({ command: "updateSetting", key: "trace", value: true }), {
    command: "updateSetting",
    key: "trace",
    value: true,
  });
});

test("parseWebviewMessage rejects malformed product UI commands", () => {
  assert.equal(parseWebviewMessage({ command: "setContextMode", mode: "fullFile" }), undefined);
  assert.equal(parseWebviewMessage({ command: "quickPrompt", action: "deleteRepo" }), undefined);
  assert.equal(parseWebviewMessage({ command: "loadSession", sessionId: "" }), undefined);
  assert.equal(parseWebviewMessage({ command: "retryMessage", index: -1 }), undefined);
  assert.equal(parseWebviewMessage({ command: "insertMessage", index: 1.5 }), undefined);
  assert.equal(parseWebviewMessage({ command: "resourceSuggestions", requestId: -1, query: "src" }), undefined);
  assert.equal(parseWebviewMessage({ command: "resourceSuggestions", requestId: 1, query: "x".repeat(241) }), undefined);
  assert.equal(parseWebviewMessage({ command: "updateSetting", key: "trace", value: "true" }), undefined);
  assert.equal(parseWebviewMessage({ command: "updateSetting", key: "uiLanguage", value: "fr" }), undefined);
  assert.equal(parseWebviewMessage({ command: "updateSetting", key: "unknown", value: true }), undefined);
});
