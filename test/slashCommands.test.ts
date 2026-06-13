import test from "node:test";
import assert from "node:assert/strict";
import { expandSlashCommand } from "../src/slashCommands";

test("expandSlashCommand expands known commands with arguments", () => {
  const expanded = expandSlashCommand("/mcp check @sample.ts");

  assert.equal(expanded.command, "mcp");
  assert.match(expanded.prompt, /Inspect the connected MCP context/);
  assert.match(expanded.prompt, /check @sample\.ts/);
});

test("expandSlashCommand covers every built-in command alias", () => {
  const cases = [
    ["/help", "help", /slash commands/],
    ["/?", "?", /slash commands/],
    ["/explain src", "explain", /Explain the referenced code/],
    ["/fix selection", "fix", /Fix the referenced issue/],
    ["/tests failing suite", "tests", /Run or identify the relevant tests/],
    ["/test failing suite", "test", /Run or identify the relevant tests/],
    ["/search provider", "search", /Search the repository/],
    ["/mcp tools", "mcp", /Inspect the connected MCP context/],
    ["/skills design", "skills", /Use the appropriate Reasonix\/Codex skills/],
    ["/skill design", "skill", /Use the appropriate Reasonix\/Codex skills/],
  ] as const;

  for (const [input, command, pattern] of cases) {
    const expanded = expandSlashCommand(input);
    assert.equal(expanded.command, command);
    assert.match(expanded.prompt, pattern);
  }
});

test("expandSlashCommand keeps unknown commands for the backend", () => {
  assert.deepEqual(expandSlashCommand("/future-command keep this"), {
    prompt: "/future-command keep this",
  });
});

test("expandSlashCommand ignores ordinary prompts", () => {
  assert.deepEqual(expandSlashCommand("please explain /not-a-command"), {
    prompt: "please explain /not-a-command",
  });
});
