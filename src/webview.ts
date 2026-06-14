import type { ChangePreview, UsageData } from "./acpTypes";
import type { ChatItem } from "./chatState";
import { getComposerTrigger, replaceComposerTrigger, slashSuggestions, type ComposerTrigger } from "./composerSuggestions";
import { shouldSubmitPromptOnKeydown } from "./keyboard";
import type { ResourceSuggestion } from "./resourceSuggestions";
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

const toolApprovalModes: ToolApprovalMode[] = ["ask", "auto", "yolo"];

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
  effortLabel: string;
  effortSupported: boolean;
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
const modeChipTray = mustElement("modeChipTray");
const approvalSummaryButton = mustElement("approvalSummaryButton") as HTMLButtonElement;
const controlsMenu = mustElement("controlsMenu");
const controlsApprovalLabel = mustElement("controlsApprovalLabel");
const approvalModebar = mustElement("approvalModebar");
const composerHint = mustElement("composerHint");
const suggestionMenu = mustElement("suggestionMenu");
const newSession = mustElement("newSession") as HTMLButtonElement;
const composer = mustElement("composer") as HTMLFormElement;
const sessionMenu = mustElement("sessionMenu") as HTMLButtonElement;
const sessionPopover = mustElement("sessionPopover");
const runtimeSettingsButton = mustElement("runtimeSettingsButton") as HTMLButtonElement;
const runtimeModelLabel = mustElement("runtimeModelLabel");
const runtimeEffortLabel = mustElement("runtimeEffortLabel");
const runtimeSettingsMenu = mustElement("runtimeSettingsMenu");
const settingsButton = mustElement("settingsButton") as HTMLButtonElement;
const chatToolbarActions = mustElement("chatToolbarActions");
const settingsToolbarActions = mustElement("settingsToolbarActions");
const settingsBackButton = mustElement("settingsBackButton") as HTMLButtonElement;
const settingsModeTitle = mustElement("settingsModeTitle");

let snapshot: Snapshot = normalizeSnapshot(vscode.getState());
let sessionMenuOpen = false;
let collaborationMenuOpen = false;
let controlsMenuOpen = false;
let runtimeMenuOpen = false;
let settingsOpen = false;
let settingsTab: SettingsTab = "connection";
let collaborationMode: CollaborationMode = "normal";
let tokenMode: TokenMode = "economy";
let toolApprovalMode: ToolApprovalMode = "ask";
let compositionActive = false;
let suggestionState: SuggestionState = emptySuggestionState();
let resourceSuggestionRequestId = 0;

type SuggestionState = {
  trigger?: ComposerTrigger;
  items: ComposerMenuItem[];
  selectedIndex: number;
  resourceRequestId?: number;
  loading: boolean;
};

type ComposerMenuItem = {
  icon: string;
  title: string;
  detail: string;
  badge: string;
  insertText: string;
};

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPrompt();
});

prompt.addEventListener("keydown", (event) => {
  if (handleSuggestionKeydown(event)) {
    return;
  }
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
  updateComposerSuggestions();
});

prompt.addEventListener("input", () => {
  resizePrompt();
  updateSendButton(snapshot);
  updateComposerSuggestions();
});

prompt.addEventListener("click", () => {
  updateComposerSuggestions();
});

prompt.addEventListener("keyup", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
    updateComposerSuggestions();
  }
});

prompt.addEventListener("select", () => {
  updateComposerSuggestions();
});

suggestionMenu.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

suggestionMenu.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-suggestion-index]");
  if (!button) {
    return;
  }
  const index = Number(button.dataset.suggestionIndex);
  if (Number.isInteger(index)) {
    acceptSuggestion(index);
  }
});

newSession.addEventListener("click", () => vscode.postMessage({ command: "newSession" }));
runtimeSettingsButton.addEventListener("click", (event) => {
  event.stopPropagation();
  runtimeMenuOpen = !runtimeMenuOpen;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  renderMenus(snapshot);
});
settingsButton.addEventListener("click", () => {
  settingsOpen = true;
  settingsTab = "connection";
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = false;
  render(snapshot);
});
settingsBackButton.addEventListener("click", () => {
  settingsOpen = false;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = false;
  render(snapshot);
});

collaborationButton.addEventListener("click", (event) => {
  event.stopPropagation();
  collaborationMenuOpen = !collaborationMenuOpen;
  sessionMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = false;
  renderMenus(snapshot);
});

approvalSummaryButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const nextOpen = !controlsMenuOpen;
  controlsMenuOpen = nextOpen;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  runtimeMenuOpen = false;
  renderMenus(snapshot);
  if (nextOpen) {
    focusToolApprovalOption(toolApprovalMode);
  }
});

modeChipTray.addEventListener("click", (event) => {
  event.stopPropagation();
  const mode = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-mode-chip]")?.dataset.modeChip;
  if (isCollaborationMode(mode)) {
    chooseCollaborationMode(mode);
    return;
  }
  if (mode === "token") {
    chooseTokenMode("economy");
  }
});

controlsMenu.addEventListener("click", (event) => {
  event.stopPropagation();
});

runtimeSettingsMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const action = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-runtime-action]")?.dataset.runtimeAction;
  if (action === "model") {
    runtimeMenuOpen = false;
    renderMenus(snapshot);
    vscode.postMessage({ command: "pickModel" });
    return;
  }
  if (action === "effort") {
    runtimeMenuOpen = false;
    renderMenus(snapshot);
    vscode.postMessage({ command: "pickEffort" });
  }
});

sessionMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  if (settingsOpen) {
    return;
  }
  sessionMenuOpen = !sessionMenuOpen;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = false;
  renderMenus(snapshot);
});

document.addEventListener("click", (event) => {
  const target = event.target as Node | null;
  if (target !== prompt && (!target || !suggestionMenu.contains(target))) {
    closeSuggestions();
  }
  if (!sessionMenuOpen && !collaborationMenuOpen && !controlsMenuOpen && !runtimeMenuOpen) {
    return;
  }
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = false;
  renderMenus(snapshot);
});

collaborationMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const target = event.target as Element | null;
  const collaboration = target?.closest<HTMLButtonElement>("button[data-collaboration-mode]")?.dataset.collaborationMode;
  if (isCollaborationMode(collaboration)) {
    chooseCollaborationMode(collaboration);
    return;
  }
  const token = target?.closest<HTMLButtonElement>("button[data-token-mode]")?.dataset.tokenMode;
  if (isTokenMode(token)) {
    chooseTokenMode(token);
  }
});

approvalModebar.addEventListener("click", (event) => {
  const mode = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-tool-approval-mode]")?.dataset.toolApprovalMode;
  if (isToolApprovalMode(mode)) {
    setToolApprovalMode(mode);
    focusToolApprovalOption(mode);
  }
});

