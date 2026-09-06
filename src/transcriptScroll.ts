/** Scroll geometry of a scrollable element, in CSS pixels. */
export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** How far above the bottom the transcript may sit and still count as "reading the latest output". */
export const TRANSCRIPT_BOTTOM_SLACK = 80;

/** Reasoning bodies are only a few lines tall, so they need a much tighter slack. */
export const THOUGHT_BOTTOM_SLACK = 8;

export function isAtBottom(metrics: ScrollMetrics, slack: number): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < slack;
}

/**
 * Auto-scroll only when the reader already sits at the newest output, or when something explicitly
 * asked for it (sending a prompt, returning from the settings view). A running turn deliberately
 * does not force the transcript down: that made scrolling up during streaming impossible.
 */
export function shouldFollowLatest(state: { atBottom: boolean; forced: boolean; settingsOpen: boolean }): boolean {
  return !state.settingsOpen && (state.forced || state.atBottom);
}

/** Scroll offset a reasoning body keeps after a streaming patch re-rendered it. */
export function nextThoughtScrollTop(metrics: ScrollMetrics, view: { follow: boolean; scrollTop: number }): number {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  if (view.follow) {
    return maxScrollTop;
  }
  return Math.min(Math.max(0, view.scrollTop), maxScrollTop);
}
