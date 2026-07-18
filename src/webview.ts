import type { AvailableCommand, ChangePreview, UsageData } from "./acpTypes";
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
type TokenMode = "economy" | "balanced" | "delivery";
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
  modelOptions: RuntimeSelectOption[];
  effortOptions: RuntimeSelectOption[];
  effortOptionId?: string;
  executionMode: CollaborationMode;
  executionOptions: RuntimeSelectOption[];
  workMode: TokenMode;
  workModeOptions: RuntimeSelectOption[];
  workModeOptionId?: string;
  toolApprovalMode: ToolApprovalMode;
  toolApprovalOptions: RuntimeSelectOption[];
  toolApprovalOptionId?: string;
  cacheLabel?: string;
  locale: string;
  uiLanguage: UiLanguage;
  settings: SettingsSnapshot;
  sessionId?: string;
  sessions: SessionSummary[];
  mcp: McpSnapshot;
  availableCommands?: AvailableCommand[];
};

type RuntimeSelectOption = {
  value: string;
  label: string;
  description?: string;
  selected: boolean;
};

type RuntimeMenu = "model" | "effort";

const vscode = acquireVsCodeApi();
const transcript = mustElement("transcript");
const settingsView = mustElement("settingsView");
const prompt = mustElement("prompt") as HTMLTextAreaElement;
const status = mustElement("status");
const statusDot = mustElement("statusDot");
const workspaceName = mustElement("workspaceName");
const toolbarMeta = mustElement("toolbarMeta");
const send = mustElement("send") as HTMLButtonElement;
const contextButton = mustElement("contextButton") as HTMLButtonElement;
const collaborationButton = mustElement("collaborationButton") as HTMLButtonElement;
const collaborationModeLabel = mustElement("collaborationModeLabel");
const collaborationMenu = mustElement("collaborationMenu");
const modeChipTray = mustElement("modeChipTray");
const workModeButton = mustElement("workModeButton") as HTMLButtonElement;
const workModeLabel = mustElement("workModeLabel");
const workModeMenu = mustElement("workModeMenu");
const approvalSummaryButton = mustElement("approvalSummaryButton") as HTMLButtonElement;
const approvalSummaryLabel = mustElement("approvalSummaryLabel");
const controlsMenu = mustElement("controlsMenu");
const controlsApprovalLabel = mustElement("controlsApprovalLabel");
const approvalModebar = mustElement("approvalModebar");
const composerHint = mustElement("composerHint");
const suggestionMenu = mustElement("suggestionMenu");
const connectionNotice = mustElement("connectionNotice");
const connectionNoticeText = mustElement("connectionNoticeText");
const connectionConnect = mustElement("connectionConnect") as HTMLButtonElement;
const connectionSettings = mustElement("connectionSettings") as HTMLButtonElement;
const newSession = mustElement("newSession") as HTMLButtonElement;
const railNewSession = mustElement("railNewSession") as HTMLButtonElement;
const railNewSessionLabel = mustElement("railNewSessionLabel");
const sessionRailTitle = mustElement("sessionRailTitle");
const sessionRailList = mustElement("sessionRailList");
const railStatus = mustElement("railStatus");
const railStatusDot = mustElement("railStatusDot");
const railModel = mustElement("railModel");
const composer = mustElement("composer") as HTMLFormElement;
const sessionMenu = mustElement("sessionMenu") as HTMLButtonElement;
const sessionPopover = mustElement("sessionPopover");
const runtimeModelButton = mustElement("runtimeModelButton") as HTMLButtonElement;
const runtimeEffortButton = mustElement("runtimeEffortButton") as HTMLButtonElement;
const runtimeModelLabel = mustElement("runtimeModelLabel");
const runtimeEffortLabel = mustElement("runtimeEffortLabel");
const runtimeModelMenu = mustElement("runtimeModelMenu");
const runtimeEffortMenu = mustElement("runtimeEffortMenu");
const settingsButton = mustElement("settingsButton") as HTMLButtonElement;
const chatToolbarActions = mustElement("chatToolbarActions");
const settingsToolbarActions = mustElement("settingsToolbarActions");
const settingsBackButton = mustElement("settingsBackButton") as HTMLButtonElement;
const settingsModeTitle = mustElement("settingsModeTitle");

let snapshot: Snapshot = normalizeSnapshot(vscode.getState());
let sessionMenuOpen = false;
let collaborationMenuOpen = false;
let workModeMenuOpen = false;
let controlsMenuOpen = false;
let runtimeMenuOpen: RuntimeMenu | undefined;
let runtimeSelectionPending: RuntimeMenu | undefined;
let controlSelectionPending: "execution" | "work" | "approval" | undefined;
let settingsOpen = false;
let settingsTab: SettingsTab = "connection";
let collaborationMode: CollaborationMode = "normal";
let tokenMode: TokenMode = "balanced";
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
railNewSession.addEventListener("click", () => vscode.postMessage({ command: "newSession" }));
contextButton.addEventListener("click", insertContextMention);
workModeButton.addEventListener("click", (event) => {
  event.stopPropagation();
  workModeMenuOpen = !workModeMenuOpen;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = undefined;
  renderMenus(snapshot);
  if (workModeMenuOpen) {
    focusComposerChoice(workModeMenu, tokenMode);
  }
});
runtimeModelButton.addEventListener("click", (event) => openRuntimeMenu(event, "model"));
runtimeEffortButton.addEventListener("click", (event) => openRuntimeMenu(event, "effort"));
connectionConnect.addEventListener("click", () => vscode.postMessage({ command: "connect" }));
connectionSettings.addEventListener("click", () => {
  settingsOpen = true;
  settingsTab = "connection";
  render(snapshot);
});
settingsButton.addEventListener("click", () => {
  settingsOpen = true;
  settingsTab = "connection";
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  workModeMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = undefined;
  render(snapshot);
});
settingsBackButton.addEventListener("click", () => {
  settingsOpen = false;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  workModeMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = undefined;
  render(snapshot);
});

collaborationButton.addEventListener("click", (event) => {
  event.stopPropagation();
  collaborationMenuOpen = !collaborationMenuOpen;
  sessionMenuOpen = false;
  workModeMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = undefined;
  renderMenus(snapshot);
  if (collaborationMenuOpen) {
    focusComposerChoice(collaborationMenu, collaborationMode);
  }
});

approvalSummaryButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const nextOpen = !controlsMenuOpen;
  controlsMenuOpen = nextOpen;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  workModeMenuOpen = false;
  runtimeMenuOpen = undefined;
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
  }
});

controlsMenu.addEventListener("click", (event) => {
  event.stopPropagation();
});

workModeMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  const mode = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-token-mode]")?.dataset.tokenMode;
  if (isTokenMode(mode)) {
    chooseTokenMode(mode);
  }
});
workModeMenu.addEventListener("keydown", (event) => handleComposerChoiceKeydown(event, workModeMenu, tokenMode, chooseTokenMode, workModeButton));
collaborationMenu.addEventListener("keydown", (event) => handleComposerChoiceKeydown(event, collaborationMenu, collaborationMode, chooseCollaborationMode, collaborationButton));

runtimeModelMenu.addEventListener("click", (event) => handleRuntimeMenuClick(event, "model"));
runtimeEffortMenu.addEventListener("click", (event) => handleRuntimeMenuClick(event, "effort"));
runtimeModelMenu.addEventListener("keydown", (event) => handleRuntimeMenuKeydown(event, "model"));
runtimeEffortMenu.addEventListener("keydown", (event) => handleRuntimeMenuKeydown(event, "effort"));

sessionMenu.addEventListener("click", (event) => {
  event.stopPropagation();
  if (settingsOpen) {
    return;
  }
  sessionMenuOpen = !sessionMenuOpen;
  collaborationMenuOpen = false;
  workModeMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = undefined;
  renderMenus(snapshot);
});

document.addEventListener("click", (event) => {
  const target = event.target as Node | null;
  if (target !== prompt && (!target || !suggestionMenu.contains(target))) {
    closeSuggestions();
  }
  if (!sessionMenuOpen && !collaborationMenuOpen && !workModeMenuOpen && !controlsMenuOpen && !runtimeMenuOpen) {
    return;
  }
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  workModeMenuOpen = false;
  controlsMenuOpen = false;
  runtimeMenuOpen = undefined;
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
});

approvalModebar.addEventListener("click", (event) => {
  const mode = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-tool-approval-mode]")?.dataset.toolApprovalMode;
  if (isToolApprovalMode(mode)) {
    chooseToolApprovalMode(mode);
  }
});

controlsMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    controlsMenuOpen = false;
    renderMenus(snapshot);
    approvalSummaryButton.focus();
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
    chooseToolApprovalMode(activeMode);
    return;
  }

  if (nextIndex !== undefined) {
    event.preventDefault();
    const nextMode = toolApprovalModes[nextIndex];
    focusToolApprovalOption(nextMode);
  }
});

sessionPopover.addEventListener("click", handleSessionClick);
sessionRailList.addEventListener("click", handleSessionClick);

window.addEventListener("resize", () => {
  if (controlsMenuOpen) {
    positionControlsMenu();
  }
  if (runtimeMenuOpen) {
    positionRuntimeMenu(runtimeMenuOpen);
  }
  if (collaborationMenuOpen) {
    positionAnchoredMenu(collaborationMenu, collaborationButton);
  }
  if (workModeMenuOpen) {
    positionAnchoredMenu(workModeMenu, workModeButton);
  }
});

