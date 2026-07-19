import test from "node:test";
import assert from "node:assert/strict";
import { parseWebviewMessage } from "../src/webviewProtocol";

test("parseWebviewMessage accepts valid prompt messages", () => {
  assert.deepEqual(parseWebviewMessage({ command: "sendPrompt", text: "hi" }), {
    command: "sendPrompt",
    text: "hi",
  });
  assert.deepEqual(parseWebviewMessage({ command: "sendPrompt", text: "hi", collaborationMode: "plan", tokenMode: "delivery", toolApprovalMode: "auto" }), {
    command: "sendPrompt",
    text: "hi",
    collaborationMode: "plan",
    tokenMode: "delivery",
    toolApprovalMode: "auto",
  });
  assert.deepEqual(parseWebviewMessage({ command: "sendPrompt", text: "legacy", tokenMode: "standard" }), {
    command: "sendPrompt",
    text: "legacy",
    tokenMode: "balanced",
  });
  assert.deepEqual(parseWebviewMessage({
    command: "sendPrompt",
    text: "",
    attachments: [
      { kind: "file", name: "a.ts", uri: "file:///a.ts", mimeType: "text/plain" },
      { kind: "session", name: "Fix bug", sessionId: "s-1" },
    ],
  }), {
    command: "sendPrompt",
    text: "",
    attachments: [
      { kind: "file", name: "a.ts", uri: "file:///a.ts", mimeType: "text/plain" },
      { kind: "session", name: "Fix bug", sessionId: "s-1" },
    ],
  });
  assert.deepEqual(parseWebviewMessage({ command: "pickAttachment" }), {
    command: "pickAttachment",
  });
});

test("parseWebviewMessage rejects malformed messages", () => {
  assert.equal(parseWebviewMessage({ command: "sendPrompt" }), undefined);
  assert.equal(parseWebviewMessage({ command: "approvalDecision", id: "1" }), undefined);
  assert.equal(parseWebviewMessage({ command: "unknown", text: "x" }), undefined);
  assert.equal(parseWebviewMessage(null), undefined);
  assert.equal(parseWebviewMessage({ command: "sendPrompt", text: "hi", attachments: "nope" }), undefined);
  assert.equal(parseWebviewMessage({ command: "sendPrompt", text: "hi", attachments: [{ kind: "folder", name: "src", uri: "file:///src" }] }), undefined);
  assert.equal(parseWebviewMessage({ command: "sendPrompt", text: "hi", attachments: [{ kind: "file", name: "a.ts" }] }), undefined);
  assert.equal(parseWebviewMessage({ command: "sendPrompt", text: "hi", attachments: [1, 2, 3, 4, 5, 6] }), undefined);
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
  assert.deepEqual(parseWebviewMessage({ command: "connect" }), {
    command: "connect",
  });
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
  assert.deepEqual(parseWebviewMessage({ command: "deleteSession", sessionId: "session-1" }), {
    command: "deleteSession",
    sessionId: "session-1",
  });
  assert.deepEqual(parseWebviewMessage({ command: "openToolPreview", index: 2 }), {
    command: "openToolPreview",
    index: 2,
  });
  assert.deepEqual(parseWebviewMessage({ command: "openToolLocation", index: 2, locationIndex: 0 }), {
    command: "openToolLocation",
    index: 2,
    locationIndex: 0,
  });
  assert.deepEqual(parseWebviewMessage({ command: "pickUiLanguage" }), {
    command: "pickUiLanguage",
  });
  assert.deepEqual(parseWebviewMessage({ command: "pickEffort" }), {
    command: "pickEffort",
  });
  assert.deepEqual(parseWebviewMessage({ command: "setModel", value: "deepseek/deepseek-chat" }), {
    command: "setModel",
    value: "deepseek/deepseek-chat",
  });
  assert.deepEqual(parseWebviewMessage({ command: "setEffort", optionId: "thought_level", value: "high" }), {
    command: "setEffort",
    optionId: "thought_level",
    value: "high",
  });
  assert.deepEqual(parseWebviewMessage({ command: "setExecutionMode", value: "goal" }), {
    command: "setExecutionMode",
    value: "goal",
  });
  assert.deepEqual(parseWebviewMessage({ command: "setWorkMode", optionId: "work_mode", value: "delivery" }), {
    command: "setWorkMode",
    optionId: "work_mode",
    value: "delivery",
  });
  assert.deepEqual(parseWebviewMessage({ command: "setToolApprovalMode", optionId: "tool_approval", value: "auto" }), {
    command: "setToolApprovalMode",
    optionId: "tool_approval",
    value: "auto",
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
  assert.equal(parseWebviewMessage({ command: "setModel", value: "" }), undefined);
  assert.equal(parseWebviewMessage({ command: "setModel", value: "x".repeat(241) }), undefined);
  assert.equal(parseWebviewMessage({ command: "setEffort", optionId: "", value: "high" }), undefined);
  assert.equal(parseWebviewMessage({ command: "setEffort", optionId: "effort", value: "" }), undefined);
  assert.equal(parseWebviewMessage({ command: "setExecutionMode", value: "auto" }), undefined);
  assert.equal(parseWebviewMessage({ command: "setWorkMode", optionId: "work_mode", value: "standard" }), undefined);
  assert.equal(parseWebviewMessage({ command: "setToolApprovalMode", optionId: "tool_approval", value: "always" }), undefined);
});
