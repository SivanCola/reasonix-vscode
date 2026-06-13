import type { ChangePreview, UsageData } from "./acpTypes";
import type { ChatItem } from "./chatState";
import { shouldSubmitPromptOnKeydown } from "./keyboard";
import type { HostToWebviewMessage } from "./webviewProtocol";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

type IncludeSelectionMode = "off" | "selectionOnly" | "nearby";
type UiLanguage = "auto" | "en" | "zh-CN";
type SettingKey = "binaryPath" | "model" | "uiLanguage" | "autoStart" | "trace" | "includeSelectionMode";
type CollaborationMode = "normal" | "plan" | "goal";
type TokenMode = "standard" | "economy";
type ToolApprovalMode = "ask" | "auto" | "yolo";
type SettingsTab = "connection" | "interface" | "behavior";

type SettingsSnapshot = {
  binaryPath: string;
  model: string;
  uiLanguage: UiLanguage;
  autoStart: boolean;
  trace: boolean;
  includeSelectionMode: IncludeSelectionMode;
};

type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

type McpSnapshot = {
  connected: string[];
  configured: string[];
  disconnected: string[];
};

type Snapshot = {
  items: ChatItem[];
  running: boolean;
  disconnected: boolean;
  status: string;
  workspace: string;
  contextMode: IncludeSelectionMode;
  usage?: UsageData;
  modelLabel: string;
  cacheLabel?: string;
  locale: string;
  uiLanguage: UiLanguage;
  settings: SettingsSnapshot;
  sessionId?: string;
  sessions: SessionSummary[];
  mcp: McpSnapshot;
};

const vscode = acquireVsCodeApi();
const transcript = mustElement("transcript");
const settingsView = mustElement("settingsView");
const prompt = mustElement("prompt") as HTMLTextAreaElement;
const status = mustElement("status");
const statusDot = mustElement("statusDot");
const workspaceName = mustElement("workspaceName");
const toolbarMeta = mustElement("toolbarMeta");
const send = mustElement("send") as HTMLButtonElement;
const collaborationButton = mustElement("collaborationButton") as HTMLButtonElement;
const collaborationMenu = mustElement("collaborationMenu");
const controlSummaryButton = mustElement("controlSummaryButton") as HTMLButtonElement;
const controlsMenu = mustElement("controlsMenu");
const controlsApprovalLabel = mustElement("controlsApprovalLabel");
const approvalModebar = mustElement("approvalModebar");
const composerHint = mustElement("composerHint");
const newSession = mustElement("newSession") as HTMLButtonElement;
const composer = mustElement("composer") as HTMLFormElement;
const sessionMenu = mustElement("sessionMenu") as HTMLButtonElement;
const sessionPopover = mustElement("sessionPopover");
const modelButton = mustElement("modelButton") as HTMLButtonElement;
const settingsButton = mustElement("settingsButton") as HTMLButtonElement;
const chatToolbarActions = mustElement("chatToolbarActions");
const settingsToolbarActions = mustElement("settingsToolbarActions");
const settingsBackButton = mustElement("settingsBackButton") as HTMLButtonElement;
const settingsModeTitle = mustElement("settingsModeTitle");

let snapshot: Snapshot = normalizeSnapshot(vscode.getState());
let sessionMenuOpen = false;
let collaborationMenuOpen = false;
let controlsMenuOpen = false;
let settingsOpen = false;
let settingsTab: SettingsTab = "connection";
let collaborationMode: CollaborationMode = "normal";
let tokenMode: TokenMode = "economy";
let toolApprovalMode: ToolApprovalMode = "ask";
let compositionActive = false;

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
modelButton.addEventListener("click", () => vscode.postMessage({ command: "pickModel" }));
settingsButton.addEventListener("click", () => {
  settingsOpen = true;
  settingsTab = "connection";
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  render(snapshot);
});
settingsBackButton.addEventListener("click", () => {
  settingsOpen = false;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  render(snapshot);
});

collaborationButton.addEventListener("click", (event) => {
  event.stopPropagation();
  collaborationMenuOpen = !collaborationMenuOpen;
  sessionMenuOpen = false;
  controlsMenuOpen = false;
  renderMenus(snapshot);
});

