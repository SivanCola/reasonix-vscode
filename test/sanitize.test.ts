import test from "node:test";
import assert from "node:assert/strict";
import { redactLocalPaths } from "../src/sanitize";

test("redactLocalPaths hides workspace and home paths", () => {
  const previousHome = process.env.HOME;
  process.env.HOME = "/Users/alice";
  try {
    const text = "cwd=/Users/alice/project file=/Users/alice/project/src/a.ts home=/Users/alice/.reasonix";
    assert.equal(redactLocalPaths(text, "/Users/alice/project"), "cwd=${workspace} file=${workspace}/src/a.ts home=~/.reasonix");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
