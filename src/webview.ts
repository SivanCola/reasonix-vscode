import type { ChangePreview, SurfaceListResult, UsageData } from "./acpTypes";
import type { ChatItem } from "./chatState";
import { shouldSubmitPromptOnKeydown } from "./keyboard";
import type { HostToWebviewMessage } from "./webviewProtocol";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

type IncludeSelectionMode = "off" | "selectionOnly" | "nearby";

type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

type Snapshot = {
  items: ChatItem[];
  running: boolean;
  disconnected: boolean;
  status: string;
  workspace: string;
  contextMode: IncludeSelectionMode;
  contextSummary?: string;
  usage?: UsageData;
  surfaces?: SurfaceListResult;
  modelLabel: string;
  cacheLabel?: string;
  locale: string;
  sessionId?: string;
  sessions: SessionSummary[];
};

const vscode = acquireVsCodeApi();
const transcript = mustElement("transcript");
const prompt = mustElement("prompt") as HTMLTextAreaElement;
const status = mustElement("status");
const statusDot = mustElement("statusDot");
const workspaceName = mustElement("workspaceName");
const toolbarMeta = mustElement("toolbarMeta");
const send = mustElement("send") as HTMLButtonElement;
const newSession = mustElement("newSession") as HTMLButtonElement;
const insertSelection = mustElement("insertSelection") as HTMLButtonElement;
const composer = mustElement("composer") as HTMLFormElement;
const surfaceBar = mustElement("surfaceBar");
const contextModeButton = mustElement("contextModeButton") as HTMLButtonElement;
const contextSummary = mustElement("contextSummary");
const contextMenu = mustElement("contextMenu");
const sessionMenu = mustElement("sessionMenu") as HTMLButtonElement;
const sessionPopover = mustElement("sessionPopover");
const modelButton = mustElement("modelButton") as HTMLButtonElement;
const outputButton = mustElement("outputButton") as HTMLButtonElement;

let snapshot: Snapshot = normalizeSnapshot(vscode.getState());
let contextMenuOpen = false;
let sessionMenuOpen = false;
let compositionActive = false;
render(snapshot);

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPrompt();
});

prompt.addEventListener("keydown", (event) => {
  if (shouldSubmitPromptOnKeydown(event, compositionActive)) {
    event.preventDefault();
    submitPrompt();
  }
});

prompt.addEventListener("compositionstart", () => {
  compositionActive = true;
});

prompt.addEventListener("compositionend", () => {
  compositionActive = false;
});

prompt.addEventListener("input", () => {
  resizePrompt();
  updateSendButton(snapshot);
});

newSession.addEventListener("click", () => vscode.postMessage({ command: "newSession" }));
insertSelection.addEventListener("click", () => vscode.postMessage({ command: "insertSelection" }));
modelButton.addEventListener("click", () => vscode.postMessage({ command: "pickModel" }));
outputButton.addEventListener("click", () => vscode.postMessage({ command: "showOutput" }));

contextModeButton.addEventListener("click", (event) => {
  event.stopPropagation();
  contextMenuOpen = !contextMenuOpen;
  sessionMenuOpen = false;
  renderMenus(snapshot);
});

sessionMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  sessionMenuOpen = !sessionMenuOpen;
  contextMenuOpen = false;
  renderMenus(snapshot);
});

document.addEventListener("click", () => {
  if (!contextMenuOpen && !sessionMenuOpen) {
    return;
  }
  contextMenuOpen = false;
  sessionMenuOpen = false;
  renderMenus(snapshot);
});

contextMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-context-mode]");
  const mode = button?.dataset.contextMode;
  if (mode === "off" || mode === "selectionOnly" || mode === "nearby") {
    contextMenuOpen = false;
    vscode.postMessage({ command: "setContextMode", mode });
  }
});

sessionPopover.addEventListener("click", (event) => {
  event.stopPropagation();
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-session-id]");
  const sessionId = button?.dataset.sessionId;
  if (sessionId) {
    sessionMenuOpen = false;
    vscode.postMessage({ command: "loadSession", sessionId });
  }
});

