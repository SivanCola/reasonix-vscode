import type { ChangePreview, SurfaceListResult, UsageData } from "./acpTypes";
import type { ChatItem } from "./chatState";
import type { HostToWebviewMessage } from "./webviewProtocol";

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
  contextMode: string;
  usage?: UsageData;
  surfaces?: SurfaceListResult;
};

const vscode = acquireVsCodeApi();
const transcript = mustElement("transcript");
const prompt = mustElement("prompt") as HTMLTextAreaElement;
const status = mustElement("status");
const statusDot = mustElement("statusDot");
const workspaceName = mustElement("workspaceName");
const send = mustElement("send") as HTMLButtonElement;
const cancel = mustElement("cancel") as HTMLButtonElement;
const newSession = mustElement("newSession") as HTMLButtonElement;
const insertSelection = mustElement("insertSelection") as HTMLButtonElement;
const composer = mustElement("composer") as HTMLFormElement;
const contextHint = mustElement("contextHint");
const surfaceBar = mustElement("surfaceBar");

let snapshot: Snapshot = normalizeSnapshot(vscode.getState());
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

transcript.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-approval-id]");
  if (button) {
    vscode.postMessage({
      command: "approvalDecision",
      id: button.dataset.approvalId,
      optionId: button.dataset.optionId,
    });
    return;
  }

  const command = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-command]")?.dataset.command;
  if (command === "newSession" || command === "insertSelection") {
    vscode.postMessage({ command });
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
  status.textContent = state.disconnected ? `${state.status} disconnected` : state.status;
  status.title = state.workspace;
  statusDot.className = `status-dot ${state.running ? "running" : state.disconnected ? "disconnected" : "ready"}`;
  workspaceName.textContent = state.workspace;
  workspaceName.title = state.workspace;
  send.disabled = state.running;
  newSession.disabled = state.running;
  cancel.hidden = !state.running;
  cancel.disabled = !state.running;
  contextHint.textContent = contextLabel(state);
  renderSurfaces(state.surfaces);

  transcript.textContent = "";
  if (state.items.length === 0) {
    transcript.append(renderEmptyState(state));
    return;
  }

  for (const item of state.items) {
    transcript.append(renderItem(item));
  }
  transcript.scrollTop = transcript.scrollHeight;
  resizePrompt();
}

function renderItem(item: ChatItem): HTMLElement {
  switch (item.type) {
    case "message":
      return renderMessage(item);
    case "tool":
      return renderTool(item);
    case "usage":
      return renderUsage(item.usage);
    case "approval":
      return renderApproval(item);
  }
}

function renderMessage(item: Extract<ChatItem, { type: "message" }>): HTMLElement {
  const node = document.createElement("section");
  node.className = `item ${item.role}`;
  const role = document.createElement("div");
  role.className = "role";
  role.textContent = item.role;
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = item.text;
  node.append(role, text);
  return node;
}

function renderEmptyState(state: Snapshot): HTMLElement {
  const node = document.createElement("section");
  node.className = "empty-state";
  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = state.disconnected ? "Reasonix is idle" : "Ready";
  const detail = document.createElement("div");
  detail.className = "empty-detail";
  detail.textContent = state.workspace;
  const actions = document.createElement("div");
  actions.className = "empty-actions";
  actions.append(emptyButton("newSession", "Start"), emptyButton("insertSelection", "Add context"));
  node.append(title, detail, actions);
  return node;
}

function renderTool(item: Extract<ChatItem, { type: "tool" }>): HTMLElement {
  const node = document.createElement("section");
  node.className = "item tool";
  const meta = document.createElement("div");
  meta.className = "tool-meta";
  const title = document.createElement("div");
  title.className = "tool-title";
  title.textContent = item.title;
  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = `${item.kind} / ${item.status}`;
  meta.append(title, badge);
  node.append(meta);

  if (item.preview) {
    node.append(previewBlock(item.preview));
  }
  if (item.rawInput !== undefined) {
    node.append(detailsBlock("Input", stableStringify(item.rawInput)));
  }
  if (item.content) {
    node.append(detailsBlock("Result", item.content));
  }
  return node;
}