controlSummaryButton.addEventListener("click", (event) => {
  event.stopPropagation();
  controlsMenuOpen = !controlsMenuOpen;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  renderMenus(snapshot);
});

controlsMenu.addEventListener("click", (event) => {
  event.stopPropagation();
});

sessionMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  if (settingsOpen) {
    return;
  }
  sessionMenuOpen = !sessionMenuOpen;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  renderMenus(snapshot);
});

document.addEventListener("click", () => {
  if (!sessionMenuOpen && !collaborationMenuOpen && !controlsMenuOpen) {
    return;
  }
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  renderMenus(snapshot);
});

collaborationMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const target = event.target as Element | null;
  const collaboration = target?.closest<HTMLButtonElement>("button[data-collaboration-mode]")?.dataset.collaborationMode;
  if (isCollaborationMode(collaboration)) {
    collaborationMode = collaborationMode === collaboration ? "normal" : collaboration;
    collaborationMenuOpen = false;
    render(snapshot);
    return;
  }
  const token = target?.closest<HTMLButtonElement>("button[data-token-mode]")?.dataset.tokenMode;
  if (isTokenMode(token)) {
    tokenMode = tokenMode === token ? "standard" : token;
    collaborationMenuOpen = false;
    render(snapshot);
  }
});

approvalModebar.addEventListener("click", (event) => {
  const mode = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-tool-approval-mode]")?.dataset.toolApprovalMode;
  if (isToolApprovalMode(mode)) {
    toolApprovalMode = mode;
    updateModeUi();
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
  if (command === "newSession") {
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

settingsView.addEventListener("click", (event) => {
  const target = event.target as Element | null;
  const tab = target?.closest<HTMLButtonElement>("button[data-settings-tab]")?.dataset.settingsTab;
  if (isSettingsTab(tab)) {
    settingsTab = tab;
    renderSettings(snapshot);
    return;
  }

  const action = target?.closest<HTMLButtonElement>("button[data-settings-action]")?.dataset.settingsAction;
  if (action === "close") {
    settingsOpen = false;
    sessionMenuOpen = false;
    render(snapshot);
    return;
  }
  if (action === "pickModel") {
    vscode.postMessage({ command: "pickModel" });
    return;
  }
  if (action === "openNativeSettings") {
    vscode.postMessage({ command: "openNativeSettings" });
    return;
  }
  if (action === "showOutput") {
    vscode.postMessage({ command: "showOutput" });
    return;
  }

  const save = target?.closest<HTMLButtonElement>("button[data-save-setting]")?.dataset.saveSetting;
  if (save === "binaryPath" || save === "model") {
    saveTextSetting(save);
    return;
  }

  const option = target?.closest<HTMLButtonElement>("button[data-setting-key][data-setting-value]");
  const key = option?.dataset.settingKey;
  const value = option?.dataset.settingValue;
  if (key === "uiLanguage" && isUiLanguage(value)) {
    updateSetting(key, value);
    return;
  }
  if (key === "includeSelectionMode" && isContextMode(value)) {
    updateSetting(key, value);
  }
});

settingsView.addEventListener("change", (event) => {
  const checkbox = (event.target as Element | null)?.closest<HTMLInputElement>("input[type='checkbox'][data-setting-key]");
  const key = checkbox?.dataset.settingKey;
  if (checkbox && (key === "autoStart" || key === "trace")) {
    updateSetting(key, checkbox.checked);
  }
});

settingsView.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  const input = (event.target as Element | null)?.closest<HTMLInputElement>("input[data-text-setting]");
  const key = input?.dataset.textSetting;
  if (key === "binaryPath" || key === "model") {
    event.preventDefault();
    saveTextSetting(key);
  }
});

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "stateSnapshot":
      snapshot = normalizeSnapshot(message.state);
      vscode.setState(snapshot);
      render(snapshot);
      return;
    case "notice":
      appendNotice(message.text);
      return;
    case "openSettings":
      settingsOpen = true;
      render(snapshot);
      return;
  }
});

vscode.postMessage({ command: "stateSnapshot" });

