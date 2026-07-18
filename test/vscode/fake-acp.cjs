#!/usr/bin/env node
const fs = require("node:fs");

const logPath = process.env.REASONIX_FAKE_LOG;
let buffer = "";
let sessionId = "fake-session";
let nextRequestId = 1000;
let pendingSlowPromptId;
let currentModeId = "normal";
let currentModelId = "fake/default";
let currentEffort = "medium";
let currentWorkMode = "balanced";
let currentApprovalMode = "ask";
const pendingAgentRequests = new Map();
const sessions = new Map();

function log(event) {
  if (logPath) {
    fs.appendFileSync(logPath, JSON.stringify(event) + "\n");
  }
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

function request(method, params, pending) {
  const id = "agent-" + nextRequestId++;
  pendingAgentRequests.set(id, pending);
  log({ method, params });
  write({ id, method, params });
}

function sessionState() {
  return {
    models: {
      currentModelId,
      availableModels: [
        { modelId: "fake/default", name: "Fake Default", description: "Default test model" },
        { modelId: "fake/fast", name: "Fake Fast", description: "Fast test model" },
      ],
    },
    modes: {
      currentModeId,
      availableModes: [
        { id: "normal", name: "Normal" },
        { id: "plan", name: "Plan" },
        { id: "goal", name: "Goal" },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { value: "fake/default", name: "Fake Default" },
          { value: "fake/fast", name: "Fake Fast" },
        ],
      },
      {
        id: "effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: currentEffort,
        options: [
          { value: "auto", name: "Auto" },
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "work_mode",
        name: "Work mode",
        category: "work_mode",
        type: "select",
        currentValue: currentWorkMode,
        options: [
          { value: "economy", name: "Economy" },
          { value: "balanced", name: "Balanced" },
          { value: "delivery", name: "Delivery" },
        ],
      },
      {
        id: "tool_approval",
        name: "Tool approvals",
        category: "tool_approval",
        type: "select",
        currentValue: currentApprovalMode,
        options: [
          { value: "ask", name: "Ask" },
          { value: "auto", name: "Auto" },
          { value: "yolo", name: "Yolo" },
        ],
      },
    ],
  };
}

function availableCommands() {
  return {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Review the current changes", input: { hint: "scope" } },
        { name: "test", description: "Run relevant tests" },
      ],
    },
  };
}

