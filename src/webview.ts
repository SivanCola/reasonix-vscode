import type { ChangePreview, SurfaceListResult, UsageData } from "./acpTypes";
import type { ChatItem } from "./chatState";
import type { HostToWebviewMessage } from "./webviewProtocol";
import {
  cacheLabel,
  cachePercent,
  contextModeLabel,
  diffLineClass,
  formatNumber,
  getRiskLabel,
  modelDisplayLabel,
  stableStringify,
  toolIcon,
} from "./viewHelpers";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

type Snapshot = {
  items: ChatItem[];
  running: boolean;
  disconnected: boolean;
  status: string;
  workspace: string;
  hasWorkspace: boolean;
  startError?: string;
  contextMode: string;
  modelLabel: string;
  usage?: UsageData;
  surfaces?: SurfaceListResult;
};

const vscode = acquireVsCodeApi();
const transcript = mustElement("transcript");
const prompt = mustElement("prompt") as HTMLTextAreaElement;
const send = mustElement("send") as HTMLButtonElement;
const cancel = mustElement("cancel") as HTMLButtonElement;
const newSession = mustElement("newSession") as HTMLButtonElement;
const insertSelection = mustElement("insertSelection") as HTMLButtonElement;
const composer = mustElement("composer") as HTMLFormElement;
const contextHint = mustElement("contextHint");
const surfaceBar = mustElement("surfaceBar");
const composerStats = mustElement("composerStats");
const workspaceChip = mustElement("workspaceChip") as HTMLButtonElement;
const workspaceName = mustElement("workspaceName");
const statusStrip = mustElement("statusStrip");
const modelChip = mustElement("modelChip") as HTMLButtonElement;
const modelLabel = mustElement("modelLabel");
const cacheChip = mustElement("cacheChip");

let snapshot: Snapshot = normalizeSnapshot(vscode.getState());
let hasRendered = false;
let lastRenderHadItems = false;
render(snapshot);

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPrompt();
});

prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    submitPrompt();
  }
});

prompt.addEventListener("input", resizePrompt);

cancel.addEventListener("click", () => vscode.postMessage({ command: "cancel" }));
newSession.addEventListener("click", () => vscode.postMessage({ command: "newSession" }));
insertSelection.addEventListener("click", () => vscode.postMessage({ command: "insertSelection" }));
modelChip.addEventListener("click", () => vscode.postMessage({ command: "pickModel" }));

document.addEventListener("click", (event) => {
  const command = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-command]")?.dataset.command;
  if (isUiCommand(command)) {
    vscode.postMessage({ command });
  }
});

transcript.addEventListener("click", (event) => {
  const target = event.target as Element | null;
  const approvalButton = target?.closest<HTMLButtonElement>("button[data-approval-id]");
  if (approvalButton) {
    vscode.postMessage({
      command: "approvalDecision",
      id: approvalButton.dataset.approvalId,
      optionId: approvalButton.dataset.optionId,
    });
    return;
  }

  const previewButton = target?.closest<HTMLButtonElement>("button[data-preview-id]");
  if (previewButton) {
    vscode.postMessage({ command: "openPreview", id: previewButton.dataset.previewId! });
    return;
  }

});

surfaceBar.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-insert]");
  if (!button) {
    return;
  }
  insertAtCursor(button.dataset.insert ?? "");
});

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "stateSnapshot":
      snapshot = normalizeSnapshot(message.state);
      vscode.setState(snapshot);
      render(snapshot);
      return;
    case "insertText":
      insertAtCursor(message.text);
      return;
    case "notice":
      appendNotice(message.text);
      return;
  }
});

vscode.postMessage({ command: "stateSnapshot" });

// -- render pipeline --