function handleSessionClick(event: MouseEvent): void {
  event.stopPropagation();
  const deleteButton = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-delete-session-id]");
  if (deleteButton?.dataset.deleteSessionId) {
    vscode.postMessage({ command: "deleteSession", sessionId: deleteButton.dataset.deleteSessionId });
    return;
  }
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-session-id]");
  const sessionId = button?.dataset.sessionId;
  if (sessionId) {
    sessionMenuOpen = false;
    vscode.postMessage({ command: "loadSession", sessionId });
  }
}

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

  const toolLocation = target?.closest<HTMLButtonElement>("button[data-tool-location]");
  if (toolLocation) {
    const index = Number(toolLocation.dataset.itemIndex);
    const locationIndex = Number(toolLocation.dataset.locationIndex);
    if (Number.isInteger(index) && Number.isInteger(locationIndex)) {
      vscode.postMessage({ command: "openToolLocation", index, locationIndex });
    }
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
    collaborationMenuOpen = false;
    workModeMenuOpen = false;
    controlsMenuOpen = false;
    runtimeMenuOpen = undefined;
    render(snapshot);
    return;
  }
  if (action === "pickModel") {
    vscode.postMessage({ command: "pickModel" });
    return;
  }
  if (action === "selectBinary") {
    vscode.postMessage({ command: "selectBinary" });
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
      const completedRuntimeSelection = runtimeSelectionPending;
      const completedControlSelection = controlSelectionPending;
      runtimeSelectionPending = undefined;
      controlSelectionPending = undefined;
      snapshot = normalizeSnapshot(message.state);
      syncComposerAxes(snapshot);
      vscode.setState(snapshot);
      render(snapshot);
      completedRuntimeSelection && runtimeMenuButton(completedRuntimeSelection).focus();
      completedControlSelection && controlButton(completedControlSelection).focus();
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
  railStatus.textContent = status.textContent;
  railStatus.title = state.workspace;
  railStatusDot.className = statusDot.className;
  railModel.textContent = shortModelLabel(state.modelLabel);
  railModel.title = state.modelLabel;
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
  railNewSessionLabel.textContent = label("new");
  railNewSession.title = label("new");
  railNewSession.setAttribute("aria-label", label("new"));
  sessionRailTitle.textContent = label("sessions");
  runtimeModelLabel.textContent = shortModelLabel(state.modelLabel);
  runtimeEffortLabel.textContent = shortEffortLabel(state.effortLabel);
  runtimeModelButton.title = `${label("pickModel")}: ${state.modelLabel}`;
  runtimeModelButton.setAttribute("aria-label", runtimeModelButton.title);
  runtimeEffortButton.title = state.effortSupported
    ? `${label("reasoningEffort")}: ${state.effortLabel}`
    : label("effortUnavailable");
  runtimeEffortButton.setAttribute("aria-label", runtimeEffortButton.title);
  runtimeModelButton.setAttribute("aria-expanded", String(runtimeMenuOpen === "model"));
  runtimeEffortButton.setAttribute("aria-expanded", String(runtimeMenuOpen === "effort"));
  settingsButton.textContent = "⚙";
  settingsButton.title = label("settings");
  settingsButton.setAttribute("aria-label", label("settings"));
  settingsBackButton.textContent = label("done");
  settingsModeTitle.textContent = label("settings");
  collaborationButton.title = `${label("executionMethod")}: ${collaborationModeText(collaborationMode)}`;
  collaborationButton.setAttribute("aria-label", `${label("executionMethod")}: ${collaborationModeText(collaborationMode)}`);
  collaborationButton.setAttribute("aria-haspopup", "menu");
  collaborationButton.setAttribute("aria-expanded", String(collaborationMenuOpen));
  controlsApprovalLabel.textContent = label("toolApprovals");
  contextButton.title = label("addContext");
  contextButton.setAttribute("aria-label", label("addContext"));
  composerHint.textContent = label("composerHint");
  prompt.placeholder = label("placeholder");
  newSession.disabled = state.running;
  railNewSession.disabled = state.running;
  collaborationButton.disabled = state.running;
  contextButton.disabled = state.running;
  workModeButton.disabled = state.disconnected || state.running || controlSelectionPending !== undefined || state.workModeOptions.length === 0;
  approvalSummaryButton.disabled = state.disconnected || state.running || controlSelectionPending !== undefined;
  collaborationButton.disabled = state.disconnected || state.running || controlSelectionPending !== undefined;
  runtimeModelButton.disabled = state.running || runtimeSelectionPending !== undefined || state.modelOptions.length === 0;
  runtimeEffortButton.disabled = state.running || runtimeSelectionPending !== undefined || state.effortOptions.length === 0;
  chatToolbarActions.hidden = settingsOpen;
  settingsToolbarActions.hidden = !settingsOpen;
  transcript.hidden = settingsOpen;
  settingsView.hidden = !settingsOpen;
  composer.hidden = settingsOpen;
  renderConnectionNotice(state);
  if (settingsOpen) {
    sessionMenuOpen = false;
    collaborationMenuOpen = false;
    workModeMenuOpen = false;
    controlsMenuOpen = false;
    runtimeMenuOpen = undefined;
    closeSuggestions();
  }
  if (state.disconnected || state.running || controlSelectionPending !== undefined) {
    collaborationMenuOpen = false;
    workModeMenuOpen = false;
    controlsMenuOpen = false;
    runtimeMenuOpen = undefined;
  }
  collaborationButton.setAttribute("aria-expanded", String(collaborationMenuOpen));
  workModeButton.setAttribute("aria-expanded", String(workModeMenuOpen));
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

function renderConnectionNotice(state: Snapshot): void {
  const reconnecting = state.status.startsWith("Reconnecting");
  const failed = state.status === "Start failed" || state.status === "Reconnect failed";
  connectionNotice.hidden = !state.disconnected;
  connectionNotice.classList.toggle("connection-notice--failed", failed);
  connectionNoticeText.textContent = reconnecting
    ? label("reconnecting")
    : failed
      ? label("connectionFailed")
      : label("reasonixNotConnected");
  connectionConnect.hidden = reconnecting;
  connectionConnect.textContent = failed ? label("retry") : label("connect");
  connectionSettings.hidden = !failed;
  connectionSettings.textContent = label("settings");
}

function insertContextMention(): void {
  const start = prompt.selectionStart;
  const end = prompt.selectionEnd;
  const needsSpace = start > 0 && !/\s/.test(prompt.value[start - 1] ?? "");
  prompt.setRangeText(`${needsSpace ? " " : ""}@`, start, end, "end");
  prompt.focus();
  resizePrompt();
  updateSendButton(snapshot);
  updateComposerSuggestions();
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
    button.hidden = !snapshot.toolApprovalOptions.some((option) => option.value === mode);
    const modeLabel = toolApprovalModeLabel(mode);
    const modeDetail = toolApprovalModeDetail(mode);
    button.classList.toggle("approval-menu__item--active", selected);
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.disabled = snapshot.running || controlSelectionPending !== undefined;
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

function chooseToolApprovalMode(mode: ToolApprovalMode): void {
  setToolApprovalMode(mode);
  controlsMenuOpen = false;
  if (mode === snapshot.toolApprovalMode) {
    renderMenus(snapshot);
    approvalSummaryButton.focus();
    return;
  }
  if (!snapshot.toolApprovalOptionId) {
    render(snapshot);
    return;
  }
  controlSelectionPending = "approval";
  render(snapshot);
  vscode.postMessage({ command: "setToolApprovalMode", optionId: snapshot.toolApprovalOptionId, value: mode });
}

function focusToolApprovalOption(mode: ToolApprovalMode): void {
  approvalModebar.querySelector<HTMLButtonElement>(`button[data-tool-approval-mode="${mode}"]`)?.focus();
}

function renderMenus(state: Snapshot): void {
  renderSessionPopover(state);
  renderCollaborationMenu(state);
  renderWorkModeMenu(state);
  renderControlsMenu();
  renderRuntimeMenus(state);
}

function renderControlSummaries(): void {
  const approvalLabel = toolApprovalModeLabel(toolApprovalMode);
  approvalSummaryLabel.textContent = approvalLabel;
  approvalSummaryButton.dataset.mode = toolApprovalMode;
  approvalSummaryButton.title = `${label("toolApprovals")}: ${approvalLabel}`;
  approvalSummaryButton.setAttribute("aria-label", approvalSummaryButton.title);

  collaborationModeLabel.textContent = collaborationModeText(collaborationMode);
  workModeLabel.textContent = workModeText(tokenMode);
  workModeButton.dataset.mode = tokenMode;
  workModeButton.title = `${label("workMode")}: ${workModeText(tokenMode)}`;
  workModeButton.setAttribute("aria-label", workModeButton.title);
  workModeButton.setAttribute("aria-expanded", String(workModeMenuOpen));

  renderModeChips(snapshot);
}

function collaborationModeText(mode: CollaborationMode): string {
  if (mode === "plan") {
    return label("plan");
  }
  if (mode === "goal") {
    return label("goal");
  }
  return label("normal");
}

function executionModeTitle(mode: CollaborationMode): string {
  if (mode === "plan") {
    return label("executionPlan");
  }
  return mode === "goal" ? label("executionGoal") : label("executionNormal");
}

function executionModeDetail(mode: CollaborationMode): string {
  if (mode === "plan") {
    return label("executionPlanDetail");
  }
  return mode === "goal" ? label("executionGoalDetail") : label("executionNormalDetail");
}

function executionModeIcon(mode: CollaborationMode): string {
  if (mode === "plan") {
    return "☷";
  }
  return mode === "goal" ? "◎" : "→";
}

function workModeText(mode: TokenMode): string {
  if (mode === "economy") {
    return label("workEconomyShort");
  }
  return mode === "delivery" ? label("workDeliveryShort") : label("workBalancedShort");
}

function workModeTitle(mode: TokenMode): string {
  if (mode === "economy") {
    return label("workEconomy");
  }
  return mode === "delivery" ? label("workDelivery") : label("workBalanced");
}

function workModeDetail(mode: TokenMode): string {
  if (mode === "economy") {
    return label("workEconomyDetail");
  }
  return mode === "delivery" ? label("workDeliveryDetail") : label("workBalancedDetail");
}

function workModeIcon(mode: TokenMode): string {
  if (mode === "economy") {
    return "◜";
  }
  return mode === "delivery" ? "⚑" : "=";
}

function renderModeChips(state: Snapshot): void {
  modeChipTray.textContent = "";
  if (collaborationMode === "plan") {
    modeChipTray.append(modeChipButton("plan", label("plan"), label("planDetail"), "☰", state.running));
  } else if (collaborationMode === "goal") {
    modeChipTray.append(modeChipButton("goal", label("goal"), label("goalActiveDetail"), "◎", state.running));
  }
  modeChipTray.hidden = modeChipTray.childElementCount === 0;
}

function modeChipButton(kind: CollaborationMode, titleText: string, detailText: string, iconText: string, disabled: boolean): HTMLButtonElement {
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
  title.textContent = label("executionMethod");
  collaborationMenu.setAttribute("aria-label", label("executionMethod"));
  collaborationMenu.append(title);
  for (const option of state.executionOptions) {
    if (isCollaborationMode(option.value)) {
      collaborationMenu.append(collaborationMenuRow(
        option.value,
        executionModeTitle(option.value),
        executionModeDetail(option.value),
        executionModeIcon(option.value),
        state.running,
      ));
    }
  }
  collaborationMenu.hidden = !collaborationMenuOpen;
  collaborationButton.setAttribute("aria-expanded", String(collaborationMenuOpen));
  if (collaborationMenuOpen) {
    positionAnchoredMenu(collaborationMenu, collaborationButton);
  }
}

function renderWorkModeMenu(state: Snapshot): void {
  workModeMenu.textContent = "";
  const title = document.createElement("div");
  title.className = "collaboration-menu__title";
  title.textContent = label("workMode");
  workModeMenu.setAttribute("aria-label", label("workMode"));
  workModeMenu.append(title);
  for (const option of state.workModeOptions) {
    if (isTokenMode(option.value)) {
      workModeMenu.append(tokenMenuRow(option.value, workModeTitle(option.value), workModeDetail(option.value), workModeIcon(option.value), state.running));
    }
  }
  workModeMenu.hidden = !workModeMenuOpen;
  workModeButton.setAttribute("aria-expanded", String(workModeMenuOpen));
  if (workModeMenuOpen) {
    positionAnchoredMenu(workModeMenu, workModeButton);
  }
}

function renderControlsMenu(): void {
  controlsMenu.hidden = !controlsMenuOpen;
  approvalSummaryButton.setAttribute("aria-expanded", String(controlsMenuOpen));
  if (controlsMenuOpen) {
    positionControlsMenu();
  }
}

function positionControlsMenu(): void {
  const viewportMargin = 8;
  const gap = 8;
  const anchor = approvalSummaryButton.getBoundingClientRect();
  const width = Math.max(0, Math.min(280, window.innerWidth - viewportMargin * 2));
  const left = Math.max(viewportMargin, Math.min(anchor.left, window.innerWidth - width - viewportMargin));
  controlsMenu.style.width = `${width}px`;
  controlsMenu.style.left = `${left}px`;
  controlsMenu.style.bottom = `${window.innerHeight - anchor.top + gap}px`;
}

function openRuntimeMenu(event: Event, kind: RuntimeMenu): void {
  event.stopPropagation();
  const nextOpen = runtimeMenuOpen === kind ? undefined : kind;
  runtimeMenuOpen = nextOpen;
  sessionMenuOpen = false;
  collaborationMenuOpen = false;
  workModeMenuOpen = false;
  controlsMenuOpen = false;
  renderMenus(snapshot);
  if (nextOpen) {
    focusRuntimeOption(nextOpen);
  }
}

function handleRuntimeMenuClick(event: MouseEvent, kind: RuntimeMenu): void {
  event.stopPropagation();
  const value = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-runtime-value]")?.dataset.runtimeValue;
  if (value !== undefined) {
    chooseRuntimeOption(kind, value);
  }
}

function handleRuntimeMenuKeydown(event: KeyboardEvent, kind: RuntimeMenu): void {
  const menu = runtimeMenuElement(kind);
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button[data-runtime-value]"));
  const current = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-runtime-value]");
  if (event.key === "Escape") {
    event.preventDefault();
    runtimeMenuOpen = undefined;
    renderMenus(snapshot);
    runtimeMenuButton(kind).focus();
    return;
  }
  if (buttons.length === 0) {
    return;
  }
  const currentIndex = Math.max(0, buttons.indexOf(current ?? buttons[0]));
  let nextIndex: number | undefined;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % buttons.length;
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    nextIndex = (currentIndex + buttons.length - 1) % buttons.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = buttons.length - 1;
  } else if ((event.key === "Enter" || event.key === " ") && current?.dataset.runtimeValue !== undefined) {
    event.preventDefault();
    chooseRuntimeOption(kind, current.dataset.runtimeValue);
    return;
  }
  if (nextIndex !== undefined && buttons[nextIndex]) {
    event.preventDefault();
    buttons.forEach((button, index) => button.tabIndex = index === nextIndex ? 0 : -1);
    buttons[nextIndex].focus();
  }
}

