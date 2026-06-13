export type WebviewToHostMessage =
  | { command: "sendPrompt"; text: string }
  | { command: "cancel" }
  | { command: "newSession" }
  | { command: "insertSelection" }
  | { command: "setContextMode"; mode: "off" | "selectionOnly" | "nearby" }
  | { command: "pickModel" }
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

export type HostToWebviewMessage =
  | { type: "stateSnapshot"; state: unknown }
  | { type: "insertText"; text: string }
  | { type: "notice"; text: string };

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!isRecord(value) || typeof value.command !== "string") {
    return undefined;
  }
  switch (value.command) {
    case "sendPrompt":
      return typeof value.text === "string" ? { command: "sendPrompt", text: value.text } : undefined;
    case "cancel":
    case "newSession":
    case "insertSelection":
    case "pickModel":
    case "showOutput":
    case "stateSnapshot":
      return { command: value.command };
    case "setContextMode":
      return value.mode === "off" || value.mode === "selectionOnly" || value.mode === "nearby"
        ? { command: "setContextMode", mode: value.mode }
        : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