function render(state: Snapshot): void {
  const shouldStickToBottom =
    hasRendered && lastRenderHadItems && transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 32;

  renderHeader(state);
  renderStatusStrip(state);
  composer.hidden = !state.hasWorkspace || state.startError !== undefined;
  send.disabled = state.running || !state.hasWorkspace || state.startError !== undefined;
  prompt.disabled = !state.hasWorkspace || state.startError !== undefined;
  prompt.placeholder = state.hasWorkspace ? "Ask Reasonix anything... (⌘↵ to send)" : "Open a folder to start Reasonix";
  newSession.disabled = state.running || !state.hasWorkspace;
  insertSelection.disabled = !state.hasWorkspace;
  modelChip.disabled = state.running || !state.hasWorkspace;
  cancel.hidden = !state.running;
  cancel.disabled = !state.running;
  contextHint.textContent = contextLabel(state);
  renderComposerStats(state);
  renderSurfaces(state.surfaces);

  transcript.textContent = "";
  if (state.startError !== undefined) {
    transcript.append(renderStartFailedState(state));
    hasRendered = true;
    lastRenderHadItems = false;
    return;
  }
  if (state.items.length === 0) {
    transcript.append(renderEmptyState(state));
    hasRendered = true;
    lastRenderHadItems = false;
    return;
  }

  for (const item of state.items) {
    transcript.append(renderTimelineItem(item));
  }
  if (shouldStickToBottom) {
    transcript.scrollTop = transcript.scrollHeight;
  }
  hasRendered = true;
  lastRenderHadItems = true;
  resizePrompt();
}

function renderHeader(state: Snapshot): void {
  workspaceName.textContent = state.workspace;
  workspaceChip.title = state.hasWorkspace ? `Change workspace: ${state.workspace}` : "Open a folder to start Reasonix";
  workspaceName.title = workspaceChip.title;

  modelLabel.textContent = modelDisplayLabel(state.modelLabel);
  modelChip.title = state.hasWorkspace ? "Change model" : "Open a folder before choosing a model";

  const hitRate = cachePercent(state.usage?.sessionCacheHitTokens ?? 0, state.usage?.sessionCacheMissTokens ?? 0);
  cacheChip.textContent = "";
  cacheChip.hidden = hitRate === "n/a";
  if (hitRate !== "n/a") {
    const icon = document.createElement("span");
    icon.className = "codicon codicon-database";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = hitRate;
    cacheChip.append(icon, label);
  }
}

function renderStatusStrip(state: Snapshot): void {
  statusStrip.textContent = "";

  if (!state.hasWorkspace) {
    const requiredPill = document.createElement("span");
    requiredPill.className = "status-pill disconnected";
    requiredPill.textContent = "Workspace required";
    statusStrip.append(requiredPill);

    const detailPill = document.createElement("span");
    detailPill.className = "status-pill";
    detailPill.append(statusText("open a folder to start "), statusStrong("Reasonix"));
    statusStrip.append(detailPill);
    return;
  }

  if (state.startError !== undefined) {
    const failedPill = document.createElement("span");
    failedPill.className = "status-pill disconnected";
    failedPill.textContent = "Start failed";
    statusStrip.append(failedPill);

    const detailPill = document.createElement("span");
    detailPill.className = "status-pill";
    detailPill.append(statusText("check "), statusStrong("Reasonix CLI"));
    statusStrip.append(detailPill);
    return;
  }

  const runningPill = document.createElement("span");
  runningPill.className = `status-pill ${state.running ? "running" : state.disconnected ? "disconnected" : "idle"}`;
  runningPill.textContent = state.running ? "Running" : state.disconnected ? "Disconnected" : "Idle";
  if (state.running) {
    const pulse = document.createElement("span");
    pulse.className = "status-pulse";
    runningPill.prepend(pulse);
  }
  statusStrip.append(runningPill);

  const hitRate = cachePercent(state.usage?.sessionCacheHitTokens ?? 0, state.usage?.sessionCacheMissTokens ?? 0);
  const cachePill = document.createElement("span");
  cachePill.className = "status-pill";
  cachePill.append(statusText("session cache "), statusStrong(hitRate));
  statusStrip.append(cachePill);

  const toolsCount = state.items.filter((item) => item.type === "tool").length;
  const toolsPill = document.createElement("span");
  toolsPill.className = "status-pill";
  if (toolsCount > 0) {
    toolsPill.textContent = `${toolsCount} tools`;
  } else {
    toolsPill.append(statusText("tools hash "), statusStrong("stable"));
  }
  statusStrip.append(toolsPill);

  const ctxPill = document.createElement("span");
  ctxPill.className = "status-pill context";
  ctxPill.append(statusText("context: "), statusStrong(contextModeLabel(state.contextMode).toLowerCase()), statusText(" + 40 lines"));
  statusStrip.append(ctxPill);
}