function chooseRuntimeOption(kind: RuntimeMenu, value: string): void {
  const options = kind === "model" ? snapshot.modelOptions : snapshot.effortOptions;
  const option = options.find((candidate) => candidate.value === value);
  runtimeMenuOpen = undefined;
  if (!option || option.selected) {
    renderMenus(snapshot);
    runtimeMenuButton(kind).focus();
    return;
  }
  runtimeSelectionPending = kind;
  render(snapshot);
  if (kind === "model") {
    vscode.postMessage({ command: "setModel", value });
  } else if (snapshot.effortOptionId) {
    vscode.postMessage({ command: "setEffort", optionId: snapshot.effortOptionId, value });
  } else {
    runtimeSelectionPending = undefined;
    render(snapshot);
    runtimeMenuButton(kind).focus();
  }
}

function focusRuntimeOption(kind: RuntimeMenu): void {
  const menu = runtimeMenuElement(kind);
  const selected = menu.querySelector<HTMLButtonElement>('button[aria-checked="true"]');
  (selected ?? menu.querySelector<HTMLButtonElement>("button[data-runtime-value]"))?.focus();
}

function positionRuntimeMenu(kind: RuntimeMenu): void {
  positionAnchoredMenu(runtimeMenuElement(kind), runtimeMenuButton(kind));
}