transcript.addEventListener("click", (event) => {
  const target = event.target as Element | null;

  const approval = target?.closest<HTMLButtonElement>("button[data-approval-id]");
  if (approval) {
    vscode.postMessage({
      command: "approvalDecision",
      id: approval.dataset.approvalId,
      optionId: approval.dataset.optionId,
    });
    return;
  }

  const copy = target?.closest<HTMLButtonElement>("button[data-copy-text]");
  if (copy) {
    vscode.postMessage({ command: "copyText", text: copy.dataset.copyText ?? "" });
    flashButton(copy, label("copied"));
    return;
  }

  const messageAction = target?.closest<HTMLButtonElement>("button[data-message-action]");
  if (messageAction) {
    const index = Number(messageAction.dataset.itemIndex);
    const action = messageAction.dataset.messageAction;
    if (Number.isInteger(index)) {
      if (action === "insert") {
        vscode.postMessage({ command: "insertMessage", index });
      } else if (action === "retry") {
        vscode.postMessage({ command: "retryMessage", index });
      } else if (action === "continue") {
        vscode.postMessage({ command: "continueMessage", index });
      }
    }
    return;
  }

  const toolPreview = target?.closest<HTMLButtonElement>("button[data-tool-preview]");
  if (toolPreview) {
    const index = Number(toolPreview.dataset.itemIndex);
    if (Number.isInteger(index)) {
      vscode.postMessage({ command: "openToolPreview", index });
    }
    return;
  }

  const command = target?.closest<HTMLButtonElement>("button[data-command]")?.dataset.command;
  if (command === "newSession" || command === "insertSelection") {
    vscode.postMessage({ command });
    return;
  }

  const quick = target?.closest<HTMLButtonElement>("button[data-quick-prompt]")?.dataset.quickPrompt;
  if (quick === "explainFile" || quick === "fixSelection" || quick === "runTests" || quick === "searchRepo") {
    vscode.postMessage({ command: "quickPrompt", action: quick });
    return;
  }

  const link = target?.closest<HTMLAnchorElement>("a[data-href]");
  if (link) {
    event.preventDefault();
    vscode.postMessage({ command: "openExternal", href: link.dataset.href ?? "" });
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

function render(state: Snapshot): void {
  const shouldStickToBottom = state.running || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;

  status.textContent = state.disconnected ? `${state.status} disconnected` : state.status;
  status.title = state.workspace;
  statusDot.className = `status-dot ${state.running ? "running" : state.disconnected ? "disconnected" : "ready"}`;
  workspaceName.textContent = state.workspace;
  workspaceName.title = state.workspace;
  toolbarMeta.textContent = toolbarMetaText(state);
  sessionMenu.textContent = label("sessions");
  newSession.textContent = label("new");
  modelButton.textContent = shortModelLabel(state.modelLabel);
  modelButton.title = `${label("model")}: ${state.modelLabel}`;
  outputButton.textContent = label("logs");
  insertSelection.textContent = label("add");
  prompt.placeholder = label("placeholder");
  newSession.disabled = state.running;
  updateContextUi(state);
  updateSendButton(state);
  renderSurfaces(state.surfaces);
  renderMenus(state);

  transcript.textContent = "";
  if (state.items.length === 0) {
    transcript.append(renderEmptyState(state));
  } else {
    state.items.forEach((item, index) => transcript.append(renderItem(item, index)));
  }

  if (shouldStickToBottom) {
    requestAnimationFrame(() => {
      transcript.scrollTop = transcript.scrollHeight;
    });
  }
  resizePrompt();
}

function updateContextUi(state: Snapshot): void {
  contextModeButton.textContent = `${label("context")}: ${contextModeLabel(state.contextMode)}`;
  contextModeButton.title = contextModeDetail(state.contextMode);
  if (state.contextMode === "off") {
    contextSummary.textContent = label("contextOff");
  } else {
    contextSummary.textContent = state.contextSummary ?? label("noContext");
  }
}

function updateSendButton(state: Snapshot): void {
  send.textContent = state.running ? label("stop") : label("send");
  send.title = state.running ? label("stopTurn") : label("sendShortcut");
  send.classList.toggle("danger", state.running);
  send.disabled = !state.running && prompt.value.trim() === "";
}

function renderMenus(state: Snapshot): void {
  renderContextMenu(state);
  renderSessionPopover(state);
}

function renderContextMenu(state: Snapshot): void {
  contextMenu.textContent = "";
  for (const mode of ["selectionOnly", "nearby", "off"] satisfies IncludeSelectionMode[]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.contextMode = mode;
    button.className = mode === state.contextMode ? "menu-row selected" : "menu-row";
    const title = document.createElement("span");
    title.textContent = contextModeLabel(mode);
    const detail = document.createElement("small");
    detail.textContent = contextModeDetail(mode);
    button.append(title, detail);
    contextMenu.append(button);
  }
  contextMenu.hidden = !contextMenuOpen;
}

function renderSessionPopover(state: Snapshot): void {
  sessionPopover.textContent = "";
  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = label("noSessions");
    sessionPopover.append(empty);
  } else {
    for (const session of state.sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.sessionId = session.id;
      button.className = session.id === state.sessionId ? "menu-row selected" : "menu-row";
      const title = document.createElement("span");
      title.textContent = session.title;
      const detail = document.createElement("small");
      detail.textContent = relativeTime(session.updatedAt);
      button.append(title, detail);
      sessionPopover.append(button);
    }
  }
  sessionPopover.hidden = !sessionMenuOpen;
}

function renderItem(item: ChatItem, index: number): HTMLElement {
  switch (item.type) {
    case "message":
      return renderMessage(item, index);
    case "tool":
      return renderTool(item, index);
    case "usage":
      return renderUsage(item.usage, index);
    case "approval":
      return renderApproval(item, index);
  }
}

function renderMessage(item: Extract<ChatItem, { type: "message" }>, index: number): HTMLElement {
  const node = document.createElement("section");
  node.className = `item message ${item.role}`;

  if (item.role === "thought") {
    node.append(renderThought(item.text, index));
    return node;
  }

  node.append(renderItemHeader(roleLabel(item.role), messageActions(item, index)));
  const text = document.createElement("div");
  text.className = "text markdown-host";
  text.append(renderMarkdown(item.text));
  node.append(text);
  return node;
}

function renderThought(text: string, index: number): HTMLElement {
  const details = document.createElement("details");
  details.className = "thought-details";
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "thought-title";
  title.textContent = label("thoughtSummary");
  const preview = document.createElement("span");
  preview.className = "thought-preview";
  preview.textContent = firstLine(text);
  summary.append(title, preview);
  const body = document.createElement("div");
  body.className = "text markdown-host";
  body.append(renderMarkdown(text));
  details.append(summary, body);
  const actions = messageActions({ type: "message", role: "thought", text }, index);
  const actionRow = document.createElement("div");
  actionRow.className = "thought-actions";
  actionRow.append(actions);
  details.append(actionRow);
  return details;
}

function renderEmptyState(state: Snapshot): HTMLElement {
  const node = document.createElement("section");
  node.className = "empty-state";
  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = state.disconnected ? label("idleTitle") : label("readyTitle");
  const detail = document.createElement("div");
  detail.className = "empty-detail";
  detail.textContent = state.workspace;
  const actions = document.createElement("div");
  actions.className = "empty-actions";
  actions.append(
    quickButton("explainFile", label("explainFile")),
    quickButton("fixSelection", label("fixSelection")),
    quickButton("runTests", label("runTests")),
    quickButton("searchRepo", label("searchRepo")),
  );
  const secondary = document.createElement("div");
  secondary.className = "empty-actions secondary-row";
  secondary.append(emptyButton("newSession", label("start")), emptyButton("insertSelection", label("addContext")));
  node.append(title, detail, actions, secondary);
  return node;
}

function renderTool(item: Extract<ChatItem, { type: "tool" }>, index: number): HTMLElement {
  const node = document.createElement("section");
  node.className = `item tool ${statusClass(item.status)}`;
  const actions = document.createElement("div");
  actions.className = "message-actions";
  if (item.content || item.rawInput !== undefined) {
    actions.append(copyButton(item.content ?? stableStringify(item.rawInput), label("copy")));
  }
  if (item.preview) {
    actions.append(toolPreviewButton(index));
  }
  node.append(renderToolHeader(item.title, `${kindLabel(item.kind)} / ${statusLabel(item.status)}`, actions));

  if (item.preview) {
    node.append(previewBlock(item.preview));
  }
  if (item.rawInput !== undefined) {
    node.append(detailsBlock(label("input"), stableStringify(item.rawInput)));
  }
  if (item.content) {
    node.append(detailsBlock(label("result"), item.content));
  }
  return node;
}

function renderApproval(item: Extract<ChatItem, { type: "approval" }>, index: number): HTMLElement {
  const node = document.createElement("section");
  node.className = `item approval ${item.status}`;

  const actions = document.createElement("div");
  actions.className = "message-actions";
  if (item.rawInput !== undefined) {
    actions.append(copyButton(stableStringify(item.rawInput), label("copy")));
  }
  if (item.preview) {
    actions.append(toolPreviewButton(index));
  }
  node.append(renderToolHeader(item.title, item.status === "pending" ? `${kindLabel(item.kind)} ${label("approval")}` : statusLabel(item.status), actions));

  if (item.preview) {
    node.append(previewBlock(item.preview));
  }
  if (item.rawInput !== undefined) {
    node.append(detailsBlock(label("input"), stableStringify(item.rawInput)));
  }

  const approvalActions = document.createElement("div");
  approvalActions.className = "approval-actions";
  for (const option of item.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.approvalId = item.id;
    button.dataset.optionId = option.optionId;
    button.disabled = item.status !== "pending";
    button.textContent = approvalLabel(option);
    approvalActions.append(button);
  }
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "secondary";
  reject.dataset.approvalId = item.id;
  reject.dataset.optionId = "cancelled";
  reject.disabled = item.status !== "pending";
  reject.textContent = label("reject");
  approvalActions.append(reject);
  node.append(approvalActions);

  return node;
}

function renderUsage(usage: UsageData, index: number): HTMLElement {
  const node = document.createElement("section");
  node.className = "item usage";
  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.append(copyButton(stableStringify(usage), label("copy")));
  node.append(renderItemHeader(label("usage"), actions));
  const text = document.createElement("div");
  text.className = "usage-grid";
  text.append(metric(label("tokens"), formatNumber(usage.totalTokens)));
  text.append(metric(label("inputTokens"), formatNumber(usage.promptTokens)));
  text.append(metric(label("outputTokens"), formatNumber(usage.completionTokens)));
  text.append(metric(label("cache"), cacheLabel(usage.sessionCacheHitTokens, usage.sessionCacheMissTokens)));
  if (usage.reasoningTokens !== undefined) {
    text.append(metric(label("reasoning"), formatNumber(usage.reasoningTokens)));
  }
  if (usage.cost !== undefined) {
    text.append(metric(label("cost"), `${usage.currency ?? ""}${usage.cost.toFixed(4)}`));
  }
  node.append(text);

  if (usage.cacheDiagnostics) {
    const reasons = usage.cacheDiagnostics.prefixChangeReasons?.join("\n") ?? "";
    node.append(
      detailsBlock(
        label("cacheDiagnostics"),
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

  node.dataset.itemIndex = String(index);
  return node;
}

function renderItemHeader(titleText: string, actions?: HTMLElement): HTMLElement {
  const header = document.createElement("div");
  header.className = "item-header";
  const role = document.createElement("div");
  role.className = "role";
  role.textContent = titleText;
  header.append(role);
  if (actions) {
    header.append(actions);
  }
  return header;
}

function renderToolHeader(titleText: string, badgeText: string, actions?: HTMLElement): HTMLElement {
  const meta = document.createElement("div");
  meta.className = "tool-meta";
  const left = document.createElement("div");
  left.className = "tool-heading";
  const title = document.createElement("div");
  title.className = "tool-title";
  title.textContent = titleText;
  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = badgeText;
  left.append(title, badge);
  meta.append(left);
  if (actions) {
    meta.append(actions);
  }
  return meta;
}

function messageActions(item: Extract<ChatItem, { type: "message" }>, index: number): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.append(copyButton(item.text, label("copy")));
  if (item.role === "user") {
    actions.append(messageActionButton("retry", index, label("retry")));
  }
  if (item.role === "assistant") {
    actions.append(messageActionButton("insert", index, label("insert")));
    actions.append(messageActionButton("continue", index, label("continue")));
  }
  return actions;
}

function messageActionButton(action: "insert" | "retry" | "continue", index: number, text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "micro-button";
  button.dataset.messageAction = action;
  button.dataset.itemIndex = String(index);
  button.textContent = text;
  return button;
}

function copyButton(text: string, labelText: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "micro-button";
  button.dataset.copyText = text;
  button.textContent = labelText;
  return button;
}

function toolPreviewButton(index: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "micro-button";
  button.dataset.toolPreview = "true";
  button.dataset.itemIndex = String(index);
  button.textContent = label("openDiff");
  return button;
}

function previewBlock(preview: ChangePreview): HTMLElement {
  const labelText = `${preview.path} / +${preview.added} -${preview.removed}`;
  if (preview.diff) {
    return detailsBlock(labelText, preview.diff);
  }
  return detailsBlock(labelText, stableStringify({ kind: preview.kind, path: preview.path, added: preview.added, removed: preview.removed }));
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

function renderMarkdown(text: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "markdown";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = line.match(/^```([\w.+-]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      root.append(codeBlock(code.join("\n"), language));
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const list = document.createElement("ul");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        const item = document.createElement("li");
        appendInline(item, (lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        list.append(item);
        i += 1;
      }
      root.append(list);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const list = document.createElement("ol");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        const item = document.createElement("li");
        appendInline(item, (lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        list.append(item);
        i += 1;
      }
      root.append(list);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 2;
      const h = document.createElement(`h${level + 2}`) as HTMLHeadingElement;
      appendInline(h, heading[2] ?? "");
      root.append(h);
      i += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^```/.test(lines[i] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[i] ?? "") &&
      !/^(#{1,3})\s+/.test(lines[i] ?? "")
    ) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    const p = document.createElement("p");
    appendInline(p, paragraph.join("\n"));
    root.append(p);
  }
  return root;
}

function appendInline(parent: HTMLElement, text: string): void {
  const pattern = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(https?:\/\/[^\s<)]+)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, index)));
    }
    if (match[2]) {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      parent.append(strong);
    } else if (match[4]) {
      const code = document.createElement("code");
      code.textContent = match[4];
      parent.append(code);
    } else if (match[6] && match[7]) {
      parent.append(linkNode(match[6], match[7]));
    } else if (match[8]) {
      parent.append(linkNode(match[8], match[8]));
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    parent.append(document.createTextNode(text.slice(cursor)));
  }
}