function render(state: Snapshot): void {
  const shouldStickToBottom = !settingsOpen && (state.running || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80);

  status.textContent = state.disconnected ? label("disconnected") : state.status;
  status.title = state.workspace;
  statusDot.className = `status-dot ${state.running ? "running" : state.disconnected ? "disconnected" : "ready"}`;
  workspaceName.textContent = state.workspace;
  workspaceName.title = state.workspace;
  toolbarMeta.textContent = toolbarMetaText(state);
  sessionMenu.textContent = label("sessions");
  sessionMenu.textContent = "☰";
  sessionMenu.title = label("sessions");
  sessionMenu.setAttribute("aria-label", label("sessions"));
  newSession.textContent = "+";
  newSession.title = label("new");
  newSession.setAttribute("aria-label", label("new"));
  modelButton.textContent = shortModelLabel(state.modelLabel);
  modelButton.title = `${label("model")}: ${state.modelLabel}`;
  settingsButton.textContent = "⚙";
  settingsButton.title = label("settings");
  settingsButton.setAttribute("aria-label", label("settings"));
  settingsBackButton.textContent = label("done");
  settingsModeTitle.textContent = label("settings");
  collaborationButton.title = label("collaborationModes");
  collaborationButton.setAttribute("aria-label", label("collaborationModes"));
  controlsApprovalLabel.textContent = label("toolApprovals");
  controlSummaryButton.setAttribute("aria-label", label("composerControls"));
  composerHint.textContent = label("composerHint");
  prompt.placeholder = label("placeholder");
  newSession.disabled = state.running;
  chatToolbarActions.hidden = settingsOpen;
  settingsToolbarActions.hidden = !settingsOpen;
  transcript.hidden = settingsOpen;
  settingsView.hidden = !settingsOpen;
  composer.hidden = settingsOpen;
  if (settingsOpen) {
    sessionMenuOpen = false;
    collaborationMenuOpen = false;
    controlsMenuOpen = false;
  }
  updateSendButton(state);
  updateModeUi();
  renderMenus(state);
  renderSettings(state);

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

function updateSendButton(state: Snapshot): void {
  send.textContent = state.running ? label("stop") : "↑";
  send.title = state.running ? label("stopTurn") : label("sendShortcut");
  send.classList.toggle("danger", state.running);
  send.disabled = !state.running && prompt.value.trim() === "";
}

function updateModeUi(): void {
  approvalModebar.dataset.mode = toolApprovalMode;
  for (const button of Array.from(approvalModebar.querySelectorAll<HTMLButtonElement>("button[data-tool-approval-mode]"))) {
    const mode = button.dataset.toolApprovalMode;
    const selected = mode === toolApprovalMode;
    button.classList.toggle("composer-modebar__item--active", selected);
    button.setAttribute("aria-pressed", String(selected));
    if (mode === "ask") {
      button.textContent = label("ask");
      button.title = label("askDetail");
    } else if (mode === "auto") {
      button.textContent = label("autoApproval");
      button.title = label("autoApprovalDetail");
    } else if (mode === "yolo") {
      button.textContent = label("yolo");
      button.title = label("yoloDetail");
    }
  }
  renderControlSummary(snapshot);
}

function renderMenus(state: Snapshot): void {
  renderSessionPopover(state);
  renderCollaborationMenu();
  renderControlsMenu();
}

function renderControlSummary(state: Snapshot): void {
  const parts: string[] = [];
  if (collaborationMode === "plan") {
    parts.push(label("plan"));
  } else if (collaborationMode === "goal") {
    parts.push(label("goal"));
  }
  parts.push(toolApprovalModeLabel(toolApprovalMode));
  if (tokenMode === "economy") {
    parts.push(label("tokenEconomyShort"));
  }
  controlSummaryButton.textContent = `${parts.join(" · ")} ▾`;
  controlSummaryButton.title = parts.join(" · ");
}

function renderCollaborationMenu(): void {
  collaborationMenu.textContent = "";
  const title = document.createElement("div");
  title.className = "collaboration-menu__title";
  title.textContent = label("collaborationModes");
  collaborationMenu.append(
    title,
    collaborationMenuRow("plan", label("plan"), label("planDetail"), "☰"),
    collaborationMenuRow("goal", label("goal"), label("goalDetail"), "◎"),
    tokenMenuRow("economy", label("tokenEconomy"), label("tokenEconomyDetail"), "◜"),
  );
  collaborationMenu.hidden = !collaborationMenuOpen;
}

function renderControlsMenu(): void {
  controlsMenu.hidden = !controlsMenuOpen;
}

function collaborationMenuRow(mode: CollaborationMode, titleText: string, detailText: string, iconText: string): HTMLButtonElement {
  const button = menuToggleRow(titleText, detailText, iconText, collaborationMode === mode);
  button.dataset.collaborationMode = mode;
  return button;
}

function tokenMenuRow(mode: TokenMode, titleText: string, detailText: string, iconText: string): HTMLButtonElement {
  const button = menuToggleRow(titleText, detailText, iconText, tokenMode === mode);
  button.dataset.tokenMode = mode;
  return button;
}

function menuToggleRow(titleText: string, detailText: string, iconText: string, selected: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = selected ? "collaboration-menu__row selected" : "collaboration-menu__row";
  const icon = document.createElement("span");
  icon.className = "collaboration-menu__icon";
  icon.textContent = iconText;
  const copy = document.createElement("span");
  copy.className = "collaboration-menu__copy";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const detail = document.createElement("small");
  detail.textContent = detailText;
  const toggle = document.createElement("span");
  toggle.className = "collaboration-menu__switch";
  toggle.setAttribute("aria-hidden", "true");
  copy.append(title, detail);
  button.append(icon, copy, toggle);
  return button;
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

function renderSettings(state: Snapshot): void {
  settingsView.textContent = "";
  if (!settingsOpen) {
    return;
  }

  const shell = document.createElement("section");
  shell.className = "settings-panel";

  const head = document.createElement("div");
  head.className = "settings-head";
  const title = document.createElement("h1");
  title.textContent = label("settings");
  head.append(title);

  const layout = document.createElement("div");
  layout.className = "settings-layout";
  const rail = document.createElement("nav");
  rail.className = "settings-rail";
  rail.append(
    settingsTabButton("connection", "≡", label("apiConfiguration")),
    settingsTabButton("interface", "◇", label("interface")),
    settingsTabButton("behavior", "⚙", label("behavior")),
  );

  const content = document.createElement("div");
  content.className = "settings-content";
  if (settingsTab === "connection") {
    content.append(
      settingsSection(
        label("apiConfiguration"),
        staticSettingRow(label("apiProvider"), "Reasonix ACP"),
        staticSettingRow(label("mcpServers"), mcpSummary(state.mcp)),
        textSettingRow("binaryPath", label("cliPath"), state.settings.binaryPath, label("pathPlaceholder")),
        textSettingRow("model", label("modelOverride"), state.settings.model, label("modelPlaceholder")),
        settingsActionRow(settingsActionButton("pickModel", label("pickModel")), settingsActionButton("showOutput", label("logs"))),
      ),
    );
  } else if (settingsTab === "interface") {
    content.append(
      settingsSection(
        label("interface"),
        segmentedSetting("uiLanguage", state.settings.uiLanguage, [
          ["auto", label("autoLanguage")],
          ["en", label("english")],
          ["zh-CN", label("chinese")],
        ]),
        segmentedSetting("includeSelectionMode", state.settings.includeSelectionMode, [
          ["selectionOnly", label("selection")],
          ["nearby", label("nearby")],
          ["off", label("off")],
        ]),
      ),
    );
  } else {
    content.append(
      settingsSection(
        label("behavior"),
        toggleSetting("autoStart", label("autoStart"), state.settings.autoStart),
        toggleSetting("trace", label("trace"), state.settings.trace),
        staticSettingRow(label("approval"), label("approvalReview")),
        settingsActionRow(settingsActionButton("openNativeSettings", label("openVsCodeSettings"))),
      ),
    );
  }

  layout.append(rail, content);
  shell.append(head, layout);
  settingsView.append(shell);
}

function settingsTabButton(tab: SettingsTab, iconText: string, titleText: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.settingsTab = tab;
  button.className = tab === settingsTab ? "selected" : "";
  const icon = document.createElement("span");
  icon.className = "settings-tab-icon";
  icon.textContent = iconText;
  const title = document.createElement("span");
  title.textContent = titleText;
  button.append(icon, title);
  return button;
}

function settingsSection(titleText: string, ...children: HTMLElement[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "settings-section";
  const title = document.createElement("h3");
  title.textContent = titleText;
  section.append(title, ...children);
  return section;
}

function textSettingRow(key: "binaryPath" | "model", labelText: string, value: string, placeholder: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "setting-row";
  const labelNode = document.createElement("label");
  labelNode.className = "setting-label";
  const id = `setting-${key}`;
  labelNode.htmlFor = id;
  labelNode.textContent = labelText;
  const inputRow = document.createElement("div");
  inputRow.className = "setting-input-row";
  const input = document.createElement("input");
  input.id = id;
  input.dataset.textSetting = key;
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "micro-button";
  save.dataset.saveSetting = key;
  save.textContent = label("save");
  inputRow.append(input, save);
  row.append(labelNode, inputRow);
  return row;
}

function staticSettingRow(labelText: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "setting-row";
  const name = document.createElement("div");
  name.className = "setting-label";
  name.textContent = labelText;
  const detail = document.createElement("div");
  detail.className = "setting-detail";
  detail.textContent = value;
  row.append(name, detail);
  return row;
}

function segmentedSetting(key: "uiLanguage" | "includeSelectionMode", current: string, options: [string, string][]): HTMLElement {
  const row = document.createElement("div");
  row.className = "setting-row";
  const name = document.createElement("div");
  name.className = "setting-label";
  name.textContent = key === "uiLanguage" ? label("language") : label("context");
  const group = document.createElement("div");
  group.className = "segmented";
  for (const [value, text] of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.settingKey = key;
    button.dataset.settingValue = value;
    button.className = value === current ? "selected" : "";
    button.textContent = text;
    group.append(button);
  }
  row.append(name, group);
  return row;
}

function toggleSetting(key: "autoStart" | "trace", text: string, checked: boolean): HTMLElement {
  const labelNode = document.createElement("label");
  labelNode.className = "toggle-row";
  const copy = document.createElement("span");
  copy.textContent = text;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.settingKey = key;
  input.checked = checked;
  labelNode.append(copy, input);
  return labelNode;
}

function settingsActionRow(...buttons: HTMLButtonElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-actions";
  row.append(...buttons);
  return row;
}

function settingsActionButton(action: string, text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.dataset.settingsAction = action;
  button.textContent = text;
  return button;
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
  const mark = document.createElement("div");
  mark.className = "reasonix-mark";
  mark.textContent = "R";
  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = label("whatCanIDo");
  const detail = document.createElement("div");
  detail.className = "empty-detail";
  detail.textContent = state.disconnected ? label("idleTitle") : `${label("readyTitle")} · ${state.workspace}`;
  const actions = document.createElement("div");
  actions.className = "empty-actions";
  actions.append(
    quickButton("explainFile", label("explainFile")),
    quickButton("fixSelection", label("fixSelection")),
    quickButton("runTests", label("runTests")),
    quickButton("searchRepo", label("searchRepo")),
  );
  node.append(mark, title, detail, actions);
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

function updateSetting(key: SettingKey, value: string | boolean): void {
  vscode.postMessage({ command: "updateSetting", key, value });
}

function saveTextSetting(key: "binaryPath" | "model"): void {
  const input = settingsView.querySelector<HTMLInputElement>(`input[data-text-setting="${key}"]`);
  if (!input) {
    return;
  }
  updateSetting(key, input.value);
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
  vscode.postMessage({ command: "sendPrompt", text, collaborationMode, tokenMode, toolApprovalMode });
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
    uiLanguage: "auto",
    settings: {
      binaryPath: "",
      model: "",
      uiLanguage: "auto",
      autoStart: false,
      trace: false,
      includeSelectionMode: "selectionOnly",
    },
    sessions: [],
    mcp: { connected: [], configured: [], disconnected: [] },
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
    usage: isRecord(value.usage) ? (value.usage as unknown as UsageData) : undefined,
    modelLabel: typeof value.modelLabel === "string" ? value.modelLabel : "Default model",
    cacheLabel: typeof value.cacheLabel === "string" ? value.cacheLabel : undefined,
    locale: typeof value.locale === "string" ? value.locale : "en",
    uiLanguage: isUiLanguage(value.uiLanguage) ? value.uiLanguage : "auto",
    settings: normalizeSettings(value.settings, contextMode, value.uiLanguage),
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    sessions: Array.isArray(value.sessions) ? (value.sessions as SessionSummary[]).filter(isSessionSummary) : [],
    mcp: normalizeMcp(value.mcp),
  };
}

function normalizeMcp(value: unknown): McpSnapshot {
  const record = isRecord(value) ? value : {};
  return {
    connected: stringArray(record.connected),
    configured: stringArray(record.configured),
    disconnected: stringArray(record.disconnected),
  };
}

function normalizeSettings(value: unknown, contextMode: IncludeSelectionMode, uiLanguage: unknown): SettingsSnapshot {
  const record = isRecord(value) ? value : {};
  return {
    binaryPath: typeof record.binaryPath === "string" ? record.binaryPath : "",
    model: typeof record.model === "string" ? record.model : "",
    uiLanguage: isUiLanguage(record.uiLanguage) ? record.uiLanguage : isUiLanguage(uiLanguage) ? uiLanguage : "auto",
    autoStart: record.autoStart === true,
    trace: record.trace === true,
    includeSelectionMode: isContextMode(record.includeSelectionMode) ? record.includeSelectionMode : contextMode,
  };
}

function toolbarMetaText(state: Snapshot): string {
  const parts: string[] = [];
  if (state.cacheLabel) {
    parts.push(state.cacheLabel);
  }
  if (state.mcp.connected.length > 0) {
    parts.push(`MCP ${state.mcp.connected.length}`);
  }
  return parts.join(" / ");
}

function mcpSummary(mcp: McpSnapshot): string {
  if (mcp.configured.length === 0 && mcp.connected.length === 0) {
    return label("none");
  }
  const connected = mcp.connected.length > 0 ? mcp.connected.join(", ") : label("none");
  const disconnected = mcp.disconnected.length > 0 ? ` · ${label("disconnected")}: ${mcp.disconnected.join(", ")}` : "";
  return `${connected}${disconnected}`;
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

function toolApprovalModeLabel(mode: ToolApprovalMode): string {
  switch (mode) {
    case "ask":
      return label("ask");
    case "auto":
      return label("autoApproval");
    case "yolo":
      return label("yolo");
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
  const trimmed = value.trim();
  if (trimmed === "Default model") {
    return label("model");
  }
  const compact = (trimmed.split("/").at(-1) ?? trimmed).trim();
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "auto" || value === "en" || value === "zh-CN";
}

function isContextMode(value: unknown): value is IncludeSelectionMode {
  return value === "off" || value === "selectionOnly" || value === "nearby";
}

function isCollaborationMode(value: unknown): value is CollaborationMode {
  return value === "normal" || value === "plan" || value === "goal";
}

function isTokenMode(value: unknown): value is TokenMode {
  return value === "standard" || value === "economy";
}

function isToolApprovalMode(value: unknown): value is ToolApprovalMode {
  return value === "ask" || value === "auto" || value === "yolo";
}

function isSettingsTab(value: unknown): value is SettingsTab {
  return value === "connection" || value === "interface" || value === "behavior";
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
  | "add"
  | "always"
  | "act"
  | "apiConfiguration"
  | "apiProvider"
  | "approval"
  | "approvalReview"
  | "ask"
  | "askDetail"
  | "autoApproval"
  | "autoApprovalDetail"
  | "autoLanguage"
  | "autoStart"
  | "backToChat"
  | "behavior"
  | "cache"
  | "cacheDiagnostics"
  | "cancelled"
  | "code"
  | "completed"
  | "clickToDisable"
  | "collaborationModes"
  | "composerControls"
  | "connection"
  | "context"
  | "contextOff"
  | "continue"
  | "copied"
  | "copy"
  | "cost"
  | "disconnected"
  | "done"
  | "edit"
  | "english"
  | "execute"
  | "explainFile"
  | "failed"
  | "fixSelection"
  | "idleTitle"
  | "input"
  | "inputTokens"
  | "insert"
  | "justNow"
  | "language"
  | "logs"
  | "model"
  | "modelOverride"
  | "modelPlaceholder"
  | "mcpServers"
  | "goal"
  | "goalDetail"
  | "nearby"
  | "nearbyDetail"
  | "new"
  | "noContext"
  | "noSessions"
  | "none"
  | "notice"
  | "off"
  | "offDetail"
  | "once"
  | "openDiff"
  | "other"
  | "outputTokens"
  | "pending"
  | "placeholder"
  | "plan"
  | "planDetail"
  | "composerHint"
  | "pathPlaceholder"
  | "pickModel"
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
  | "settings"
  | "start"
  | "stop"
  | "stopTurn"
  | "thought"
  | "thoughtSummary"
  | "tokens"
  | "tokenEconomy"
  | "tokenEconomyDetail"
  | "tokenEconomyShort"
  | "toolApprovals"
  | "trace"
  | "usage"
  | "user"
  | "whatCanIDo"
  | "yolo"
  | "yoloDetail"
  | "chinese"
  | "cliPath"
  | "interface"
  | "openVsCodeSettings"
  | "save";

const labels: Record<"en" | "zh", Record<LabelKey, string>> = {
  en: {
    add: "Add",
    always: "Always",
    act: "Act",
    apiConfiguration: "API Configuration",
    apiProvider: "API Provider",
    approval: "approval",
    approvalReview: "Approval: review tool requests",
    ask: "Ask",
    askDetail: "Ask before approval-gated tool calls.",
    autoApproval: "Auto",
    autoApprovalDetail: "Auto-approve ordinary tool permissions for this turn.",
    autoLanguage: "Auto",
    autoStart: "Auto start",
    backToChat: "Back",
    behavior: "Behavior",
    cache: "Cache",
    cacheDiagnostics: "Cache diagnostics",
    cancelled: "cancelled",
    code: "code",
    completed: "completed",
    clickToDisable: "Click to turn off",
    collaborationModes: "Collaboration modes",
    composerControls: "Composer controls",
    connection: "Connection",
    context: "Context",
    contextOff: "No editor context",
    continue: "Continue",
    copied: "Copied",
    copy: "Copy",
    cost: "Cost",
    disconnected: "Disconnected",
    done: "Done",
    edit: "edit",
    english: "English",
    execute: "execute",
    explainFile: "Explain file",
    failed: "failed",
    fixSelection: "Fix selection",
    idleTitle: "Reasonix is idle",
    input: "Input",
    inputTokens: "Input",
    insert: "Insert",
    justNow: "now",
    language: "Language",
    logs: "Logs",
    model: "Model",
    modelOverride: "Model override",
    modelPlaceholder: "Default model",
    mcpServers: "MCP servers",
    goal: "Goal",
    goalDetail: "Keep working toward a concrete goal until done or blocked.",
    nearby: "Nearby code",
    nearbyDetail: "Use selected text, or a cursor window when nothing is selected.",
    new: "New",
    noContext: "No active editor context",
    noSessions: "No recent sessions",
    none: "None",
    notice: "notice",
    off: "Off",
    offDetail: "Send prompts without editor context.",
    once: "Once",
    openDiff: "Open diff",
    other: "other",
    outputTokens: "Output",
    pending: "pending",
    placeholder: "Message Reasonix...",
    plan: "Plan",
    planDetail: "Read first, produce a plan, and wait before side effects.",
    composerHint: "/ commands · @ files/folders",
    pathPlaceholder: "Resolve from PATH",
    pickModel: "Pick model",
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
    settings: "Settings",
    start: "Start",
    stop: "Stop",
    stopTurn: "Stop turn",
    thought: "thought",
    thoughtSummary: "Reasoning summary",
    tokens: "Tokens",
    tokenEconomy: "Token economy",
    tokenEconomyDetail: "Start lean and expand context/tools only when needed.",
    tokenEconomyShort: "Eco",
    toolApprovals: "Tool approvals",
    trace: "Trace",
    usage: "usage",
    user: "user",
    whatCanIDo: "What can I do for you?",
    yolo: "Yolo",
    yoloDetail: "Skip ordinary tool approvals for this turn; ask and plan decisions still wait.",
    chinese: "Chinese",
    cliPath: "Reasonix CLI",
    interface: "Interface",
    openVsCodeSettings: "VS Code Settings",
    save: "Save",
  },
  zh: {
    add: "加入",
    always: "总是允许",
    act: "执行",
    apiConfiguration: "API 配置",
    apiProvider: "API 提供方",
    approval: "审批",
    approvalReview: "审批：工具请求需确认",
    ask: "询问",
    askDetail: "受控工具调用前先询问确认。",
    autoApproval: "自动",
    autoApprovalDetail: "本轮自动批准普通工具权限。",
    autoLanguage: "自动",
    autoStart: "自动启动",
    backToChat: "返回",
    behavior: "行为",
    cache: "缓存",
    cacheDiagnostics: "缓存诊断",
    cancelled: "已取消",
    code: "代码",
    completed: "已完成",
    clickToDisable: "点击关闭",
    collaborationModes: "协作方式",
    composerControls: "输入控制",
    connection: "连接",
    context: "上下文",
    contextOff: "不带编辑器上下文",
    continue: "继续",
    copied: "已复制",
    copy: "复制",
    cost: "费用",
    disconnected: "已断开",
    done: "完成",
    edit: "编辑",
    english: "英文",
    execute: "执行",
    explainFile: "解释文件",
    failed: "失败",
    fixSelection: "修复选区",
    idleTitle: "Reasonix 空闲中",
    input: "输入",
    inputTokens: "输入",
    insert: "插入",
    justNow: "刚刚",
    language: "语言",
    logs: "日志",
    model: "模型",
    modelOverride: "模型覆盖",
    modelPlaceholder: "默认模型",
    mcpServers: "MCP 服务",
    goal: "目标",
    goalDetail: "围绕明确目标持续推进，直到完成或阻塞。",
    nearby: "附近代码",
    nearbyDetail: "优先使用选区，没有选区时使用光标附近代码。",
    new: "新建",
    noContext: "没有可用编辑器上下文",
    noSessions: "暂无最近会话",
    none: "无",
    notice: "通知",
    off: "关闭",
    offDetail: "发送时不附加编辑器上下文。",
    once: "本次",
    openDiff: "打开 Diff",
    other: "其他",
    outputTokens: "输出",
    pending: "等待中",
    placeholder: "给 Reasonix 发消息...",
    plan: "规划",
    planDetail: "先只读分析并产出计划，确认前避免副作用。",
    composerHint: "/ 命令 · @ 文件/文件夹",
    pathPlaceholder: "从 PATH 查找",
    pickModel: "选择模型",
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
    settings: "设置",
    start: "开始",
    stop: "停止",
    stopTurn: "停止当前回合",
    thought: "思考",
    thoughtSummary: "思考摘要",
    tokens: "Tokens",
    tokenEconomy: "省 token",
    tokenEconomyDetail: "精简初始上下文和工具，需要时再扩展。",
    tokenEconomyShort: "省",
    toolApprovals: "工具权限",
    trace: "追踪日志",
    usage: "用量",
    user: "用户",
    whatCanIDo: "我能帮你做什么？",
    yolo: "Yolo",
    yoloDetail: "本轮跳过普通工具审批；ask 问题和计划确认仍会等待。",
    chinese: "简体中文",
    cliPath: "Reasonix CLI",
    interface: "界面",
    openVsCodeSettings: "VS Code 设置",
    save: "保存",
  },
};

function label(key: LabelKey): string {
  return labels[snapshot.locale.toLowerCase().startsWith("zh") ? "zh" : "en"][key];
}

render(snapshot);