function handle(message) {
  if (!message.method && pendingAgentRequests.has(message.id)) {
    handleAgentResponse(message, pendingAgentRequests.get(message.id));
    pendingAgentRequests.delete(message.id);
    return;
  }
  log({ method: message.method, params: message.params });
  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "fake-reasonix", version: "main-v2" },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
        },
        authMethods: [],
      });
      return;
    case "session/new":
      sessionId = "fake-session-" + process.pid;
      sessions.set(sessionId, { sessionId, cwd: message.params?.cwd || process.cwd(), title: "Fake session", updatedAt: new Date().toISOString() });
      notify("session/update", availableCommands());
      result(message.id, { sessionId, ...sessionState() });
      return;
    case "session/load":
      sessionId = message.params?.sessionId || sessionId;
      notify("session/update", { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "restored prompt" } } });
      notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "restored response" } } });
      notify("session/update", availableCommands());
      result(message.id, sessionState());
      return;
    case "session/resume":
      sessionId = message.params?.sessionId || sessionId;
      notify("session/update", availableCommands());
      result(message.id, sessionState());
      return;
    case "session/list":
      result(message.id, { sessions: [...sessions.values()] });
      return;
    case "session/close":
      result(message.id, {});
      return;
    case "session/delete":
      sessions.delete(message.params?.sessionId);
      result(message.id, {});
      return;
    case "session/set_mode":
      currentModeId = message.params?.modeId || "normal";
      notify("session/update", { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId } });
      result(message.id, {});
      return;
    case "session/set_config_option": {
      switch (message.params?.configId) {
        case "model":
          currentModelId = message.params?.value;
          break;
        case "effort":
          currentEffort = message.params?.value;
          break;
        case "work_mode":
          currentWorkMode = message.params?.value;
          break;
        case "tool_approval":
          currentApprovalMode = message.params?.value;
          break;
      }
      const state = sessionState();
      notify("session/update", { sessionId, update: { sessionUpdate: "config_option_update", configOptions: state.configOptions } });
      result(message.id, { configOptions: state.configOptions });
      return;
    }
    case "session/cancel":
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
  if (text.includes("disconnect_probe")) {
    log({ method: "process/disconnect-probe" });
    process.exit(23);
  }
  if (text.includes("permission_probe")) {
    const toolCallId = "fake-permission-tool";
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title: "write_file", kind: "edit", status: "pending", rawInput: { path: "sample.ts" }, locations: [{ path: message.params?.cwd || "sample.ts", line: 1 }] } });
    if (currentApprovalMode !== "ask") {
      log({ method: "permission/server-auto", mode: currentApprovalMode });
      notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "permission handled by Reasonix" } }] } });
      result(message.id, { stopReason: "end_turn" });
      return;
    }
    request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "write_file", kind: "edit", rawInput: { path: "sample.ts" } },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_always", name: "Allow for session", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    }, { type: "permission", promptRequestId: message.id, toolCallId });
    return;
  }
  if (text.includes("ask_probe")) {
    request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "ask-fake-question-choice",
        title: "Choose a strategy",
        kind: "other",
        rawInput: { id: "choice", question: "Choose a strategy", options: [{ label: "Focused" }, { label: "Broad" }], multi: false },
      },
      options: [
        { optionId: "choice:1", name: "Focused", kind: "allow_once" },
        { optionId: "choice:2", name: "Broad", kind: "allow_once" },
        { optionId: "choice:cancel", name: "Cancel", kind: "reject_once" },
      ],
    }, { type: "ask", promptRequestId: message.id });
    return;
  }
  if (text.includes("fs_read_probe")) {
    request("fs/read_text_file", { sessionId, path: "sample.ts" }, { type: "fs-read", promptRequestId: message.id });
    return;
  }
  if (text.includes("fs_write_probe")) {
    request("fs/write_text_file", { sessionId, path: "bridge-output.txt", content: "written through VS Code" }, { type: "fs-write", promptRequestId: message.id });
    return;
  }
  if (text.includes("terminal_probe")) {
    request("terminal/create", { sessionId, command: "printf reasonix-terminal", outputByteLimit: 8192 }, { type: "terminal-create", promptRequestId: message.id });
    return;
  }
  if (text.includes("plan_probe")) {
    notify("session/update", { sessionId, update: { sessionUpdate: "plan", entries: [
      { content: "Inspect protocol", priority: "high", status: "completed" },
      { content: "Verify integration", priority: "medium", status: "in_progress" },
    ] } });
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "location-tool", title: "read_file", kind: "read", status: "completed", locations: [{ path: "sample.ts", line: 1 }] } });
  }
  notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake response" } } });
  result(message.id, { stopReason: "end_turn" });
}

function handleAgentResponse(message, pending) {
  log({ method: `${pending.type}/response`, response: message });
  switch (pending.type) {
    case "permission":
      notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: pending.toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "permission accepted" } }] } });
      result(pending.promptRequestId, { stopReason: "end_turn" });
      return;
    case "ask":
    case "fs-read":
    case "fs-write":
      result(pending.promptRequestId, { stopReason: "end_turn" });
      return;
    case "terminal-create": {
      const terminalId = message.result?.terminalId;
      request("terminal/wait_for_exit", { sessionId, terminalId }, { type: "terminal-wait", promptRequestId: pending.promptRequestId, terminalId });
      return;
    }
    case "terminal-wait":
      request("terminal/output", { sessionId, terminalId: pending.terminalId }, { type: "terminal-output", promptRequestId: pending.promptRequestId, terminalId: pending.terminalId });
      return;
    case "terminal-output":
      log({ method: "terminal/captured", output: message.result });
      request("terminal/release", { sessionId, terminalId: pending.terminalId }, { type: "terminal-release", promptRequestId: pending.promptRequestId });
      return;
    case "terminal-release":
      result(pending.promptRequestId, { stopReason: "end_turn" });
      return;
  }
}

function promptText(params) {
  return Array.isArray(params?.prompt)
    ? params.prompt.map((part) => part?.text || part?.resource?.text || "").join("\n")
    : "";
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