function linkNode(text: string, href: string): HTMLElement {
  const safe = safeHref(href);
  if (!safe) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }
  const link = document.createElement("a");
  link.href = "#";
  link.dataset.href = safe;
  link.textContent = text;
  return link;
}

function codeBlock(code: string, language: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "code-block";
  const header = document.createElement("div");
  header.className = "code-header";
  const lang = document.createElement("span");
  lang.textContent = language || label("code");
  header.append(lang, copyButton(code, label("copy")));
  const pre = document.createElement("pre");
  const codeNode = document.createElement("code");
  codeNode.textContent = code;
  pre.append(codeNode);
  node.append(header, pre);
  return node;
}

function renderSurfaces(surfaces: SurfaceListResult | undefined): void {
  surfaceBar.textContent = "";
  const chips = surfaces?.slashCompletions?.slice(0, 8) ?? [];
  if (chips.length === 0) {
    surfaceBar.hidden = true;
    return;
  }
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

function insertAtCursor(text: string): void {
  const before = prompt.value.slice(0, prompt.selectionStart);
  const after = prompt.value.slice(prompt.selectionEnd);
  const sep = before.trim() === "" || text.trim() === "" ? "" : "\n\n";
  prompt.value = before + sep + text + after;
  prompt.focus();
  resizePrompt();
  updateSendButton(snapshot);
}

function appendNotice(text: string): void {
  snapshot.items.push({ type: "message", role: "notice", text });
  render(snapshot);
}

function submitPrompt(): void {
  if (snapshot.running) {
    vscode.postMessage({ command: "cancel" });
    return;
  }
  const text = prompt.value.trim();
  if (text === "") {
    return;
  }
  vscode.postMessage({ command: "sendPrompt", text });
  prompt.value = "";
  resizePrompt();
  updateSendButton(snapshot);
}

function resizePrompt(): void {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
}

function emptySnapshot(): Snapshot {
  return {
    items: [],
    running: false,
    disconnected: true,
    status: "Idle",
    workspace: "No workspace",
    contextMode: "selectionOnly",
    modelLabel: "Default model",
    locale: "en",
    sessions: [],
  };
}

function normalizeSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) {
    return emptySnapshot();
  }
  const contextMode = value.contextMode === "off" || value.contextMode === "nearby" || value.contextMode === "selectionOnly" ? value.contextMode : "selectionOnly";
  return {
    items: Array.isArray(value.items) ? (value.items as ChatItem[]) : [],
    running: value.running === true,
    disconnected: value.disconnected === true,
    status: typeof value.status === "string" ? value.status : "Idle",
    workspace: typeof value.workspace === "string" ? value.workspace : "No workspace",
    contextMode,
    contextSummary: typeof value.contextSummary === "string" ? value.contextSummary : undefined,
    usage: isRecord(value.usage) ? (value.usage as unknown as UsageData) : undefined,
    surfaces: isRecord(value.surfaces) ? (value.surfaces as unknown as SurfaceListResult) : undefined,
    modelLabel: typeof value.modelLabel === "string" ? value.modelLabel : "Default model",
    cacheLabel: typeof value.cacheLabel === "string" ? value.cacheLabel : undefined,
    locale: typeof value.locale === "string" ? value.locale : "en",
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    sessions: Array.isArray(value.sessions) ? (value.sessions as SessionSummary[]).filter(isSessionSummary) : [],
  };
}

