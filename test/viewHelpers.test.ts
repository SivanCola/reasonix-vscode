import test from "node:test";
import assert from "node:assert/strict";
import {
  cachePercent,
  cacheLabel,
  getRiskLabel,
  diffLineClass,
  toolIcon,
  approvalLabel,
  approvalButtonMap,
  contextModeLabel,
  modelDisplayLabel,
} from "../src/viewHelpers";

test("cachePercent returns n/a for zero total", () => {
  assert.equal(cachePercent(0, 0), "n/a");
});

test("cachePercent returns correct percentage", () => {
  assert.equal(cachePercent(80, 20), "80%");
  assert.equal(cachePercent(0, 100), "0%");
  assert.equal(cachePercent(100, 0), "100%");
});

test("cachePercent rounds to integer", () => {
  assert.equal(cachePercent(1, 2), "33%");
  assert.equal(cachePercent(2, 1), "67%");
});

test("cacheLabel returns n/a for zero total", () => {
  assert.equal(cacheLabel(0, 0), "n/a");
});

test("cacheLabel includes formatted counts", () => {
  const result = cacheLabel(80, 20);
  assert.ok(result.startsWith("80%"));
  assert.ok(result.includes("80"));
  assert.ok(result.includes("20"));
});

test("getRiskLabel classifies tool kinds", () => {
  assert.equal(getRiskLabel("execute"), "High");
  assert.equal(getRiskLabel("bash"), "High");
  assert.equal(getRiskLabel("shell"), "High");
  assert.equal(getRiskLabel("edit"), "Medium");
  assert.equal(getRiskLabel("write"), "Medium");
  assert.equal(getRiskLabel("multi_edit"), "Medium");
  assert.equal(getRiskLabel("read"), "Low");
  assert.equal(getRiskLabel("search"), "Low");
  assert.equal(getRiskLabel("grep"), "Low");
  assert.equal(getRiskLabel("unknown_kind"), "Info");
});

test("diffLineClass classifies unified diff lines", () => {
  assert.equal(diffLineClass("@@ -1,3 +1,4 @@"), "diff-hunk");
  assert.equal(diffLineClass("+added line"), "diff-added");
  assert.equal(diffLineClass("-removed line"), "diff-removed");
  assert.equal(diffLineClass(" context line"), "diff-context");
  assert.equal(diffLineClass(""), "diff-context");
});

test("toolIcon maps kind to codicon class", () => {
  assert.equal(toolIcon("read"), "codicon-file");
  assert.equal(toolIcon("edit"), "codicon-edit");
  assert.equal(toolIcon("write"), "codicon-edit");
  assert.equal(toolIcon("search"), "codicon-search");
  assert.equal(toolIcon("grep"), "codicon-search");
  assert.equal(toolIcon("execute"), "codicon-terminal");
  assert.equal(toolIcon("bash"), "codicon-terminal");
  assert.equal(toolIcon("shell"), "codicon-terminal");
  assert.equal(toolIcon("other"), "codicon-tools");
});

test("approvalLabel maps option kind to display name", () => {
  assert.equal(approvalLabel({ name: "Allow", kind: "allow_once" }), "Once");
  assert.equal(approvalLabel({ name: "Allow", kind: "allow_always" }), "Session");
  assert.equal(approvalLabel({ name: "Allow", kind: "allow_persistent" }), "Always");
  assert.equal(approvalLabel({ name: "Custom", kind: "custom" }), "Custom");
});

test("approvalButtonMap detects available options", () => {
  const result = approvalButtonMap([
    { optionId: "1", name: "Once", kind: "allow_once" },
    { optionId: "2", name: "Session", kind: "allow_always" },
    { optionId: "3", name: "Always", kind: "allow_persistent" },
  ]);
  assert.equal(result.hasOnce, true);
  assert.equal(result.hasSession, true);
  assert.equal(result.hasAlways, true);
});

test("approvalButtonMap handles empty options", () => {
  const result = approvalButtonMap([]);
  assert.equal(result.hasOnce, false);
  assert.equal(result.hasSession, false);
  assert.equal(result.hasAlways, false);
});

test("approvalButtonMap handles partial options", () => {
  const result = approvalButtonMap([
    { optionId: "1", name: "Once", kind: "allow_once" },
  ]);
  assert.equal(result.hasOnce, true);
  assert.equal(result.hasSession, false);
  assert.equal(result.hasAlways, false);
});

test("contextModeLabel maps internal modes to readable labels", () => {
  assert.equal(contextModeLabel("off"), "No context");
  assert.equal(contextModeLabel("selectionOnly"), "Selection");
  assert.equal(contextModeLabel("nearby"), "Nearby");
  assert.equal(contextModeLabel("customMode"), "custom Mode");
});

test("modelDisplayLabel shortens the default model label", () => {
  assert.equal(modelDisplayLabel("Default model"), "Default");
  assert.equal(modelDisplayLabel("openai/gpt-5.1"), "openai/gpt-5.1");
});
