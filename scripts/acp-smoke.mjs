#!/usr/bin/env node
import { spawn } from "node:child_process";

const required = process.env.REASONIX_ACP_SMOKE_REQUIRED === "1";
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
  const init = await request("initialize", { protocolVersion: 1, clientInfo: { name: "reasonix-vscode-smoke", version: "0.0.1" } });
  failOnError(init, "initialize");

  const newSession = await request("session/new", {});
  failOnError(newSession, "session/new");
  sessionId = newSession.result?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("session/new did not return a sessionId");
  }

  const status = await optionalRequest("session/status", { sessionId });
  const models = await optionalRequest("model/list", {});

  console.log("reasonix ACP smoke passed");
  console.log(`- initialize: ${describeResult(init)}`);
  console.log(`- session/new: ${sessionId}`);
  console.log(`- session/status: ${describeOptional(status)}`);
  console.log(`- model/list: ${describeOptional(models)}`);
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

async function optionalRequest(method, params) {
  const response = await request(method, params);
  if (!response.error) {
    return { supported: true, response };
  }
  if (response.error.code === -32601) {
    return { supported: false, response };
  }
  failOnError(response, method);
  return { supported: true, response };
}

function failOnError(response, method) {
  if (response.error) {
    throw new Error(`${method} returned ${response.error.code}: ${response.error.message}`);
  }
}

function describeResult(response) {
  return response.result ? "ok" : "empty result";
}

function describeOptional(optional) {
  if (!optional.supported) {
    return "not supported by backend";
  }
  const result = optional.response.result;
  if (Array.isArray(result?.models)) {
    return `${result.models.length} model(s)`;
  }
  if (Array.isArray(result?.connectedMcp) || Array.isArray(result?.configuredMcp)) {
    return `${result.connectedMcp?.length ?? 0} connected MCP / ${result.configuredMcp?.length ?? 0} configured MCP`;
  }
  return describeResult(optional.response);
}
