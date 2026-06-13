export type WebviewToHostMessage =
  | {
      command: "sendPrompt";
      text: string;
      collaborationMode?: CollaborationMode;
      tokenMode?: TokenMode;
      toolApprovalMode?: ToolApprovalMode;
    }
  | { command: "cancel" }
  | { command: "newSession" }
  | { command: "setContextMode"; mode: "off" | "selectionOnly" | "nearby" }
  | { command: "updateSetting"; key: SettingKey; value: string | boolean }
  | { command: "pickModel" }
  | { command: "pickUiLanguage" }
  | { command: "openNativeSettings" }
  | { command: "showOutput" }
  | { command: "loadSession"; sessionId: string }
  | { command: "quickPrompt"; action: "explainFile" | "fixSelection" | "runTests" | "searchRepo" }
  | { command: "copyText"; text: string }
  | { command: "openExternal"; href: string }
  | { command: "insertMessage"; index: number }
  | { command: "retryMessage"; index: number }
  | { command: "continueMessage"; index: number }
  | { command: "openToolPreview"; index: number }
  | { command: "approvalDecision"; id: string; optionId: string }
  | { command: "stateSnapshot" };

type SettingKey = "binaryPath" | "model" | "uiLanguage" | "autoStart" | "trace" | "includeSelectionMode";
type CollaborationMode = "normal" | "plan" | "goal";
type TokenMode = "standard" | "economy";
type ToolApprovalMode = "ask" | "auto" | "yolo";

export type HostToWebviewMessage =
  | { type: "stateSnapshot"; state: unknown }
  | { type: "notice"; text: string }
  | { type: "openSettings" };

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!isRecord(value) || typeof value.command !== "string") {
    return undefined;
  }
  switch (value.command) {
    case "sendPrompt":
      if (typeof value.text !== "string") {
        return undefined;
      }
      return withPromptModes({
        command: "sendPrompt",
        text: value.text,
      }, value);
    case "cancel":
    case "newSession":
    case "pickModel":
    case "pickUiLanguage":
    case "openNativeSettings":
    case "showOutput":
    case "stateSnapshot":
      return { command: value.command };
    case "setContextMode":
      return value.mode === "off" || value.mode === "selectionOnly" || value.mode === "nearby"
        ? { command: "setContextMode", mode: value.mode }
        : undefined;
    case "updateSetting":
      return parseUpdateSetting(value);
    case "loadSession":
      return typeof value.sessionId === "string" && value.sessionId.trim() !== "" ? { command: "loadSession", sessionId: value.sessionId } : undefined;
    case "quickPrompt":
      return value.action === "explainFile" || value.action === "fixSelection" || value.action === "runTests" || value.action === "searchRepo"
        ? { command: "quickPrompt", action: value.action }
        : undefined;
    case "copyText":
      return typeof value.text === "string" ? { command: "copyText", text: value.text } : undefined;
    case "openExternal":
      return typeof value.href === "string" ? { command: "openExternal", href: value.href } : undefined;
    case "insertMessage":
    case "retryMessage":
    case "continueMessage":
    case "openToolPreview":
      return isValidIndex(value.index) ? { command: value.command, index: value.index } : undefined;
    case "approvalDecision":
      return typeof value.id === "string" && typeof value.optionId === "string"
        ? { command: "approvalDecision", id: value.id, optionId: value.optionId }
        : undefined;
    default:
      return undefined;
  }
}

function withPromptModes(
  message: Extract<WebviewToHostMessage, { command: "sendPrompt" }>,
  value: Record<string, unknown>,
): Extract<WebviewToHostMessage, { command: "sendPrompt" }> {
  if (isCollaborationMode(value.collaborationMode)) {
    message.collaborationMode = value.collaborationMode;
  }
  if (isTokenMode(value.tokenMode)) {
    message.tokenMode = value.tokenMode;
  }
  if (isToolApprovalMode(value.toolApprovalMode)) {
    message.toolApprovalMode = value.toolApprovalMode;
  }
  return message;
}

function parseUpdateSetting(value: Record<string, unknown>): WebviewToHostMessage | undefined {
  if (!isSettingKey(value.key)) {
    return undefined;
  }
  switch (value.key) {
    case "binaryPath":
    case "model":
      return typeof value.value === "string" ? { command: "updateSetting", key: value.key, value: value.value } : undefined;
    case "uiLanguage":
      return value.value === "auto" || value.value === "en" || value.value === "zh-CN"
        ? { command: "updateSetting", key: value.key, value: value.value }
        : undefined;
    case "includeSelectionMode":
      return value.value === "off" || value.value === "selectionOnly" || value.value === "nearby"
        ? { command: "updateSetting", key: value.key, value: value.value }
        : undefined;
    case "autoStart":
    case "trace":
      return typeof value.value === "boolean" ? { command: "updateSetting", key: value.key, value: value.value } : undefined;
  }
}

function isSettingKey(value: unknown): value is SettingKey {
  return value === "binaryPath" || value === "model" || value === "uiLanguage" || value === "autoStart" || value === "trace" || value === "includeSelectionMode";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