function positionAnchoredMenu(menu: HTMLElement, anchorButton: HTMLButtonElement): void {
  const viewportMargin = 8;
  const gap = 8;
  const anchor = anchorButton.getBoundingClientRect();
  const width = Math.max(0, Math.min(280, window.innerWidth - viewportMargin * 2));
  const left = Math.max(viewportMargin, Math.min(anchor.left, window.innerWidth - width - viewportMargin));
  menu.style.width = `${width}px`;
  menu.style.left = `${left}px`;
  menu.style.bottom = `${window.innerHeight - anchor.top + gap}px`;
}

function runtimeMenuElement(kind: RuntimeMenu): HTMLElement {
  return kind === "model" ? runtimeModelMenu : runtimeEffortMenu;
}

function runtimeMenuButton(kind: RuntimeMenu): HTMLButtonElement {
  return kind === "model" ? runtimeModelButton : runtimeEffortButton;
}

function renderRuntimeMenus(state: Snapshot): void {
  renderRuntimeMenu("model", runtimeModelMenu, state.modelOptions, label("model"));
  renderRuntimeMenu("effort", runtimeEffortMenu, state.effortOptions, label("reasoningEffort"));
  runtimeModelButton.setAttribute("aria-expanded", String(runtimeMenuOpen === "model"));
  runtimeEffortButton.setAttribute("aria-expanded", String(runtimeMenuOpen === "effort"));
}

function renderRuntimeMenu(kind: RuntimeMenu, menu: HTMLElement, options: RuntimeSelectOption[], titleText: string): void {
  menu.textContent = "";
  const title = document.createElement("div");
  title.className = "controls-label runtime-option-menu__title";
  title.textContent = titleText;
  const list = document.createElement("div");
  list.className = "approval-menu runtime-option-menu__list";
  list.setAttribute("role", "menu");
  for (const option of options) {
    list.append(runtimeOptionRow(kind, option));
  }
  menu.append(title, list);
  menu.hidden = runtimeMenuOpen !== kind;
  if (!menu.hidden) {
    positionRuntimeMenu(kind);
  }
}

function runtimeOptionRow(kind: RuntimeMenu, option: RuntimeSelectOption): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `approval-menu__item${option.selected ? " approval-menu__item--active" : ""}`;
  button.dataset.runtimeKind = kind;
  button.dataset.runtimeValue = option.value;
  button.setAttribute("role", "menuitemradio");
  button.setAttribute("aria-checked", String(option.selected));
  button.tabIndex = option.selected ? 0 : -1;
  const check = document.createElement("span");
  check.className = "approval-menu__check";
  check.textContent = "✓";
  check.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "approval-menu__copy";
  const optionLabel = document.createElement("span");
  optionLabel.className = "approval-menu__label";
  optionLabel.textContent = option.label;
  const detail = document.createElement("span");
  detail.className = "approval-menu__detail";
  detail.textContent = option.description || option.value;
  copy.append(optionLabel, detail);
  button.append(check, copy);
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
  button.setAttribute("role", "menuitemradio");
  button.setAttribute("aria-checked", String(selected));
  button.tabIndex = selected ? 0 : -1;
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
  toggle.className = "collaboration-menu__check";
  toggle.textContent = selected ? "✓" : "";
  toggle.setAttribute("aria-hidden", "true");
  copy.append(title, detail);
  button.append(icon, copy, toggle);
  return button;
}

function chooseCollaborationMode(mode: CollaborationMode): void {
  collaborationMode = mode;
  collaborationMenuOpen = false;
  workModeMenuOpen = false;
  runtimeMenuOpen = undefined;
  if (mode === snapshot.executionMode) {
    render(snapshot);
    collaborationButton.focus();
    return;
  }
  controlSelectionPending = "execution";
  render(snapshot);
  vscode.postMessage({ command: "setExecutionMode", value: mode });
}

function chooseTokenMode(mode: TokenMode): void {
  tokenMode = mode;
  collaborationMenuOpen = false;
  workModeMenuOpen = false;
  runtimeMenuOpen = undefined;
  if (mode === snapshot.workMode) {
    render(snapshot);
    workModeButton.focus();
    return;
  }
  if (!snapshot.workModeOptionId) {
    render(snapshot);
    return;
  }
  controlSelectionPending = "work";
  render(snapshot);
  vscode.postMessage({ command: "setWorkMode", optionId: snapshot.workModeOptionId, value: mode });
}

function syncComposerAxes(state: Snapshot): void {
  collaborationMode = state.executionMode;
  tokenMode = state.workMode;
  toolApprovalMode = state.toolApprovalMode;
}