function toolbarMetaText(state: Snapshot): string {
  const parts = [state.modelLabel];
  if (state.cacheLabel) {
    parts.push(state.cacheLabel);
  }
  return parts.join(" / ");
}

function cacheLabel(hit: number, miss: number): string {
  const total = hit + miss;
  if (total <= 0) {
    return "n/a";
  }
  return `${Math.round((hit / total) * 100)}% (${formatNumber(hit)} cached / ${formatNumber(miss)} new)`;
}

function contextModeLabel(mode: IncludeSelectionMode): string {
  switch (mode) {
    case "selectionOnly":
      return label("selection");
    case "nearby":
      return label("nearby");
    case "off":
      return label("off");
  }
}

function contextModeDetail(mode: IncludeSelectionMode): string {
  switch (mode) {
    case "selectionOnly":
      return label("selectionDetail");
    case "nearby":
      return label("nearbyDetail");
    case "off":
      return label("offDetail");
  }
}

function roleLabel(role: "user" | "assistant" | "thought" | "notice"): string {
  switch (role) {
    case "user":
      return label("user");
    case "assistant":
      return "Reasonix";
    case "thought":
      return label("thought");
    case "notice":
      return label("notice");
  }
}

function approvalLabel(option: { name: string; kind: string }): string {
  switch (option.kind) {
    case "allow_once":
      return label("once");
    case "allow_always":
      return label("session");
    case "allow_persistent":
      return label("always");
    default:
      return option.name;
  }
}