function renderApproval(item: Extract<ChatItem, { type: "approval" }>): HTMLElement {
  const node = document.createElement("section");
  node.className = `item approval ${item.status}`;

  const meta = document.createElement("div");
  meta.className = "tool-meta";
  const title = document.createElement("div");
  title.className = "tool-title";
  title.textContent = item.title;
  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = item.status === "pending" ? `${item.kind} approval` : item.status;
  meta.append(title, badge);
  node.append(meta);

  if (item.preview) {
    node.append(previewBlock(item.preview));
  }
  if (item.rawInput !== undefined) {
    node.append(detailsBlock("Input", stableStringify(item.rawInput)));
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  for (const option of item.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.approvalId = item.id;
    button.dataset.optionId = option.optionId;
    button.disabled = item.status !== "pending";
    button.textContent = approvalLabel(option);
    actions.append(button);
  }
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "secondary";
  reject.dataset.approvalId = item.id;
  reject.dataset.optionId = "cancelled";
  reject.disabled = item.status !== "pending";
  reject.textContent = "Reject";
  actions.append(reject);
  node.append(actions);

  return node;
}

function renderUsage(usage: UsageData): HTMLElement {
  const node = document.createElement("section");
  node.className = "item usage";
  const role = document.createElement("div");
  role.className = "role";
  role.textContent = "usage";
  const text = document.createElement("div");
  text.className = "usage-grid";
  text.append(metric("Tokens", formatNumber(usage.totalTokens)));
  text.append(metric("Input", formatNumber(usage.promptTokens)));
  text.append(metric("Output", formatNumber(usage.completionTokens)));
  text.append(metric("Cache", cacheLabel(usage.sessionCacheHitTokens, usage.sessionCacheMissTokens)));
  if (usage.cost !== undefined) {
    text.append(metric("Cost", `${usage.currency ?? ""}${usage.cost.toFixed(4)}`));
  }
  node.append(role, text);

  if (usage.cacheDiagnostics) {
    const reasons = usage.cacheDiagnostics.prefixChangeReasons?.join("\n") ?? "";
    node.append(
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

  return node;
}

function previewBlock(preview: ChangePreview): HTMLElement {
  const label = `${preview.path} / +${preview.added} -${preview.removed}`;
  if (preview.diff) {
    return detailsBlock(label, preview.diff);
  }
  return detailsBlock(label, stableStringify({ kind: preview.kind, path: preview.path, added: preview.added, removed: preview.removed }));
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
}

function appendNotice(text: string): void {
  snapshot.items.push({ type: "message", role: "notice", text });
  render(snapshot);
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
    contextMode: typeof value.contextMode === "string" ? value.contextMode : "selectionOnly",
    usage: isRecord(value.usage) ? (value.usage as unknown as UsageData) : undefined,
    surfaces: isRecord(value.surfaces) ? (value.surfaces as unknown as SurfaceListResult) : undefined,
  };
}

function emptySnapshot(): Snapshot {
  return { items: [], running: false, disconnected: true, status: "Idle", workspace: "No workspace", contextMode: "selectionOnly" };
}

function contextLabel(state: Snapshot): string {
  const usage = state.usage ? ` / cache ${cachePercent(state.usage.sessionCacheHitTokens, state.usage.sessionCacheMissTokens)}` : "";
  return `${state.contextMode}${usage}`;
}

function submitPrompt(): void {
  const text = prompt.value.trim();
  if (text === "" || snapshot.running) {
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

function cacheLabel(hit: number, miss: number): string {
  const total = hit + miss;
  if (total <= 0) {
    return "n/a";
  }
  return `${Math.round((hit / total) * 100)}% (${formatNumber(hit)} cached / ${formatNumber(miss)} new)`;
}

function cachePercent(hit: number, miss: number): string {
  const total = hit + miss;
  if (total <= 0) {
    return "n/a";
  }
  return `${Math.round((hit / total) * 100)}%`;
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

function approvalLabel(option: { name: string; kind: string }): string {
  switch (option.kind) {
    case "allow_once":
      return "Once";
    case "allow_always":
      return "Session";
    case "allow_persistent":
      return "Always";
    default:
      return option.name;
  }
}

function emptyButton(command: "newSession" | "insertSelection", text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.dataset.command = command;
  button.textContent = text;
  return button;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function mustElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing element #${id}`);
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