function controlButton(kind: "execution" | "work" | "approval"): HTMLButtonElement {
  if (kind === "execution") {
    return collaborationButton;
  }
  return kind === "work" ? workModeButton : approvalSummaryButton;
}

function focusComposerChoice(menu: HTMLElement, value: string): void {
  const selected = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.dataset.collaborationMode === value || button.dataset.tokenMode === value);
  (selected ?? menu.querySelector<HTMLButtonElement>("button"))?.focus();
}

function handleComposerChoiceKeydown<T extends string>(
  event: KeyboardEvent,
  menu: HTMLElement,
  currentValue: T,
  choose: (value: T) => void,
  anchor: HTMLButtonElement,
): void {
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]'));
  const current = (event.target as Element | null)?.closest<HTMLButtonElement>('button[role="menuitemradio"]');
  if (event.key === "Escape") {
    event.preventDefault();
    collaborationMenuOpen = false;
    workModeMenuOpen = false;
    renderMenus(snapshot);
    anchor.focus();
    return;
  }
  if (buttons.length === 0) {
    return;
  }
  const selectedIndex = buttons.findIndex((button) => button.dataset.collaborationMode === currentValue || button.dataset.tokenMode === currentValue);
  const currentIndex = Math.max(0, current ? buttons.indexOf(current) : selectedIndex);
  let nextIndex: number | undefined;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % buttons.length;
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    nextIndex = (currentIndex + buttons.length - 1) % buttons.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = buttons.length - 1;
  } else if ((event.key === "Enter" || event.key === " ") && current) {
    const value = current.dataset.collaborationMode ?? current.dataset.tokenMode;
    if (value !== undefined) {
      event.preventDefault();
      choose(value as T);
    }
    return;
  }
  if (nextIndex !== undefined) {
    event.preventDefault();
    buttons.forEach((button, index) => button.tabIndex = index === nextIndex ? 0 : -1);
    buttons[nextIndex]?.focus();
  }
}

function focusPromptSoon(): void {
  requestAnimationFrame(() => {
    prompt.focus();
  });
}

function renderSessionPopover(state: Snapshot): void {
  renderSessionList(sessionPopover, state);
  renderSessionList(sessionRailList, state);
  sessionPopover.hidden = !sessionMenuOpen;
}

