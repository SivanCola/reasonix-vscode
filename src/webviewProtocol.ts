export type WebviewToHostMessage =
  | { command: "sendPrompt"; text: string }
  | { command: "cancel" }
  | { command: "newSession" }
  | { command: "insertSelection" }
  | { command: "approvalDecision"; id: string; optionId: string }
  | { command: "stateSnapshot" }
  | { command: "pickModel" }
  | { command: "openPreview"; id: string };

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
    case "stateSnapshot":
    case "pickModel":
      return { command: value.command };
    case "approvalDecision":
      return typeof value.id === "string" && typeof value.optionId === "string"
        ? { command: "approvalDecision", id: value.id, optionId: value.optionId }
        : undefined;
    case "openPreview":
      return typeof value.id === "string" ? { command: "openPreview", id: value.id } : undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
