import test from "node:test";
import assert from "node:assert/strict";
import { shouldSubmitPromptOnKeydown } from "../src/keyboard";

test("shouldSubmitPromptOnKeydown sends on plain Enter", () => {
  assert.equal(shouldSubmitPromptOnKeydown({ key: "Enter" }, false), true);
});

test("shouldSubmitPromptOnKeydown keeps Shift+Enter as newline", () => {
  assert.equal(shouldSubmitPromptOnKeydown({ key: "Enter", shiftKey: true }, false), false);
});

test("shouldSubmitPromptOnKeydown does not send during IME composition", () => {
  assert.equal(shouldSubmitPromptOnKeydown({ key: "Enter", isComposing: true }, false), false);
  assert.equal(shouldSubmitPromptOnKeydown({ key: "Enter" }, true), false);
  assert.equal(shouldSubmitPromptOnKeydown({ key: "Enter", keyCode: 229 }, false), false);
});

test("shouldSubmitPromptOnKeydown ignores non-Enter keys", () => {
  assert.equal(shouldSubmitPromptOnKeydown({ key: "a" }, false), false);
});
