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
};

const vscode = acquireVsCodeApi();
const transcript = mustElement("transcript");
const prompt = mustElement("prompt") as HTMLTextAreaElement;
const status = mustElement("status");
const send = mustElement("send") as HTMLButtonElement;
const cancel = mustElement("cancel") as HTMLButtonElement;
const newSession = mustElement("newSession") as HTMLButtonElement;
const insertSelection = mustElement("insertSelection") as HTMLButtonElement;
const composer = mustElement("composer") as HTMLFormElement;

let snapshot: Snapshot = normalizeSnapshot(vscode.getState());
render(snapshot);

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (text === "" || snapshot.running) {
    return;
  }
  vscode.postMessage({ command: "sendPrompt", text });
  prompt.value = "";
});

cancel.addEventListener("click", () => vscode.postMessage({ command: "cancel" }));
newSession.addEventListener("click", () => vscode.postMessage({ command: "newSession" }));
insertSelection.addEventListener("click", () => vscode.postMessage({ command: "insertSelection" }));

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
  status.textContent = state.disconnected ? `${state.status} · disconnected` : state.status;
  send.disabled = state.running;
  cancel.disabled = !state.running;

  transcript.textContent = "";
  if (state.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Start a Reasonix session from this workspace.";
    transcript.append(empty);
    return;
  }

  for (const item of state.items) {
    transcript.append(renderItem(item));
  }
  transcript.scrollTop = transcript.scrollHeight;
}

function renderItem(item: ChatItem): HTMLElement {
  if (item.type === "tool") {
    const node = document.createElement("section");
    node.className = "item tool";
    const meta = document.createElement("div");
    meta.className = "tool-meta";
    const title = document.createElement("div");
    title.className = "tool-title";
    title.textContent = item.title;
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = `${item.kind} · ${item.status}`;
    meta.append(title, badge);
    node.append(meta);

    if (item.rawInput !== undefined) {
      node.append(detailsBlock("Input", JSON.stringify(item.rawInput, null, 2)));
    }
    if (item.content) {
      node.append(detailsBlock("Result", item.content));
    }
    return node;
  }

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

function detailsBlock(summaryText: string, text: string): HTMLElement {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  const pre = document.createElement("pre");
  pre.textContent = text;
  details.append(summary, pre);
  return details;
}

function insertAtCursor(text: string): void {
  const before = prompt.value.slice(0, prompt.selectionStart);
  const after = prompt.value.slice(prompt.selectionEnd);
  const sep = before.trim() === "" ? "" : "\n\n";
  prompt.value = before + sep + text + after;
  prompt.focus();
}

function appendNotice(text: string): void {
  snapshot.items.push({ type: "message", role: "notice", text });
  render(snapshot);
}

function normalizeSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) {
    return { items: [], running: false, disconnected: true, status: "Idle" };
  }
  return {
    items: Array.isArray(value.items) ? (value.items as ChatItem[]) : [],
    running: value.running === true,
    disconnected: value.disconnected === true,
    status: typeof value.status === "string" ? value.status : "Idle",
  };
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