function statusLabel(statusValue: string): string {
  switch (statusValue) {
    case "pending":
      return label("pending");
    case "completed":
      return label("completed");
    case "failed":
      return label("failed");
    case "selected":
      return label("selected");
    case "cancelled":
      return label("cancelled");
    default:
      return statusValue;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "read":
      return label("read");
    case "edit":
      return label("edit");
    case "search":
      return label("search");
    case "execute":
      return label("execute");
    default:
      return kind || label("other");
  }
}

function statusClass(statusValue: string): string {
  return statusValue.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
}

function metric(labelText: string, value: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "metric";
  const name = document.createElement("span");
  name.textContent = labelText;
  const count = document.createElement("strong");
  count.textContent = value;
  node.append(name, count);
  return node;
}

function emptyButton(command: "newSession" | "insertSelection", text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.dataset.command = command;
  button.textContent = text;
  return button;
}

function quickButton(action: "explainFile" | "fixSelection" | "runTests" | "searchRepo", text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quick-action";
  button.dataset.quickPrompt = action;
  button.textContent = text;
  return button;
}

function flashButton(button: HTMLButtonElement, text: string): void {
  const previous = button.textContent ?? "";
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = previous;
  }, 900);
}

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 96 ? `${line.slice(0, 96)}...` : line;
}

