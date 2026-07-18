import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFSReadTextFileParams,
  parsePermissionRequestParams,
  parseSessionUpdateParams,
  parseTerminalCreateParams,
} from "../src/acpProtocol";

test("parseSessionUpdateParams accepts main-v2 command, plan, and location updates", () => {
  const commands = parseSessionUpdateParams({
    sessionId: "s1",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review changes", input: { hint: "scope" } }],
    },
  });
  const plan = parseSessionUpdateParams({
    sessionId: "s1",
    update: { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "high", status: "in_progress" }] },
  });
  const tool = parseSessionUpdateParams({
    sessionId: "s1",
    update: { sessionUpdate: "tool_call", toolCallId: "t1", locations: [{ path: "src/app.ts", line: 7 }] },
  });

  assert.equal(commands.ok, true);
  assert.equal(plan.ok, true);
  assert.equal(tool.ok, true);
});

test("parseSessionUpdateParams rejects unknown or malformed frames without throwing", () => {
  const unknown = parseSessionUpdateParams({ sessionId: "s1", update: { sessionUpdate: "future_update", value: 1 } });
  const malformed = parseSessionUpdateParams({ sessionId: "s1", update: { sessionUpdate: "tool_call", locations: [] } });

  assert.deepEqual(unknown, { ok: false, error: "unsupported session update: future_update" });
  assert.equal(malformed.ok, false);
});

test("ACP client request parsers enforce required fields", () => {
  assert.equal(parseFSReadTextFileParams({ sessionId: "s1", path: "README.md", line: 1, limit: 20 }).ok, true);
  assert.equal(parseFSReadTextFileParams({ sessionId: "s1", path: "README.md", line: 0 }).ok, false);
  assert.equal(parseTerminalCreateParams({ sessionId: "s1", command: "npm", args: ["test"], outputByteLimit: 8192 }).ok, true);
  assert.equal(parseTerminalCreateParams({ sessionId: "s1", command: "npm", args: [3] }).ok, false);
  assert.equal(parsePermissionRequestParams({
    sessionId: "s1",
    toolCall: { toolCallId: "ask-1" },
    options: [{ optionId: "q:1", name: "One", kind: "allow_once" }],
  }).ok, true);
});