approvalModebar.addEventListener("keydown", (event) => {
  const activeMode = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-tool-approval-mode]")?.dataset.toolApprovalMode;
  const currentIndex = Math.max(0, toolApprovalModes.indexOf(isToolApprovalMode(activeMode) ? activeMode : toolApprovalMode));
  let nextIndex: number | undefined;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % toolApprovalModes.length;
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    nextIndex = (currentIndex + toolApprovalModes.length - 1) % toolApprovalModes.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = toolApprovalModes.length - 1;
  } else if ((event.key === "Enter" || event.key === " ") && isToolApprovalMode(activeMode)) {
    event.preventDefault();
    setToolApprovalMode(activeMode);
    return;
  }

  if (nextIndex !== undefined) {
    event.preventDefault();
    const nextMode = toolApprovalModes[nextIndex];
    setToolApprovalMode(nextMode);
    focusToolApprovalOption(nextMode);
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
    runtimeMenuOpen = false;
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
    case "resourceSuggestions":
      receiveResourceSuggestions(message.requestId, message.query, message.items);
      return;
    case "openSettings":
      settingsOpen = true;
      closeSuggestions();
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
  runtimeModelLabel.textContent = shortModelLabel(state.modelLabel);
  runtimeEffortLabel.textContent = shortEffortLabel(state.effortLabel);
  runtimeSettingsButton.title = `${label("modelSettings")}: ${state.modelLabel} / ${state.effortLabel}`;
  runtimeSettingsButton.setAttribute("aria-label", runtimeSettingsButton.title);
  runtimeSettingsButton.setAttribute("aria-haspopup", "menu");
  runtimeSettingsButton.setAttribute("aria-expanded", String(runtimeMenuOpen));
  settingsButton.textContent = "⚙";
  settingsButton.title = label("settings");
  settingsButton.setAttribute("aria-label", label("settings"));
  settingsBackButton.textContent = label("done");
  settingsModeTitle.textContent = label("settings");
  collaborationButton.title = label("collaborationModes");
  collaborationButton.setAttribute("aria-label", label("collaborationModes"));
  collaborationButton.setAttribute("aria-haspopup", "menu");
  collaborationButton.setAttribute("aria-expanded", String(collaborationMenuOpen));
  controlsApprovalLabel.textContent = label("toolApprovals");
  approvalSummaryButton.setAttribute("aria-label", label("toolApprovals"));
  composerHint.textContent = label("composerHint");
  prompt.placeholder = label("placeholder");
  newSession.disabled = state.running;
  collaborationButton.disabled = state.running;
  runtimeSettingsButton.disabled = state.running;
  chatToolbarActions.hidden = settingsOpen;
  settingsToolbarActions.hidden = !settingsOpen;
  transcript.hidden = settingsOpen;
  settingsView.hidden = !settingsOpen;
  composer.hidden = settingsOpen;
  if (settingsOpen) {
    sessionMenuOpen = false;
    collaborationMenuOpen = false;
    controlsMenuOpen = false;
    runtimeMenuOpen = false;
    closeSuggestions();
  }
  if (state.running) {
    collaborationMenuOpen = false;
    runtimeMenuOpen = false;
  }
  collaborationButton.setAttribute("aria-expanded", String(collaborationMenuOpen));
  runtimeSettingsButton.setAttribute("aria-expanded", String(runtimeMenuOpen));
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
  approvalModebar.setAttribute("aria-label", label("toolApprovals"));
  for (const button of Array.from(approvalModebar.querySelectorAll<HTMLButtonElement>("button[data-tool-approval-mode]"))) {
    const mode = button.dataset.toolApprovalMode;
    if (!isToolApprovalMode(mode)) {
      continue;
    }
    const selected = mode === toolApprovalMode;
    const modeLabel = toolApprovalModeLabel(mode);
    const modeDetail = toolApprovalModeDetail(mode);
    button.classList.toggle("approval-menu__item--active", selected);
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.title = modeDetail;
    const labelNode = button.querySelector<HTMLElement>("[data-approval-mode-label]");
    const detailNode = button.querySelector<HTMLElement>("[data-approval-mode-detail]");
    if (labelNode && detailNode) {
      labelNode.textContent = modeLabel;
      detailNode.textContent = modeDetail;
    } else {
      button.textContent = modeLabel;
    }
  }
  renderControlSummaries();
}

function setToolApprovalMode(mode: ToolApprovalMode): void {
  toolApprovalMode = mode;
  updateModeUi();
}

function focusToolApprovalOption(mode: ToolApprovalMode): void {
  approvalModebar.querySelector<HTMLButtonElement>(`button[data-tool-approval-mode="${mode}"]`)?.focus();
}

function renderMenus(state: Snapshot): void {
  renderSessionPopover(state);
  renderCollaborationMenu(state);
  renderControlsMenu();
  renderRuntimeSettingsMenu(state);
}

function renderControlSummaries(): void {
  const approvalLabel = toolApprovalModeLabel(toolApprovalMode);
  approvalSummaryButton.textContent = `${approvalLabel} ▾`;
  approvalSummaryButton.title = `${label("toolApprovals")}: ${approvalLabel}`;

  renderModeChips(snapshot);
}

function renderModeChips(state: Snapshot): void {
  modeChipTray.textContent = "";
  if (collaborationMode === "plan") {
    modeChipTray.append(modeChipButton("plan", label("plan"), label("planDetail"), "☰", state.running));
  } else if (collaborationMode === "goal") {
    modeChipTray.append(modeChipButton("goal", label("goal"), label("goalActiveDetail"), "◎", state.running));
  }
  if (tokenMode === "economy") {
    modeChipTray.append(modeChipButton("token", label("tokenEconomyShort"), label("tokenEconomyOnDetail"), "◜", state.running));
  }
  modeChipTray.hidden = modeChipTray.childElementCount === 0;
}