function shortModelLabel(value: string): string {
  if (value === "Default model") {
    return label("model");
  }
  const compact = value.split("/").at(-1) ?? value;
  return compact.length > 16 ? `${compact.slice(0, 15)}...` : compact;
}

function relativeTime(value: number): string {
  const delta = Date.now() - value;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) {
    return label("justNow");
  }
  if (delta < hour) {
    return `${Math.floor(delta / minute)}m`;
  }
  if (delta < day) {
    return `${Math.floor(delta / hour)}h`;
  }
  return `${Math.floor(delta / day)}d`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, Object.keys(flattenKeys(value)).sort(), 2) ?? String(value);
}

function flattenKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenKeys(item, keys);
    }
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      keys[key] = true;
      flattenKeys(nested, keys);
    }
  }
  return keys;
}

function isSessionSummary(value: unknown): value is SessionSummary {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.updatedAt === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mustElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element;
}

type LabelKey =
  | "addContext"
  | "add"
  | "always"
  | "approval"
  | "cache"
  | "cacheDiagnostics"
  | "cancelled"
  | "code"
  | "completed"
  | "context"
  | "contextOff"
  | "continue"
  | "copied"
  | "copy"
  | "cost"
  | "edit"
  | "execute"
  | "explainFile"
  | "failed"
  | "fixSelection"
  | "idleTitle"
  | "input"
  | "inputTokens"
  | "insert"
  | "justNow"
  | "logs"
  | "model"
  | "nearby"
  | "nearbyDetail"
  | "new"
  | "noContext"
  | "noSessions"
  | "notice"
  | "off"
  | "offDetail"
  | "once"
  | "openDiff"
  | "other"
  | "outputTokens"
  | "pending"
  | "placeholder"
  | "read"
  | "readyTitle"
  | "reasoning"
  | "reject"
  | "result"
  | "retry"
  | "runTests"
  | "search"
  | "searchRepo"
  | "selected"
  | "selection"
  | "selectionDetail"
  | "send"
  | "sendShortcut"
  | "session"
  | "sessions"
  | "start"
  | "stop"
  | "stopTurn"
  | "thought"
  | "thoughtSummary"
  | "tokens"
  | "usage"
  | "user";

