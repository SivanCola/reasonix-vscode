import type { ResourceSuggestion } from "./resourceSuggestions";

export type WebviewToHostMessage =
  | {
      command: "sendPrompt";
      text: string;
      collaborationMode?: CollaborationMode;
      tokenMode?: TokenMode;
      toolApprovalMode?: ToolApprovalMode;
    }
  | { command: "cancel" }
  | { command: "connect" }
  | { command: "newSession" }
  | { command: "setContextMode"; mode: "off" | "selectionOnly" | "nearby" }
  | { command: "updateSetting"; key: SettingKey; value: string | boolean }
  | { command: "pickModel" }
  | { command: "pickEffort" }
  | { command: "setModel"; value: string }
  | { command: "setEffort"; optionId: string; value: string }
  | { command: "setExecutionMode"; value: CollaborationMode }
  | { command: "setWorkMode"; optionId: string; value: TokenMode }
  | { command: "setToolApprovalMode"; optionId: string; value: ToolApprovalMode }
  | { command: "pickUiLanguage" }
  | { command: "selectBinary" }
  | { command: "openNativeSettings" }
  | { command: "showOutput" }
  | { command: "loadSession"; sessionId: string }
  | { command: "deleteSession"; sessionId: string }
  | { command: "quickPrompt"; action: "explainFile" | "fixSelection" | "runTests" | "searchRepo" }
  | { command: "copyText"; text: string }
  | { command: "openExternal"; href: string }
  | { command: "insertMessage"; index: number }
  | { command: "retryMessage"; index: number }
  | { command: "continueMessage"; index: number }
  | { command: "openToolPreview"; index: number }
  | { command: "openToolLocation"; index: number; locationIndex: number }
  | { command: "approvalDecision"; id: string; optionId: string }
  | { command: "resourceSuggestions"; requestId: number; query: string }
  | { command: "stateSnapshot" };

type SettingKey = "binaryPath" | "model" | "uiLanguage" | "autoStart" | "trace" | "includeSelectionMode";
type CollaborationMode = "normal" | "plan" | "goal";
type TokenMode = "economy" | "balanced" | "delivery";
type ToolApprovalMode = "ask" | "auto" | "yolo";

export type HostToWebviewMessage =
  | { type: "stateSnapshot"; state: unknown }
  | { type: "notice"; text: string }
  | { type: "resourceSuggestions"; requestId: number; query: string; items: ResourceSuggestion[] }
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
    case "connect":
    case "newSession":
    case "pickModel":
    case "pickEffort":
    case "pickUiLanguage":
    case "selectBinary":
    case "openNativeSettings":
    case "showOutput":
    case "stateSnapshot":
      return { command: value.command };
    case "setContextMode":
      return value.mode === "off" || value.mode === "selectionOnly" || value.mode === "nearby"
        ? { command: "setContextMode", mode: value.mode }
        : undefined;
    case "setModel":
      return isRuntimeOptionValue(value.value) ? { command: "setModel", value: value.value } : undefined;
    case "setEffort":
      return isRuntimeOptionValue(value.optionId) && isRuntimeOptionValue(value.value)
        ? { command: "setEffort", optionId: value.optionId, value: value.value }
        : undefined;
    case "setExecutionMode":
      return isCollaborationMode(value.value) ? { command: "setExecutionMode", value: value.value } : undefined;
    case "setWorkMode":
      return isRuntimeOptionValue(value.optionId) && isTokenMode(value.value)
        ? { command: "setWorkMode", optionId: value.optionId, value: value.value }
        : undefined;
    case "setToolApprovalMode":
      return isRuntimeOptionValue(value.optionId) && isToolApprovalMode(value.value)
        ? { command: "setToolApprovalMode", optionId: value.optionId, value: value.value }
        : undefined;
    case "updateSetting":
      return parseUpdateSetting(value);
    case "loadSession":
      return typeof value.sessionId === "string" && value.sessionId.trim() !== "" ? { command: "loadSession", sessionId: value.sessionId } : undefined;
    case "deleteSession":
      return typeof value.sessionId === "string" && value.sessionId.trim() !== "" ? { command: "deleteSession", sessionId: value.sessionId } : undefined;
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
    case "openToolLocation":
      return isValidIndex(value.index) && isValidIndex(value.locationIndex)
        ? { command: "openToolLocation", index: value.index, locationIndex: value.locationIndex }
        : undefined;
    case "approvalDecision":
      return typeof value.id === "string" && typeof value.optionId === "string"
        ? { command: "approvalDecision", id: value.id, optionId: value.optionId }
        : undefined;
    case "resourceSuggestions":
      return isValidIndex(value.requestId) && typeof value.query === "string" && value.query.length <= 240
        ? { command: "resourceSuggestions", requestId: value.requestId, query: value.query }
        : undefined;
    default:
      return undefined;
  }
}

function isRuntimeOptionValue(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 240;
}

function withPromptModes(
  message: Extract<WebviewToHostMessage, { command: "sendPrompt" }>,
  value: Record<string, unknown>,
): Extract<WebviewToHostMessage, { command: "sendPrompt" }> {
  if (isCollaborationMode(value.collaborationMode)) {
    message.collaborationMode = value.collaborationMode;
  }
  if (value.tokenMode === "standard") {
    message.tokenMode = "balanced";
  } else if (isTokenMode(value.tokenMode)) {
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
  return value === "economy" || value === "balanced" || value === "delivery";
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
