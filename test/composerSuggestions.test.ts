import test from "node:test";
import assert from "node:assert/strict";
import { getComposerTrigger, replaceComposerTrigger, slashSuggestions } from "../src/composerSuggestions";

test("getComposerTrigger detects slash commands only at prompt start", () => {
  assert.deepEqual(getComposerTrigger("/", 1), {
    kind: "slash",
    start: 0,
    end: 1,
    query: "",
  });
  assert.deepEqual(getComposerTrigger("  /ex", 5), {
    kind: "slash",
    start: 2,
    end: 5,
    query: "ex",
  });
  assert.equal(getComposerTrigger("please /ex", 10), undefined);
  assert.equal(getComposerTrigger("/explain now", 12), undefined);
});

test("getComposerTrigger detects resource mentions in ordinary prompts", () => {
  assert.deepEqual(getComposerTrigger("@", 1), {
    kind: "resource",
    start: 0,
    end: 1,
    query: "",
  });
  assert.deepEqual(getComposerTrigger("check @src/we", 13), {
    kind: "resource",
    start: 6,
    end: 13,
    query: "src/we",
  });
  assert.equal(getComposerTrigger("mail me a@b.com", 15), undefined);
});

test("replaceComposerTrigger inserts slash commands and resource mentions", () => {
  const slash = getComposerTrigger("/ex", 3);
  assert.ok(slash);
  assert.deepEqual(replaceComposerTrigger("/ex", slash, "/explain"), {
    value: "/explain ",
    cursor: 9,
  });

  const mention = getComposerTrigger("check @sr", 9);
  assert.ok(mention);
  assert.deepEqual(replaceComposerTrigger("check @sr", mention, "src/webview.ts"), {
    value: "check @src/webview.ts ",
    cursor: 22,
  });
});

test("slashSuggestions filters commands and localizes details", () => {
  const explain = slashSuggestions("ex", "zh-CN");
  assert.equal(explain[0]?.name, "explain");
  assert.match(explain[0]?.detail ?? "", /解释/);

  const all = slashSuggestions("", "en");
  assert.equal(all[0]?.name, "help");
  assert.ok(all.some((suggestion) => suggestion.name === "help"));
  assert.ok(all.some((suggestion) => suggestion.aliases.includes("?")));
});