function renderSessionList(container: HTMLElement, state: Snapshot): void {
  container.textContent = "";
  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = label("noSessions");
    container.append(empty);
  } else {
    for (const session of state.sessions) {
      const row = document.createElement("div");
      row.className = session.id === state.sessionId ? "session-row selected" : "session-row";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.sessionId = session.id;
      button.className = "menu-row session-load";
      const title = document.createElement("span");
      title.textContent = session.title;
      const detail = document.createElement("small");
      detail.textContent = relativeTime(session.updatedAt);
      button.append(title, detail);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "micro-button session-delete";
      remove.dataset.deleteSessionId = session.id;
      remove.title = label("deleteSession");
      remove.setAttribute("aria-label", label("deleteSession"));
      remove.textContent = "×";
      row.append(button, remove);
      container.append(row);
    }
  }
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
        settingsActionRow(
          settingsActionButton("selectBinary", label("selectBinary")),
          settingsActionButton("pickModel", label("pickModel")),
          settingsActionButton("showOutput", label("logs")),
        ),
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
    case "question":
      return renderQuestion(item);
    case "plan":
      return renderPlan(item);
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
  const brand = document.createElement("div");
  brand.className = "empty-brand";
  const brandName = document.createElement("span");
  brandName.textContent = "Reasonix";
  brand.append(mark, brandName);
  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = label("whatCanIDo");
  const detail = document.createElement("div");
  detail.className = "empty-detail";
  const modelMeta = document.createElement("span");
  modelMeta.className = "empty-meta-chip";
  modelMeta.textContent = isDefaultModelLabel(state.modelLabel)
    ? label("model")
    : `${label("model")}  ${shortModelLabel(state.modelLabel)}`;
  modelMeta.title = state.modelLabel;
  const workspaceMeta = document.createElement("span");
  workspaceMeta.className = "empty-meta-chip";
  workspaceMeta.textContent = `${label("workspace")}  ${state.workspace}`;
  workspaceMeta.title = state.workspace;
  detail.append(modelMeta, workspaceMeta);
  const actions = document.createElement("div");
  actions.className = "empty-actions";
  if (!state.disconnected) {
    actions.append(
      quickButton("explainFile", label("explainFile")),
      quickButton("fixSelection", label("fixSelection")),
      quickButton("runTests", label("runTests")),
      quickButton("searchRepo", label("searchRepo")),
    );
    node.append(brand, title, detail, actions);
  } else {
    node.append(brand, title, detail);
  }
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
  if (item.locations && item.locations.length > 0) {
    const locations = document.createElement("div");
    locations.className = "tool-locations";
    item.locations.forEach((location, locationIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "context-action";
      button.dataset.toolLocation = "true";
      button.dataset.itemIndex = String(index);
      button.dataset.locationIndex = String(locationIndex);
      button.textContent = location.line ? `${location.path}:${location.line}` : location.path;
      button.title = label("openLocation");
      locations.append(button);
    });
    node.append(locations);
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

function renderQuestion(item: Extract<ChatItem, { type: "question" }>): HTMLElement {
  const node = document.createElement("section");
  node.className = `item question ${item.status}`;
  node.append(renderToolHeader(item.title, item.status === "pending" ? label("question") : statusLabel(item.status)));
  if (item.detail) {
    const detail = document.createElement("div");
    detail.className = "text";
    detail.textContent = item.detail;
    node.append(detail);
  }
  const actions = document.createElement("div");
  actions.className = "approval-actions question-actions";
  for (const option of item.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.approvalId = item.id;
    button.dataset.optionId = option.optionId;
    button.disabled = item.status !== "pending";
    button.textContent = option.name;
    actions.append(button);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.dataset.approvalId = item.id;
  cancel.dataset.optionId = "cancelled";
  cancel.disabled = item.status !== "pending";
  cancel.textContent = label("cancel");
  actions.append(cancel);
  node.append(actions);
  return node;
}

function renderPlan(item: Extract<ChatItem, { type: "plan" }>): HTMLElement {
  const node = document.createElement("section");
  node.className = "item plan";
  node.append(renderItemHeader(label("plan")));
  const list = document.createElement("ol");
  list.className = "plan-list";
  for (const entry of item.entries) {
    const row = document.createElement("li");
    row.className = `plan-entry ${statusClass(entry.status)}`;
    const marker = document.createElement("span");
    marker.className = "plan-marker";
    marker.textContent = entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "●" : "○";
    const text = document.createElement("span");
    text.textContent = entry.content;
    const priority = document.createElement("small");
    priority.textContent = entry.priority;
    row.append(marker, text, priority);
    list.append(row);
  }
  node.append(list);
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
  if (usage.sessionCacheHitTokens + usage.sessionCacheMissTokens > 0) {
    text.append(metric(label("cache"), cacheLabel(usage.sessionCacheHitTokens, usage.sessionCacheMissTokens)));
  }
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
    const nativeCommands = snapshot.availableCommands;
    suggestionState = {
      trigger,
      items: nativeCommands && nativeCommands.length > 0
        ? nativeSlashSuggestions(nativeCommands, trigger.query)
        : slashSuggestions(trigger.query, snapshot.locale).map(slashMenuItem),
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

function nativeSlashSuggestions(commands: AvailableCommand[], query: string): ComposerMenuItem[] {
  const normalized = query.toLowerCase();
  return commands
    .filter((command) => normalized === "" || command.name.toLowerCase().includes(normalized) || command.description.toLowerCase().includes(normalized))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(normalized)) - Number(!b.name.toLowerCase().startsWith(normalized)) || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((command) => ({
      icon: "/",
      title: `/${command.name}`,
      detail: command.input?.hint ? `${command.description} · ${command.input.hint}` : command.description,
      badge: label("command"),
      insertText: `/${command.name}`,
    }));
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
    modelOptions: [],
    effortOptions: [],
    executionMode: "normal",
    executionOptions: [],
    workMode: "balanced",
    workModeOptions: [],
    toolApprovalMode: "ask",
    toolApprovalOptions: [],
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
    modelOptions: normalizeRuntimeOptions(value.modelOptions),
    effortOptions: normalizeRuntimeOptions(value.effortOptions),
    effortOptionId: typeof value.effortOptionId === "string" ? value.effortOptionId : undefined,
    executionMode: isCollaborationMode(value.executionMode) ? value.executionMode : "normal",
    executionOptions: normalizeRuntimeOptions(value.executionOptions),
    workMode: isTokenMode(value.workMode) ? value.workMode : "balanced",
    workModeOptions: normalizeRuntimeOptions(value.workModeOptions),
    workModeOptionId: typeof value.workModeOptionId === "string" ? value.workModeOptionId : undefined,
    toolApprovalMode: isToolApprovalMode(value.toolApprovalMode) ? value.toolApprovalMode : "ask",
    toolApprovalOptions: normalizeRuntimeOptions(value.toolApprovalOptions),
    toolApprovalOptionId: typeof value.toolApprovalOptionId === "string" ? value.toolApprovalOptionId : undefined,
    cacheLabel: typeof value.cacheLabel === "string" ? value.cacheLabel : undefined,
    locale: typeof value.locale === "string" ? value.locale : "en",
    uiLanguage: isUiLanguage(value.uiLanguage) ? value.uiLanguage : "auto",
    settings: normalizeSettings(value.settings, contextMode, value.uiLanguage),
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    sessions: Array.isArray(value.sessions) ? (value.sessions as SessionSummary[]).filter(isSessionSummary) : [],
    mcp: normalizeMcp(value.mcp),
    availableCommands: Array.isArray(value.availableCommands) ? value.availableCommands as AvailableCommand[] : undefined,
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

function normalizeRuntimeOptions(value: unknown): RuntimeSelectOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option): RuntimeSelectOption[] => {
    if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") {
      return [];
    }
    return [{
      value: option.value,
      label: option.label,
      description: typeof option.description === "string" ? option.description : undefined,
      selected: option.selected === true,
    }];
  });
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
  if (isDefaultModelLabel(trimmed)) {
    return label("model");
  }
  const compact = (trimmed.split("/").at(-1) ?? trimmed).trim();
  return compact.length > 16 ? `${compact.slice(0, 15)}...` : compact;
}