function modeChipButton(kind: CollaborationMode | "token", titleText: string, detailText: string, iconText: string, disabled: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `composer-mode-chip composer-mode-chip--${kind}`;
  button.dataset.modeChip = kind;
  button.disabled = disabled;
  button.title = `${label("clickToDisable")}: ${detailText}`;
  button.setAttribute("aria-label", button.title);

  const modeIcon = document.createElement("span");
  modeIcon.className = "composer-mode-chip__icon composer-mode-chip__icon--mode";
  modeIcon.textContent = iconText;
  modeIcon.setAttribute("aria-hidden", "true");
  const dismissIcon = document.createElement("span");
  dismissIcon.className = "composer-mode-chip__icon composer-mode-chip__icon--dismiss";
  dismissIcon.textContent = "×";
  dismissIcon.setAttribute("aria-hidden", "true");
  const labelNode = document.createElement("span");
  labelNode.className = "composer-mode-chip__label";
  labelNode.textContent = titleText;
  button.append(modeIcon, dismissIcon, labelNode);
  return button;
}

function renderCollaborationMenu(state: Snapshot): void {
  collaborationMenu.textContent = "";
  const title = document.createElement("div");
  title.className = "collaboration-menu__title";
  title.textContent = label("collaborationModes");
  collaborationMenu.append(
    title,
    collaborationMenuRow("plan", label("plan"), label("planDetail"), "☰", state.running),
    collaborationMenuRow("goal", label("goal"), collaborationMode === "goal" ? label("goalActiveDetail") : label("goalDetail"), "◎", state.running),
    tokenMenuRow("economy", label("tokenEconomy"), tokenMode === "economy" ? label("tokenEconomyOnDetail") : label("tokenEconomyDetail"), "◜", state.running),
  );
  collaborationMenu.hidden = !collaborationMenuOpen;
}

function renderControlsMenu(): void {
  controlsMenu.hidden = !controlsMenuOpen;
}

function renderRuntimeSettingsMenu(state: Snapshot): void {
  runtimeSettingsMenu.textContent = "";
  runtimeSettingsButton.setAttribute("aria-expanded", String(runtimeMenuOpen));
  const title = document.createElement("div");
  title.className = "runtime-settings-menu__title";
  title.textContent = label("modelSettings");
  runtimeSettingsMenu.append(
    title,
    runtimeSettingsRow("model", label("model"), state.modelLabel, "✿", state.running),
    runtimeSettingsRow(
      "effort",
      label("reasoningEffort"),
      state.effortSupported ? state.effortLabel : label("effortUnavailable"),
      "◜",
      state.running,
    ),
  );
  runtimeSettingsMenu.hidden = !runtimeMenuOpen;
}

function runtimeSettingsRow(action: "model" | "effort", titleText: string, detailText: string, iconText: string, disabled: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "runtime-settings-menu__row";
  button.dataset.runtimeAction = action;
  button.disabled = disabled;
  button.title = detailText;
  const icon = document.createElement("span");
  icon.className = "runtime-settings-menu__icon";
  icon.textContent = iconText;
  const copy = document.createElement("span");
  copy.className = "runtime-settings-menu__copy";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const detail = document.createElement("small");
  detail.textContent = detailText;
  const chevron = document.createElement("span");
  chevron.className = "runtime-settings-menu__chevron";
  chevron.textContent = "›";
  chevron.setAttribute("aria-hidden", "true");
  copy.append(title, detail);
  button.append(icon, copy, chevron);
  return button;
}

function collaborationMenuRow(mode: CollaborationMode, titleText: string, detailText: string, iconText: string, disabled: boolean): HTMLButtonElement {
  const button = menuToggleRow(titleText, detailText, iconText, collaborationMode === mode, disabled);
  button.dataset.collaborationMode = mode;
  return button;
}

function tokenMenuRow(mode: TokenMode, titleText: string, detailText: string, iconText: string, disabled: boolean): HTMLButtonElement {
  const button = menuToggleRow(titleText, detailText, iconText, tokenMode === mode, disabled);
  button.dataset.tokenMode = mode;
  return button;
}