const labels: Record<"en" | "zh", Record<LabelKey, string>> = {
  en: {
    addContext: "Add context",
    add: "Add",
    always: "Always",
    approval: "approval",
    cache: "Cache",
    cacheDiagnostics: "Cache diagnostics",
    cancelled: "cancelled",
    code: "code",
    completed: "completed",
    context: "Context",
    contextOff: "No editor context",
    continue: "Continue",
    copied: "Copied",
    copy: "Copy",
    cost: "Cost",
    edit: "edit",
    execute: "execute",
    explainFile: "Explain file",
    failed: "failed",
    fixSelection: "Fix selection",
    idleTitle: "Reasonix is idle",
    input: "Input",
    inputTokens: "Input",
    insert: "Insert",
    justNow: "now",
    logs: "Logs",
    model: "Model",
    nearby: "Nearby code",
    nearbyDetail: "Use selected text, or a cursor window when nothing is selected.",
    new: "New",
    noContext: "No active editor context",
    noSessions: "No recent sessions",
    notice: "notice",
    off: "Off",
    offDetail: "Send prompts without editor context.",
    once: "Once",
    openDiff: "Open diff",
    other: "other",
    outputTokens: "Output",
    pending: "pending",
    placeholder: "Message Reasonix",
    read: "read",
    readyTitle: "Ready",
    reasoning: "Reasoning",
    reject: "Reject",
    result: "Result",
    retry: "Retry",
    runTests: "Run tests",
    search: "search",
    searchRepo: "Search repo",
    selected: "selected",
    selection: "Selection",
    selectionDetail: "Use the active selection only.",
    send: "Send",
    sendShortcut: "Send (Enter), newline (Shift+Enter)",
    session: "Session",
    sessions: "Sessions",
    start: "Start",
    stop: "Stop",
    stopTurn: "Stop turn",
    thought: "thought",
    thoughtSummary: "Reasoning summary",
    tokens: "Tokens",
    usage: "usage",
    user: "user",
  },
  zh: {
    addContext: "加入上下文",
    add: "加入",
    always: "总是允许",
    approval: "审批",
    cache: "缓存",
    cacheDiagnostics: "缓存诊断",
    cancelled: "已取消",
    code: "代码",
    completed: "已完成",
    context: "上下文",
    contextOff: "不带编辑器上下文",
    continue: "继续",
    copied: "已复制",
    copy: "复制",
    cost: "费用",
    edit: "编辑",
    execute: "执行",
    explainFile: "解释文件",
    failed: "失败",
    fixSelection: "修复选区",
    idleTitle: "Reasonix 空闲中",
    input: "输入",
    inputTokens: "输入",
    insert: "插入",
    justNow: "刚刚",
    logs: "日志",
    model: "模型",
    nearby: "附近代码",
    nearbyDetail: "优先使用选区，没有选区时使用光标附近代码。",
    new: "新建",
    noContext: "没有可用编辑器上下文",
    noSessions: "暂无最近会话",
    notice: "通知",
    off: "关闭",
    offDetail: "发送时不附加编辑器上下文。",
    once: "本次",
    openDiff: "打开 Diff",
    other: "其他",
    outputTokens: "输出",
    pending: "等待中",
    placeholder: "输入给 Reasonix 的消息",
    read: "读取",
    readyTitle: "准备就绪",
    reasoning: "推理",
    reject: "拒绝",
    result: "结果",
    retry: "重试",
    runTests: "运行测试",
    search: "搜索",
    searchRepo: "搜索仓库",
    selected: "已选择",
    selection: "仅选区",
    selectionDetail: "只使用当前编辑器选中的内容。",
    send: "发送",
    sendShortcut: "发送 (Enter)，换行 (Shift+Enter)",
    session: "会话",
    sessions: "会话",
    start: "开始",
    stop: "停止",
    stopTurn: "停止当前回合",
    thought: "思考",
    thoughtSummary: "思考摘要",
    tokens: "Tokens",
    usage: "用量",
    user: "用户",
  },
};

function label(key: LabelKey): string {
  return labels[snapshot.locale.toLowerCase().startsWith("zh") ? "zh" : "en"][key];
}