function statusText(text: string): Text {
  return document.createTextNode(text);
}

function statusStrong(text: string): HTMLElement {
  const node = document.createElement("strong");
  node.textContent = text;
  return node;
}

function renderComposerStats(state: Snapshot): void {
  composerStats.textContent = "";
  if (!state.hasWorkspace || state.startError !== undefined || !state.usage) {
    composerStats.hidden = true;
    return;
  }
  composerStats.hidden = false;
  composerStats.append(
    composerMetric("database", `${formatNumber(state.usage.promptTokens)} input • ${formatNumber(state.usage.completionTokens)} output`),
    composerMetric("database", `cache ${cachePercent(state.usage.sessionCacheHitTokens, state.usage.sessionCacheMissTokens)}`),
  );
}

function composerMetric(icon: string, text: string): HTMLElement {
  const node = document.createElement("span");
  node.className = "composer-metric";
  const glyph = document.createElement("span");
  glyph.className = `codicon codicon-${icon}`;
  glyph.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = text;
  node.append(glyph, label);
  return node;
}

// -- timeline rendering --

function renderTimelineItem(item: ChatItem): HTMLElement {
  switch (item.type) {
    case "message":
      return renderTimelineMessage(item);
    case "tool":
      return renderTimelineTool(item);
    case "usage":
      return renderTimelineUsage(item.usage);
    case "approval":
      return renderApprovalCard(item);
  }
}

function renderTimelineMessage(item: Extract<ChatItem, { type: "message" }>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "timeline-item";

  const gutter = document.createElement("div");
  gutter.className = "timeline-gutter";
  const dot = document.createElement("span");
  dot.className = `timeline-dot ${item.role}`;
  gutter.append(dot, timelineLine());
  wrapper.append(gutter);

  const body = document.createElement("div");
  body.className = "timeline-body";

  if (item.role === "thought" || item.role === "notice") {
    const label = document.createElement("div");
    label.className = "timeline-role";
    label.textContent = item.role;
    body.append(label);
  }

  const text = document.createElement("div");
  text.className = `message-text ${item.role}`;
  if (item.role === "user" || item.role === "assistant") {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("span");
    name.textContent = item.role === "user" ? "You" : "Reasonix";
    const time = document.createElement("span");
    time.textContent = "10:42 AM";
    meta.append(name, time);
    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = item.text;
    text.append(meta, content);
  } else {
    text.textContent = item.text;
  }
  body.append(text);
  wrapper.append(body);

  return wrapper;
}