function menuToggleRow(titleText: string, detailText: string, iconText: string, selected: boolean, disabled: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = selected ? "collaboration-menu__row selected" : "collaboration-menu__row";
  button.disabled = disabled;
  button.title = detailText;
  button.setAttribute("aria-pressed", String(selected));
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

function chooseCollaborationMode(mode: CollaborationMode): void {
  collaborationMode = collaborationMode === mode ? "normal" : mode;
  collaborationMenuOpen = false;
  runtimeMenuOpen = false;
  render(snapshot);
  focusPromptSoon();
}

function chooseTokenMode(mode: TokenMode): void {
  tokenMode = tokenMode === mode ? "standard" : mode;
  collaborationMenuOpen = false;
  runtimeMenuOpen = false;
  render(snapshot);
  focusPromptSoon();
}

function focusPromptSoon(): void {
  requestAnimationFrame(() => {
    prompt.focus();
  });
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
  const markSrc = document.body.dataset.reasonixMarkSrc;
  if (markSrc) {
    const logo = document.createElement("img");
    logo.className = "reasonix-mark__logo";
    logo.src = markSrc;
    logo.alt = "";
    logo.decoding = "async";
    logo.addEventListener("error", () => {
      mark.textContent = "R";
    }, { once: true });
    mark.append(logo);
  } else {
    mark.textContent = "R";
  }
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

function updateComposerSuggestions(): void {
  if (compositionActive || settingsOpen) {
    closeSuggestions();
    return;
  }
  const trigger = getComposerTrigger(prompt.value, prompt.selectionStart, prompt.selectionEnd);
  if (!trigger) {
    closeSuggestions();
    return;
  }
  if (trigger.kind === "slash") {
    suggestionState = {
      trigger,
      items: slashSuggestions(trigger.query, snapshot.locale).map(slashMenuItem),
      selectedIndex: 0,
      loading: false,
    };
    renderSuggestionMenu();
    return;
  }

  const requestId = ++resourceSuggestionRequestId;
  suggestionState = {
    trigger,
    items: [],
    selectedIndex: 0,
    resourceRequestId: requestId,
    loading: true,
  };
  renderSuggestionMenu();
  vscode.postMessage({ command: "resourceSuggestions", requestId, query: trigger.query });
}

function handleSuggestionKeydown(event: KeyboardEvent): boolean {
  if (!suggestionState.trigger || suggestionMenu.hidden) {
    return false;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSuggestionSelection(event.key === "ArrowDown" ? 1 : -1);
    return true;
  }
  if (event.key === "Tab" || event.key === "Enter") {
    if (suggestionState.items.length === 0) {
      return false;
    }
    event.preventDefault();
    acceptSuggestion(suggestionState.selectedIndex);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSuggestions();
    return true;
  }
  return false;
}

function receiveResourceSuggestions(requestId: number, query: string, items: ResourceSuggestion[]): void {
  const trigger = suggestionState.trigger;
  if (trigger?.kind !== "resource" || suggestionState.resourceRequestId !== requestId || trigger.query !== query) {
    return;
  }
  suggestionState = {
    trigger,
    items: items.map(resourceMenuItem),
    selectedIndex: 0,
    resourceRequestId: requestId,
    loading: false,
  };
  renderSuggestionMenu();
}

function moveSuggestionSelection(delta: number): void {
  const length = suggestionState.items.length;
  if (length === 0) {
    return;
  }
  suggestionState.selectedIndex = (suggestionState.selectedIndex + delta + length) % length;
  renderSuggestionMenu();
}

function acceptSuggestion(index: number): void {
  const trigger = suggestionState.trigger;
  const item = suggestionState.items[index];
  if (!trigger || !item) {
    return;
  }
  const next = replaceComposerTrigger(prompt.value, trigger, item.insertText);
  prompt.value = next.value;
  prompt.focus();
  prompt.setSelectionRange(next.cursor, next.cursor);
  resizePrompt();
  updateSendButton(snapshot);
  closeSuggestions();
}

function closeSuggestions(): void {
  if (!suggestionState.trigger && suggestionMenu.hidden) {
    return;
  }
  suggestionState = emptySuggestionState();
  renderSuggestionMenu();
}

function renderSuggestionMenu(): void {
  suggestionMenu.textContent = "";
  const trigger = suggestionState.trigger;
  if (!trigger) {
    suggestionMenu.hidden = true;
    return;
  }
  suggestionMenu.hidden = false;
  suggestionMenu.setAttribute("aria-label", trigger.kind === "slash" ? label("slashCommands") : label("workspaceFiles"));

  const title = document.createElement("div");
  title.className = "suggestion-menu__title";
  title.textContent = trigger.kind === "slash" ? label("slashCommands") : label("workspaceFiles");
  suggestionMenu.append(title);

  if (suggestionState.loading) {
    const loading = document.createElement("div");
    loading.className = "suggestion-menu__empty";
    loading.textContent = label("searchingFiles");
    suggestionMenu.append(loading);
    return;
  }
  if (suggestionState.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "suggestion-menu__empty";
    empty.textContent = label("noSuggestions");
    suggestionMenu.append(empty);
    return;
  }
  suggestionState.items.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = index === suggestionState.selectedIndex ? "suggestion-menu__row selected" : "suggestion-menu__row";
    row.dataset.suggestionIndex = String(index);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === suggestionState.selectedIndex));

    const icon = document.createElement("span");
    icon.className = "suggestion-menu__icon";
    icon.textContent = item.icon;
    const copy = document.createElement("span");
    copy.className = "suggestion-menu__copy";
    const primary = document.createElement("strong");
    primary.textContent = item.title;
    const detail = document.createElement("small");
    detail.textContent = item.detail;
    copy.append(primary, detail);
    const badge = document.createElement("span");
    badge.className = "suggestion-menu__badge";
    badge.textContent = item.badge;
    row.append(icon, copy, badge);
    suggestionMenu.append(row);
  });
}