function isDefaultModelLabel(value: string): boolean {
  return value.trim() === "Default model";
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
  return value === "economy" || value === "balanced" || value === "delivery";
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
  | "addContext"
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
  | "cancel"
  | "cancelled"
  | "code"
  | "completed"
  | "command"
  | "clickToDisable"
  | "executionMethod"
  | "executionNormal"
  | "executionNormalDetail"
  | "executionPlan"
  | "executionPlanDetail"
  | "executionGoal"
  | "executionGoalDetail"
  | "composerControls"
  | "connect"
  | "connection"
  | "connectionFailed"
  | "context"
  | "contextOff"
  | "continue"
  | "copied"
  | "copy"
  | "cost"
  | "disconnected"
  | "deleteSession"
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
  | "normal"
  | "normalDetail"
  | "noContext"
  | "noSuggestions"
  | "noSessions"
  | "none"
  | "notice"
  | "off"
  | "offDetail"
  | "once"
  | "openDiff"
  | "openLocation"
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
  | "question"
  | "reasonixNotConnected"
  | "readyTitle"
  | "reasoning"
  | "reasoningEffort"
  | "reconnecting"
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
  | "selectBinary"
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
  | "toolApprovals"
  | "trace"
  | "usage"
  | "user"
  | "whatCanIDo"
  | "workspace"
  | "workspaceFiles"
  | "workMode"
  | "workEconomy"
  | "workEconomyShort"
  | "workEconomyDetail"
  | "workBalanced"
  | "workBalancedShort"
  | "workBalancedDetail"
  | "workDelivery"
  | "workDeliveryShort"
  | "workDeliveryDetail"
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
    addContext: "Add file or folder context",
    always: "Always",
    act: "Act",
    apiConfiguration: "API Configuration",
    apiProvider: "API Provider",
    approval: "approval",
    approvalReview: "Approval: review tool requests",
    ask: "Ask",
    askDetail: "Ask before approval-gated tool calls.",
    autoApproval: "Auto",
    autoApprovalDetail: "Follow configured permission rules without fallback prompts.",
    autoLanguage: "Auto",
    autoStart: "Auto start",
    backToChat: "Back",
    behavior: "Behavior",
    cache: "Cache",
    cacheDiagnostics: "Cache diagnostics",
    cancel: "Cancel",
    cancelled: "cancelled",
    code: "code",
    completed: "completed",
    command: "command",
    clickToDisable: "Click to turn off",
    executionMethod: "Execution method",
    executionNormal: "Standard · Work as you go",
    executionNormalDetail: "Analyze and act as you go for clear everyday tasks.",
    executionPlan: "Plan · Confirm first",
    executionPlanDetail: "Draft a read-only plan, then execute after confirmation.",
    executionGoal: "Goal · Keep progressing",
    executionGoalDetail: "Keep working until the goal is complete or blocked.",
    composerControls: "Composer controls",
    connect: "Connect",
    connection: "Connection",
    connectionFailed: "Reasonix could not connect",
    context: "Context",
    contextOff: "No editor context",
    continue: "Continue",
    copied: "Copied",
    copy: "Copy",
    cost: "Cost",
    disconnected: "Disconnected",
    deleteSession: "Delete session",
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
    normal: "Normal",
    normalDetail: "Work directly on the request with standard agent behavior.",
    noContext: "No active editor context",
    noSuggestions: "No matches",
    noSessions: "No recent sessions",
    none: "None",
    notice: "notice",
    off: "Off",
    offDetail: "Send prompts without editor context.",
    once: "Once",
    openDiff: "Open diff",
    openLocation: "Open location",
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
    question: "Question",
    reasonixNotConnected: "Reasonix is not connected",
    readyTitle: "Ready",
    reasoning: "Reasoning",
    reasoningEffort: "Reasoning effort",
    reconnecting: "Reconnecting to Reasonix...",
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
    selectBinary: "Select CLI",
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
    toolApprovals: "Tool approvals",
    trace: "Trace",
    usage: "usage",
    user: "user",
    whatCanIDo: "What can I do for you?",
    workspace: "Workspace",
    workspaceFiles: "Workspace files",
    workMode: "Work mode",
    workEconomy: "Lightweight · Use less",
    workEconomyShort: "Lightweight",
    workEconomyDetail: "Less context · Tools on demand",
    workBalanced: "Balanced · Everyday",
    workBalancedShort: "Balanced",
    workBalancedDetail: "Full tools · Model-directed work",
    workDelivery: "Delivery · Full verification",
    workDeliveryShort: "Delivery",
    workDeliveryDetail: "Acceptance · Review · Verify",
    yolo: "Yolo",
    yoloDetail: "Approve tool calls except protected decisions.",
    chinese: "Chinese",
    cliPath: "Reasonix CLI",
    interface: "Interface",
    openVsCodeSettings: "VS Code Settings",
    save: "Save",
  },
  zh: {
    add: "加入",
    addContext: "添加文件或文件夹上下文",
    always: "总是允许",
    act: "执行",
    apiConfiguration: "API 配置",
    apiProvider: "API 提供方",
    approval: "审批",
    approvalReview: "审批：工具请求需确认",
    ask: "询问",
    askDetail: "受控工具调用前先询问确认。",
    autoApproval: "自动",
    autoApprovalDetail: "按权限规则自动处理，不再回退询问。",
    autoLanguage: "自动",
    autoStart: "自动启动",
    backToChat: "返回",
    behavior: "行为",
    cache: "缓存",
    cacheDiagnostics: "缓存诊断",
    cancel: "取消",
    cancelled: "已取消",
    code: "代码",
    completed: "已完成",
    command: "命令",
    clickToDisable: "点击关闭",
    executionMethod: "执行方式",
    executionNormal: "常规 · 边做边推进",
    executionNormalDetail: "边分析边执行，适合明确的日常任务。",
    executionPlan: "计划 · 确认后执行",
    executionPlanDetail: "先只读产出计划，确认后再执行。",
    executionGoal: "目标 · 持续推进",
    executionGoalDetail: "输入目标后持续工作，直到完成或阻塞。",
    composerControls: "输入控制",
    connect: "连接",
    connection: "连接",
    connectionFailed: "Reasonix 连接失败",
    context: "上下文",
    contextOff: "不带编辑器上下文",
    continue: "继续",
    copied: "已复制",
    copy: "复制",
    cost: "费用",
    disconnected: "已断开",
    deleteSession: "删除会话",
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
    normal: "常规",
    normalDetail: "按常规智能体方式直接处理当前请求。",
    noContext: "没有可用编辑器上下文",
    noSuggestions: "没有匹配项",
    noSessions: "暂无最近会话",
    none: "无",
    notice: "通知",
    off: "关闭",
    offDetail: "发送时不附加编辑器上下文。",
    once: "本次",
    openDiff: "打开 Diff",
    openLocation: "打开位置",
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
    question: "问题",
    reasonixNotConnected: "Reasonix 未连接",
    readyTitle: "准备就绪",
    reasoning: "推理",
    reasoningEffort: "推理强度",
    reconnecting: "正在重新连接 Reasonix...",
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
    selectBinary: "选择 CLI",
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
    toolApprovals: "工具权限",
    trace: "追踪日志",
    usage: "用量",
    user: "用户",
    whatCanIDo: "我能帮你做什么？",
    workspace: "工作区",
    workspaceFiles: "工作区文件",
    workMode: "工作模式",
    workEconomy: "轻量 · 快速省用量",
    workEconomyShort: "轻量",
    workEconomyDetail: "少上下文 · 工具按需启用",
    workBalanced: "均衡 · 日常通用",
    workBalancedShort: "均衡",
    workBalancedDetail: "完整工具 · 模型自主执行",
    workDelivery: "交付 · 完整验证",
    workDeliveryShort: "交付",
    workDeliveryDetail: "强制验收 · 复查验证",
    yolo: "Yolo",
    yoloDetail: "自动批准工具调用，但受保护决策仍需确认。",
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