function renderTimelineTool(item: Extract<ChatItem, { type: "tool" }>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `timeline-item tool-item ${item.status}`;

  const gutter = document.createElement("div");
  gutter.className = "timeline-gutter";
  const step = document.createElement("span");
  step.className = `tool-step ${toolStatusClass(item)}`;
  if (toolStatusClass(item) === "completed") {
    const check = document.createElement("span");
    check.className = "codicon codicon-check";
    check.setAttribute("aria-hidden", "true");
    step.append(check);
  }
  gutter.append(step, timelineLine());
  wrapper.append(gutter);

  const body = document.createElement("div");
  body.className = "timeline-body tool-card";

  const cardIcon = document.createElement("span");
  cardIcon.className = `tool-card-icon codicon ${toolIcon(item.kind)}`;
  cardIcon.setAttribute("aria-hidden", "true");
  body.append(cardIcon);

  const meta = document.createElement("div");
  meta.className = "tool-meta";

  const titleGroup = document.createElement("div");
  titleGroup.className = "tool-title-group";
  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = item.title;
  titleGroup.append(title);
  const subtitle = toolSubtitle(item);
  if (subtitle) {
    const sub = document.createElement("span");
    sub.className = "tool-subtitle";
    sub.textContent = subtitle;
    titleGroup.append(sub);
  }
  meta.append(titleGroup);

  const statusBadge = document.createElement("span");
  statusBadge.className = `status-badge ${toolStatusClass(item)}`;
  statusBadge.textContent = toolStatusLabel(item);
  meta.append(statusBadge);
  body.append(meta);

  if (item.preview) {
    body.append(renderDiffMiniPreview(item.preview, item.id));
  }

  if (item.content) {
    body.append(detailsBlock("Result", item.content));
  }

  wrapper.append(body);
  return wrapper;
}