function slashMenuItem(suggestion: ReturnType<typeof slashSuggestions>[number]): ComposerMenuItem {
  const aliases = suggestion.aliases.map((alias) => `/${alias}`).join(", ");
  return {
    icon: "/",
    title: `/${suggestion.name}`,
    detail: aliases ? `${suggestion.detail} · ${aliases}` : suggestion.detail,
    badge: label("command"),
    insertText: suggestion.insertText,
  };
}

function resourceMenuItem(suggestion: ResourceSuggestion): ComposerMenuItem {
  return {
    icon: "@",
    title: suggestion.label,
    detail: suggestion.detail,
    badge: suggestion.kind === "directory" ? label("folder") : label("file"),
    insertText: suggestion.insertText,
  };
}

function emptySuggestionState(): SuggestionState {
  return {
    items: [],
    selectedIndex: 0,
    loading: false,
  };
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
  closeSuggestions();
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
    effortLabel: "auto",
    effortSupported: false,
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
    effortLabel: typeof value.effortLabel === "string" ? value.effortLabel : "auto",
    effortSupported: value.effortSupported === true,
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

function toolApprovalModeDetail(mode: ToolApprovalMode): string {
  switch (mode) {
    case "ask":
      return label("askDetail");
    case "auto":
      return label("autoApprovalDetail");
    case "yolo":
      return label("yoloDetail");
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

function shortEffortLabel(value: string): string {
  const trimmed = value.trim() || "auto";
  return trimmed.length > 10 ? `${trimmed.slice(0, 9)}...` : trimmed;
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
  | "command"
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
  | "effortUnavailable"
  | "failed"
  | "file"
  | "folder"
  | "fixSelection"
  | "idleTitle"
  | "input"
  | "inputTokens"
  | "insert"
  | "justNow"
  | "language"
  | "logs"
  | "model"
  | "modelSettings"
  | "modelOverride"
  | "modelPlaceholder"
  | "mcpServers"
  | "goal"
  | "goalActiveDetail"
  | "goalDetail"
  | "nearby"
  | "nearbyDetail"
  | "new"
  | "noContext"
  | "noSuggestions"
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
  | "reasoningEffort"
  | "reject"
  | "result"
  | "retry"
  | "runTests"
  | "search"
  | "searchingFiles"
  | "searchRepo"
  | "selected"
  | "selection"
  | "selectionDetail"
  | "send"
  | "sendShortcut"
  | "session"
  | "sessions"
  | "settings"
  | "slashCommands"
  | "start"
  | "stop"
  | "stopTurn"
  | "thought"
  | "thoughtSummary"
  | "tokens"
  | "tokenEconomy"
  | "tokenEconomyDetail"
  | "tokenEconomyOnDetail"
  | "tokenEconomyShort"
  | "tokenStandardDetail"
  | "tokenStandardShort"
  | "toolApprovals"
  | "trace"
  | "usage"
  | "user"
  | "whatCanIDo"
  | "workspaceFiles"
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
    command: "command",
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
    effortUnavailable: "Reasoning effort is unavailable for this model",
    failed: "failed",
    file: "file",
    folder: "folder",
    fixSelection: "Fix selection",
    idleTitle: "Reasonix is idle",
    input: "Input",
    inputTokens: "Input",
    insert: "Insert",
    justNow: "now",
    language: "Language",
    logs: "Logs",
    model: "Model",
    modelSettings: "Model settings",
    modelOverride: "Model override",
    modelPlaceholder: "Default model",
    mcpServers: "MCP servers",
    goal: "Goal",
    goalActiveDetail: "Keeps working until complete, blocked, or stopped.",
    goalDetail: "Keep working toward a concrete goal until done or blocked.",
    nearby: "Nearby code",
    nearbyDetail: "Use selected text, or a cursor window when nothing is selected.",
    new: "New",
    noContext: "No active editor context",
    noSuggestions: "No matches",
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
    reasoningEffort: "Reasoning effort",
    reject: "Reject",
    result: "Result",
    retry: "Retry",
    runTests: "Run tests",
    search: "search",
    searchingFiles: "Searching files...",
    searchRepo: "Search repo",
    selected: "selected",
    selection: "Selection",
    selectionDetail: "Use the active selection only.",
    send: "Send",
    sendShortcut: "Send (Enter), newline (Shift+Enter)",
    session: "Session",
    sessions: "Sessions",
    settings: "Settings",
    slashCommands: "Slash commands",
    start: "Start",
    stop: "Stop",
    stopTurn: "Stop turn",
    thought: "thought",
    thoughtSummary: "Reasoning summary",
    tokens: "Tokens",
    tokenEconomy: "Token economy",
    tokenEconomyDetail: "Start lean and expand context/tools only when needed.",
    tokenEconomyOnDetail: "Initial context is lean; extras are enabled on demand.",
    tokenEconomyShort: "Eco",
    tokenStandardDetail: "Send with standard context and tool availability.",
    tokenStandardShort: "Std",
    toolApprovals: "Tool approvals",
    trace: "Trace",
    usage: "usage",
    user: "user",
    whatCanIDo: "What can I do for you?",
    workspaceFiles: "Workspace files",
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
    command: "命令",
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
    effortUnavailable: "当前模型不支持调整推理强度",
    failed: "失败",
    file: "文件",
    folder: "文件夹",
    fixSelection: "修复选区",
    idleTitle: "Reasonix 空闲中",
    input: "输入",
    inputTokens: "输入",
    insert: "插入",
    justNow: "刚刚",
    language: "语言",
    logs: "日志",
    model: "模型",
    modelSettings: "模型设置",
    modelOverride: "模型覆盖",
    modelPlaceholder: "默认模型",
    mcpServers: "MCP 服务",
    goal: "目标",
    goalActiveDetail: "持续推进，直到完成、阻塞或停止。",
    goalDetail: "围绕明确目标持续推进，直到完成或阻塞。",
    nearby: "附近代码",
    nearbyDetail: "优先使用选区，没有选区时使用光标附近代码。",
    new: "新建",
    noContext: "没有可用编辑器上下文",
    noSuggestions: "没有匹配项",
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
    reasoningEffort: "推理强度",
    reject: "拒绝",
    result: "结果",
    retry: "重试",
    runTests: "运行测试",
    search: "搜索",
    searchingFiles: "正在搜索文件...",
    searchRepo: "搜索仓库",
    selected: "已选择",
    selection: "仅选区",
    selectionDetail: "只使用当前编辑器选中的内容。",
    send: "发送",
    sendShortcut: "发送 (Enter)，换行 (Shift+Enter)",
    session: "会话",
    sessions: "会话",
    settings: "设置",
    slashCommands: "斜杠命令",
    start: "开始",
    stop: "停止",
    stopTurn: "停止当前回合",
    thought: "思考",
    thoughtSummary: "思考摘要",
    tokens: "Tokens",
    tokenEconomy: "省 token",
    tokenEconomyDetail: "精简初始上下文和工具，需要时再扩展。",
    tokenEconomyOnDetail: "已精简初始上下文；需要时按需启用额外资源。",
    tokenEconomyShort: "省",
    tokenStandardDetail: "使用标准上下文和工具可用性发送。",
    tokenStandardShort: "标准",
    toolApprovals: "工具权限",
    trace: "追踪日志",
    usage: "用量",
    user: "用户",
    whatCanIDo: "我能帮你做什么？",
    workspaceFiles: "工作区文件",
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
