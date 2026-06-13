#!/usr/bin/env node
const fs = require("node:fs");

const logPath = process.env.REASONIX_FAKE_LOG;
let buffer = "";
let sessionId = "fake-session";
let nextRequestId = 1000;
let pendingSlowPromptId;
const pendingPermissions = new Map();

function log(event) {
  if (!logPath) {
    return;
  }
  fs.appendFileSync(logPath, JSON.stringify(event) + "\n");
}

log({ method: "process/start", argv: process.argv.slice(2), cwd: process.cwd() });

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function notify(method, params) {
  write({ method, params });
}

function result(id, value) {
  write({ id, result: value });
}

function error(id, code, message) {
  write({ id, error: { code, message } });
}

function handle(message) {
  if (!message.method && pendingPermissions.has(message.id)) {
    const pending = pendingPermissions.get(message.id);
    pendingPermissions.delete(message.id);
    log({ method: "permission/response", response: message, toolCallId: pending.toolCallId });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: pending.toolCallId,
        status: "completed",
        content: [{ type: "text", content: { type: "text", text: "permission accepted" } }],
      },
    });
    result(pending.promptRequestId, { stopReason: "end_turn" });
    return;
  }
  log({ method: message.method, params: message.params });
  switch (message.method) {
    case "initialize":
      result(message.id, { protocolVersion: 1, agentInfo: { name: "fake-reasonix" } });
      return;
    case "session/new":
      sessionId = "fake-session-" + process.pid;
      result(message.id, { sessionId });
      return;
    case "session/load":
      sessionId = message.params?.sessionId || sessionId;
      result(message.id, { sessionId });
      return;
    case "session/status":
      const status = {
        label: "fake",
        running: false,
        used: 125,
        window: 200000,
        cacheHit: 90,
        cacheMiss: 10,
        lastUsage: usage(),
        connectedMcp: ["fake-mcp"],
        configuredMcp: ["fake-mcp"],
        disconnectedMcp: [],
      };
      log({ method: "session/status/result", result: status });
      result(message.id, status);
      return;
    case "model/list":
      if (process.env.REASONIX_FAKE_MODEL_LIST_ERROR === "1") {
        log({ method: "model/list/error" });
        error(message.id, -32601, "unknown method model/list");
        return;
      }
      result(message.id, {
        defaultModel: "fake/default",
        currentModel: "fake/default",
        models: [{ ref: "fake/default", provider: "fake", model: "default", current: true, configured: true, effortSupported: true, effortLevels: ["low", "medium", "high"], defaultEffort: "medium" }],
      });
      return;
    case "effort/set":
      result(message.id, { modelRef: message.params?.modelRef || "fake/default", level: message.params?.level || "medium" });
      return;
    case "session/cancel":
      log({ method: "session/cancel", params: message.params });
      if (pendingSlowPromptId !== undefined) {
        log({ method: "session/prompt/cancelled" });
        result(pendingSlowPromptId, { stopReason: "cancelled" });
        pendingSlowPromptId = undefined;
      }
      return;
    case "session/prompt":
      handlePrompt(message);
      return;
    default:
      error(message.id, -32601, "unknown method " + message.method);
  }
}

function handlePrompt(message) {
  const text = promptText(message.params);
  if (text.includes("slow_prompt")) {
    pendingSlowPromptId = message.id;
    log({ method: "slow/prompt" });
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "working" } } });
    return;
  }
  if (text.includes("mcp_tool")) {
    log({ method: "tool/fake-mcp" });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "fake-mcp-tool",
        title: "fake-mcp.search",
        kind: "search",
        status: "pending",
        rawInput: { server: "fake-mcp", tool: "search", query: "reasonix" },
      },
    });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "fake-mcp-tool",
        status: "completed",
        content: [{ type: "text", content: { type: "text", text: "fake MCP search result" } }],
      },
    });
  }
  if (text.includes("skill_use")) {
    log({ method: "tool/fake-skill" });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "fake-skill-tool",
        title: "skill: fake-skill",
        kind: "other",
        status: "completed",
        rawInput: { skill: "fake-skill", action: "load" },
      },
    });
  }
  if (text.includes("permission_probe")) {
    const requestId = "permission-" + nextRequestId++;
    const toolCallId = "fake-permission-tool";
    pendingPermissions.set(requestId, { promptRequestId: message.id, toolCallId });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "fake-mcp.write",
        kind: "edit",
        status: "pending",
        rawInput: { server: "fake-mcp", tool: "write", path: "sample.ts" },
      },
    });
    write({
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId,
          title: "fake-mcp.write",
          kind: "edit",
          rawInput: { server: "fake-mcp", tool: "write", path: "sample.ts" },
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    return;
  }
  notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake response" } } });
  notify("session/update", { sessionId, update: { sessionUpdate: "usage", usage: usage() } });
  result(message.id, { stopReason: "end_turn" });
}

function promptText(params) {
  const prompt = params?.prompt;
  if (!Array.isArray(prompt)) {
    return "";
  }
  return prompt.map((part) => part?.text || part?.resource?.text || "").join("\n");
}

function usage() {
  return {
    promptTokens: 100,
    completionTokens: 25,
    totalTokens: 125,
    cacheHitTokens: 90,
    cacheMissTokens: 10,
    reasoningTokens: 0,
    sessionCacheHitTokens: 90,
    sessionCacheMissTokens: 10,
  };
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf("\n");
    if (idx < 0) {
      break;
    }
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch (err) {
      log({ error: String(err), line });
    }
  }
});