function renderTimelineUsage(usage: UsageData): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "timeline-item";

  const gutter = document.createElement("div");
  gutter.className = "timeline-gutter";
  const dot = document.createElement("span");
  dot.className = "timeline-dot usage-dot";
  gutter.append(dot);
  wrapper.append(gutter);

  const body = document.createElement("div");
  body.className = "timeline-body usage-card";

  const grid = document.createElement("div");
  grid.className = "usage-grid";
  grid.append(metric("Tokens", formatNumber(usage.totalTokens)));
  grid.append(metric("Input", formatNumber(usage.promptTokens)));
  grid.append(metric("Output", formatNumber(usage.completionTokens)));
  grid.append(metric("Cache", cacheLabel(usage.sessionCacheHitTokens, usage.sessionCacheMissTokens)));
  if (usage.cost !== undefined) {
    grid.append(metric("Cost", `${usage.currency ?? ""}${usage.cost.toFixed(4)}`));
  }
  body.append(grid);

  if (usage.cacheDiagnostics) {
    const reasons = usage.cacheDiagnostics.prefixChangeReasons?.join("\n") ?? "";
    body.append(
      detailsBlock(
        "Cache diagnostics",
        [
          `Prefix changed: ${usage.cacheDiagnostics.prefixChanged}`,
          `Prefix hash: ${usage.cacheDiagnostics.prefixHash}`,
          `System hash: ${usage.cacheDiagnostics.systemHash}`,
          `Tools hash: ${usage.cacheDiagnostics.toolsHash}`,
          `Tool schema tokens: ${usage.cacheDiagnostics.toolSchemaTokens}`,
          reasons ? `Reasons:\n${reasons}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  }

  wrapper.append(body);
  return wrapper;
}

// -- approval card --

function renderApprovalCard(item: Extract<ChatItem, { type: "approval" }>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `timeline-item approval-card ${item.status}`;

  const gutter = document.createElement("div");
  gutter.className = "timeline-gutter";
  const icon = document.createElement("span");
  icon.className = "codicon codicon-warning";
  icon.setAttribute("aria-label", "approval required");
  gutter.append(icon, timelineLine());
  wrapper.append(gutter);

  const body = document.createElement("div");
  body.className = "timeline-body";

  const header = document.createElement("div");
  header.className = "approval-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "approval-title-group";
  const warning = document.createElement("span");
  warning.className = "codicon codicon-warning";
  warning.setAttribute("aria-hidden", "true");

  const title = document.createElement("span");
  title.className = "approval-title";
  title.textContent = item.title;
  titleGroup.append(warning, title);
  header.append(titleGroup);

  const meta = document.createElement("div");
  meta.className = "approval-meta";
  const tool = document.createElement("span");
  tool.className = "approval-tool";
  const toolGlyph = document.createElement("span");
  toolGlyph.className = `codicon ${toolIcon(item.kind)}`;
  toolGlyph.setAttribute("aria-hidden", "true");
  const toolName = document.createElement("span");
  toolName.textContent = item.kind;
  tool.append(toolGlyph, toolName);
  const riskLabel = getRiskLabel(item.kind);
  const risk = document.createElement("span");
  risk.className = `risk-badge risk-${riskLabel.toLowerCase()}`;
  risk.textContent = approvalOperationLabel(item.kind);
  meta.append(tool, risk);
  header.append(meta);

  body.append(header);

  if (item.preview) {
    const target = document.createElement("div");
    target.className = "approval-target";
    target.textContent = item.preview.path;
    body.append(target);
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const optionMap = new Map(item.options.map((o) => [o.kind, o]));

  if (optionMap.has("allow_once")) {
    actions.append(approvalButton(item, optionMap.get("allow_once")!, "Approve", true));
  }
  if (optionMap.has("allow_always")) {
    actions.append(approvalButton(item, optionMap.get("allow_always")!, "Approve Session", true));
  }
  if (optionMap.has("allow_persistent")) {
    actions.append(approvalButton(item, optionMap.get("allow_persistent")!, "Approve Always", true));
  }

  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "approval-btn deny";
  deny.dataset.approvalId = item.id;
  deny.dataset.optionId = "cancelled";
  deny.disabled = item.status !== "pending";
  deny.textContent = "Deny";
  actions.append(deny);

  if (item.preview) {
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "approval-btn preview";
    previewBtn.dataset.previewId = item.id;
    previewBtn.disabled = item.status !== "pending";
    previewBtn.textContent = "Preview";
    actions.append(previewBtn);
  }

  body.append(actions);

  if (item.preview) {
    body.append(renderDiffMiniPreview(item.preview, item.id));
  }

  if (item.status === "selected") {
    const resolved = document.createElement("div");
    resolved.className = "approval-resolved";
    resolved.textContent = "Approved";
    body.append(resolved);
  } else if (item.status === "cancelled") {
    const resolved = document.createElement("div");
    resolved.className = "approval-resolved cancelled";
    resolved.textContent = "Denied";
    body.append(resolved);
  }

  wrapper.append(body);
  return wrapper;
}

function approvalButton(
  item: Extract<ChatItem, { type: "approval" }>,
  option: { optionId: string; name: string; kind: string },
  label: string,
  primary: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = primary ? "approval-btn primary" : "approval-btn";
  button.dataset.approvalId = item.id;
  button.dataset.optionId = option.optionId;
  button.disabled = item.status !== "pending";
  button.textContent = label;
  return button;
}

// -- diff mini preview --

function renderDiffMiniPreview(preview: ChangePreview, id: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "diff-mini";

  const header = document.createElement("div");
  header.className = "diff-mini-header";

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "diff-expand-btn";
  expandBtn.dataset.previewId = id;
  const chevron = document.createElement("span");
  chevron.className = "codicon codicon-chevron-down";
  chevron.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = "Diff preview";
  expandBtn.append(chevron, label);
  header.append(expandBtn);

  const stat = document.createElement("span");
  stat.className = "diff-stat";
  stat.innerHTML = `<span class="diff-added">+${preview.added}</span> <span class="diff-removed">-${preview.removed}</span>`;
  header.append(stat);

  container.append(header);

  if (preview.diff) {
    const lines = preview.diff.split("\n");
    const pre = document.createElement("pre");
    pre.className = "diff-content";

    const visible = lines.slice(0, 12);
    for (const line of visible) {
      const lineEl = document.createElement("div");
      lineEl.className = `diff-line ${diffLineClass(line)}`;
      lineEl.textContent = line;
      pre.append(lineEl);
    }

    if (lines.length > 12) {
      const more = document.createElement("div");
      more.className = "diff-more";
      more.textContent = `... ${lines.length - 12} more lines`;
      pre.append(more);
    }

    container.append(pre);
  }

  return container;
}

// -- helpers --

function renderEmptyState(state: Snapshot): HTMLElement {
  const node = document.createElement("section");
  node.className = "empty-state";

  const icon = document.createElement("span");
  icon.className = `codicon ${state.hasWorkspace ? "codicon-sparkle" : "codicon-folder-opened"} empty-icon`;

  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = state.hasWorkspace ? (state.disconnected ? "Reasonix" : "Ready") : "Open a project folder";

  const detail = document.createElement("div");
  detail.className = "empty-detail";
  detail.textContent = state.hasWorkspace
    ? state.disconnected
      ? "Start a session to begin"
      : state.workspace
    : "Reasonix needs a workspace so it can read files, preview diffs, and run commands in the right project.";

  const actions = document.createElement("div");
  actions.className = "empty-actions";
  if (state.hasWorkspace) {
    actions.append(emptyButton("newSession", "Start session"), emptyButton("insertSelection", "Add context"));
  } else {
    const open = emptyButton("openFolder", "Open Folder");
    open.classList.add("primary");
    actions.append(open);
  }

  node.append(icon, title, detail, actions);
  return node;
}

function renderStartFailedState(state: Snapshot): HTMLElement {
  const node = document.createElement("section");
  node.className = "empty-state failure-state";

  const icon = document.createElement("span");
  icon.className = "codicon codicon-warning empty-icon";

  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = "Reasonix start failed";

  const detail = document.createElement("div");
  detail.className = "empty-detail";
  detail.textContent = `Could not start Reasonix in ${state.workspace}.`;

  const error = document.createElement("pre");
  error.className = "failure-detail";
  error.textContent = state.startError ?? "Unknown startup error";

  const actions = document.createElement("div");
  actions.className = "empty-actions";
  const retry = emptyButton("newSession", "Retry");
  retry.classList.add("primary");
  actions.append(retry, emptyButton("openSettings", "Settings"), emptyButton("showOutput", "Output"));

  node.append(icon, title, detail, error, actions);
  return node;
}

function detailsBlock(summaryText: string, text: string): HTMLElement {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  const pre = document.createElement("pre");
  pre.textContent = text;
  details.append(summary, pre);
  return details;
}

function renderSurfaces(surfaces: SurfaceListResult | undefined): void {
  surfaceBar.textContent = "";
  if (!snapshot.hasWorkspace || snapshot.startError !== undefined) {
    surfaceBar.hidden = true;
    return;
  }
  surfaceBar.hidden = false;
  surfaceBar.append(staticSurfaceChip("code", "selection", "+40"));
  surfaceBar.append(staticSurfaceChip("folder", "workspace"));
  surfaceBar.append(staticSurfaceChip("plug", "MCP"));
  surfaceBar.append(staticSurfaceChip("terminal", "/ commands"));
  const chips = surfaces?.slashCompletions?.slice(0, 4) ?? [];
  surfaceBar.hidden = false;
  for (const chip of chips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.insert = chip.insert;
    button.title = chip.hint ?? chip.label;
    button.textContent = chip.label;
    surfaceBar.append(button);
  }
}

function staticSurfaceChip(icon: string, label: string, suffix?: string): HTMLElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip surface-chip-static";
  const glyph = document.createElement("span");
  glyph.className = `codicon codicon-${icon}`;
  glyph.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = label;
  chip.append(glyph, text);
  if (suffix) {
    const suffixNode = document.createElement("span");
    suffixNode.className = "chip-suffix";
    suffixNode.textContent = suffix;
    chip.append(suffixNode);
  }
  return chip;
}

function toolSubtitle(item: Extract<ChatItem, { type: "tool" }>): string {
  if (item.preview?.path) {
    return item.preview.path;
  }
  const raw = item.rawInput;
  if (isRecord(raw)) {
    const path = raw.path;
    if (typeof path === "string") {
      return path;
    }
    const command = raw.command ?? raw.cmd;
    if (typeof command === "string") {
      return command;
    }
  }
  return "";
}

function toolStatusClass(item: Extract<ChatItem, { type: "tool" }>): string {
  if (item.status === "completed" || item.status === "success") {
    return "completed";
  }
  if (item.status === "failed" || item.status === "error") {
    return "failed";
  }
  if (item.status === "pending" && (item.kind === "edit" || item.kind === "write" || item.preview)) {
    return "approval-needed";
  }
  return "pending";
}

function toolStatusLabel(item: Extract<ChatItem, { type: "tool" }>): string {
  switch (toolStatusClass(item)) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "approval-needed":
      return "Approval needed";
    default:
      return "Waiting";
  }
}

function approvalOperationLabel(kind: string): string {
  switch (kind) {
    case "edit":
    case "write":
    case "multi_edit":
      return "writes file";
    case "read":
    case "search":
    case "grep":
      return "reads context";
    case "execute":
    case "bash":
    case "shell":
      return "runs command";
    default:
      return "needs approval";
  }
}

function insertAtCursor(text: string): void {
  const before = prompt.value.slice(0, prompt.selectionStart);
  const after = prompt.value.slice(prompt.selectionEnd);
  const sep = before.trim() === "" || text.trim() === "" ? "" : "\n\n";
  prompt.value = before + sep + text + after;
  prompt.focus();
  resizePrompt();
}

function appendNotice(text: string): void {
  snapshot.items.push({ type: "message", role: "notice", text });
  render(snapshot);
}

function isUiCommand(command: string | undefined): command is "newSession" | "insertSelection" | "openFolder" | "pickWorkspace" | "openSettings" | "showOutput" {
  return (
    command === "newSession" ||
    command === "insertSelection" ||
    command === "openFolder" ||
    command === "pickWorkspace" ||
    command === "openSettings" ||
    command === "showOutput"
  );
}

function timelineLine(): HTMLElement {
  const line = document.createElement("span");
  line.className = "timeline-line";
  return line;
}

function contextLabel(state: Snapshot): string {
  const usage = state.usage ? ` / cache ${cachePercent(state.usage.sessionCacheHitTokens, state.usage.sessionCacheMissTokens)}` : "";
  return `Context: ${contextModeLabel(state.contextMode)}${usage}`;
}

function submitPrompt(): void {
  const text = prompt.value.trim();
  if (text === "" || snapshot.running || !snapshot.hasWorkspace || snapshot.startError !== undefined) {
    return;
  }
  vscode.postMessage({ command: "sendPrompt", text });
  prompt.value = "";
  resizePrompt();
}

function resizePrompt(): void {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
}

function metric(label: string, value: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "metric";
  const name = document.createElement("span");
  name.textContent = label;
  const count = document.createElement("strong");
  count.textContent = value;
  node.append(name, count);
  return node;
}

function emptyButton(command: "newSession" | "insertSelection" | "openFolder" | "openSettings" | "showOutput", text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.dataset.command = command;
  button.textContent = text;
  return button;
}

function mustElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing element #${id}`);
  }
  return node;
}

function normalizeSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) {
    return emptySnapshot();
  }
  return {
    items: Array.isArray(value.items) ? (value.items as ChatItem[]) : [],
    running: value.running === true,
    disconnected: value.disconnected === true,
    status: typeof value.status === "string" ? value.status : "Idle",
    workspace: typeof value.workspace === "string" ? value.workspace : "No workspace",
    hasWorkspace: value.hasWorkspace === true,
    startError: typeof value.startError === "string" ? value.startError : undefined,
    contextMode: typeof value.contextMode === "string" ? value.contextMode : "selectionOnly",
    modelLabel: typeof value.modelLabel === "string" ? value.modelLabel : "Default model",
    usage: isRecord(value.usage) ? (value.usage as unknown as UsageData) : undefined,
    surfaces: isRecord(value.surfaces) ? (value.surfaces as unknown as SurfaceListResult) : undefined,
  };
}

function emptySnapshot(): Snapshot {
  return {
    items: [],
    running: false,
    disconnected: true,
    status: "Idle",
    workspace: "No workspace",
    hasWorkspace: false,
    contextMode: "selectionOnly",
    modelLabel: "Default model",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
