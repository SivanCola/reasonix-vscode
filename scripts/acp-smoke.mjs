#!/usr/bin/env node
import { spawn } from "node:child_process";

const required = process.env.REASONIX_ACP_SMOKE_REQUIRED === "1";
const independentAxesRequired = process.env.REASONIX_ACP_INDEPENDENT_AXES_REQUIRED === "1";
const binary = process.env.REASONIX_BINARY || "reasonix";
const timeoutMs = Number(process.env.REASONIX_ACP_SMOKE_TIMEOUT_MS || 15_000);

const child = spawn(binary, ["acp"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stderr = "";
let nextId = 1;
const pending = new Map();
let sessionId;
let timedOut = false;

const timer = setTimeout(() => {
  timedOut = true;
  child.kill();
}, timeoutMs);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
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
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("error", (err) => {
  clearTimeout(timer);
  if (err && err.code === "ENOENT" && !required) {
    console.log(`reasonix ACP smoke skipped: ${binary} was not found. Set REASONIX_BINARY or REASONIX_ACP_SMOKE_REQUIRED=1 to require it.`);
    process.exit(0);
  }
  console.error(`reasonix ACP smoke failed to start ${binary}: ${err.message}`);
  process.exit(1);
});

child.on("exit", () => {
  if (timedOut) {
    console.error(`reasonix ACP smoke timed out after ${timeoutMs}ms.`);
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
    process.exit(1);
  }
});

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "reasonix-vscode-smoke", version: "0.2.0" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  failOnError(init, "initialize");
  if (init.result?.protocolVersion !== 1 || !init.result?.agentCapabilities) {
    throw new Error("initialize did not advertise ACP v1 agentCapabilities");
  }

  const newSession = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
  failOnError(newSession, "session/new");
  sessionId = newSession.result?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("session/new did not return a sessionId");
  }

  if (!Array.isArray(newSession.result?.configOptions) || !newSession.result?.modes) {
    throw new Error("session/new did not return configOptions and modes");
  }
  const workMode = findConfigOption(newSession.result.configOptions, "work_mode", ["work_mode", "profile", "runtime_profile", "token_mode"]);
  const toolApproval = findConfigOption(newSession.result.configOptions, "tool_approval", ["tool_approval", "approval", "approval_mode", "tool_approval_mode"]);
  const independentAxes = Boolean(workMode && toolApproval);
  if (independentAxesRequired && !independentAxes) {
    throw new Error("session/new did not advertise the required work_mode and tool_approval config options");
  }
  const sessions = await request("session/list", { cwd: process.cwd() });
  failOnError(sessions, "session/list");
  if (!Array.isArray(sessions.result?.sessions)) {
    throw new Error("session/list did not return sessions");
  }
  const modeIds = new Set(newSession.result.modes.availableModes?.map((mode) => mode.id) ?? []);
  if (modeIds.has("goal")) {
    failOnError(await request("session/set_mode", { sessionId, modeId: "goal" }), "session/set_mode(goal)");
    failOnError(await request("session/set_mode", { sessionId, modeId: modeIds.has("normal") ? "normal" : "default" }), "session/set_mode(normal)");
  } else if (modeIds.has("plan")) {
    failOnError(await request("session/set_mode", { sessionId, modeId: "plan" }), "session/set_mode(plan)");
    failOnError(await request("session/set_mode", { sessionId, modeId: "default" }), "session/set_mode(default)");
  }
  if (workMode && toolApproval) {
    requireValues(workMode, ["economy", "balanced", "delivery"]);
    requireValues(toolApproval, ["ask", "auto", "yolo"]);
    const nextProfile = workMode.currentValue === "economy" ? "balanced" : "economy";
    failOnError(await request("session/set_config_option", { sessionId, configId: workMode.id, value: nextProfile }), `session/set_config_option(${workMode.id})`);
    failOnError(await request("session/set_config_option", { sessionId, configId: workMode.id, value: workMode.currentValue }), `session/set_config_option(${workMode.id}:restore)`);
    const nextApproval = toolApproval.currentValue === "auto" ? "ask" : "auto";
    failOnError(await request("session/set_config_option", { sessionId, configId: toolApproval.id, value: nextApproval }), `session/set_config_option(${toolApproval.id})`);
    failOnError(await request("session/set_config_option", { sessionId, configId: toolApproval.id, value: toolApproval.currentValue }), `session/set_config_option(${toolApproval.id}:restore)`);
  }
  failOnError(await request("session/close", { sessionId }), "session/close");
  if (init.result.agentCapabilities.sessionCapabilities?.delete) {
    failOnError(await request("session/delete", { sessionId }), "session/delete");
  }

  console.log("reasonix ACP smoke passed");
  console.log(`- initialize: ${describeResult(init)}`);
  console.log(`- session/new: ${sessionId}`);
  console.log(`- config options: ${newSession.result.configOptions.length}`);
  console.log(`- modes: ${newSession.result.modes.availableModes?.length ?? 0}`);
  console.log(`- independent axes: ${independentAxes ? "work_mode + tool_approval" : "legacy"}`);
  console.log(`- session/list: ${sessions.result.sessions.length} session(s)`);
  child.kill();
  clearTimeout(timer);
  process.exit(0);
} catch (err) {
  child.kill();
  clearTimeout(timer);
  console.error(`reasonix ACP smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
  process.exit(1);
}

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => {
    pending.set(id, resolve);
  });
}

function failOnError(response, method) {
  if (response.error) {
    throw new Error(`${method} returned ${response.error.code}: ${response.error.message}`);
  }
}

function describeResult(response) {
  return response.result ? "ok" : "empty result";
}

function findConfigOption(options, category, ids) {
  return options.find((option) => option?.category === category || ids.includes(option?.id));
}

function requireValues(option, values) {
  const available = new Set(option.options?.map((candidate) => candidate.value) ?? []);
  for (const value of values) {
    if (!available.has(value)) {
      throw new Error(`${option.id} did not advertise ${value}`);
    }
  }
}
