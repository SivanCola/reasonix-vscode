import test from "node:test";
import assert from "node:assert/strict";
import {
  isAtBottom,
  nextThoughtScrollTop,
  shouldFollowLatest,
  THOUGHT_BOTTOM_SLACK,
  TRANSCRIPT_BOTTOM_SLACK,
} from "../src/transcriptScroll";

test("isAtBottom accepts a small gap and rejects a real scroll-up", () => {
  assert.equal(isAtBottom({ scrollTop: 940, scrollHeight: 2000, clientHeight: 1000 }, TRANSCRIPT_BOTTOM_SLACK), true);
  assert.equal(isAtBottom({ scrollTop: 400, scrollHeight: 2000, clientHeight: 1000 }, TRANSCRIPT_BOTTOM_SLACK), false);
  assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }, THOUGHT_BOTTOM_SLACK), true);
});

test("shouldFollowLatest keeps following while the reader sits at the newest output", () => {
  assert.equal(shouldFollowLatest({ atBottom: true, forced: false, settingsOpen: false }), true);
});

test("shouldFollowLatest leaves a reader who scrolled up alone", () => {
  assert.equal(shouldFollowLatest({ atBottom: false, forced: false, settingsOpen: false }), false);
});

test("shouldFollowLatest returns to the bottom when something asked for it", () => {
  assert.equal(shouldFollowLatest({ atBottom: false, forced: true, settingsOpen: false }), true);
});

test("shouldFollowLatest never scrolls the hidden transcript", () => {
  assert.equal(shouldFollowLatest({ atBottom: true, forced: true, settingsOpen: true }), false);
});

test("nextThoughtScrollTop follows the newest reasoning by default", () => {
  assert.equal(nextThoughtScrollTop({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 }, { follow: true, scrollTop: 0 }), 600);
});

test("nextThoughtScrollTop restores a parked offset, clamped to the new content", () => {
  assert.equal(nextThoughtScrollTop({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 }, { follow: false, scrollTop: 120 }), 120);
  assert.equal(nextThoughtScrollTop({ scrollTop: 0, scrollHeight: 400, clientHeight: 300 }, { follow: false, scrollTop: 900 }), 100);
  assert.equal(nextThoughtScrollTop({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }, { follow: true, scrollTop: 0 }), 0);
});
