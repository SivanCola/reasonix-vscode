#!/usr/bin/env node
const fs = require("node:fs");

const logPath = process.env.REASONIX_FAKE_LOG;
let buffer = "";
let sessionId = "fake-session";

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
      result(message.id, {
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
      });
      return;
    case "surface/list":
      result(message.id, {
        commands: [{ name: "help", description: "Show help" }],
        skills: [{ name: "vscode-extension-dev", scope: "user", subagent: false, description: "VS Code extension development" }],
        slashCompletions: [{ label: "/help", insert: "/help ", hint: "Show help" }],
        mcpServers: [{ name: "fake-mcp", transport: "stdio", status: "connected", tools: 1, prompts: 0, resources: 0 }],
      });
      return;
    case "model/list":
      result(message.id, {
        defaultModel: "fake/default",
        currentModel: "fake/default",
        models: [{ ref: "fake/default", provider: "fake", model: "default", current: true, configured: true, effortSupported: true, effortLevels: ["low", "medium", "high"], defaultEffort: "medium" }],
      });
      return;
    case "effort/set":
      result(message.id, { modelRef: message.params?.modelRef || "fake/default", level: message.params?.level || "medium" });
      return;
    case "session/prompt":
      notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake response" } } });
      notify("session/update", { sessionId, update: { sessionUpdate: "usage", usage: usage() } });
      result(message.id, { stopReason: "end_turn" });
      return;
    default:
      error(message.id, -32601, "unknown method " + message.method);
  }
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
