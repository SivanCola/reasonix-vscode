import type { ChangePreview, PermissionRequestParams, PlanEntry, SessionUpdate, ToolCallLocation, UsageData } from "./acpTypes";

export type ChatItem =
  | {
      type: "message";
      role: "user" | "assistant" | "thought" | "notice";
      text: string;
    }
  | {
      type: "tool";
      id: string;
      title: string;
      kind: string;
      status: string;
      rawInput?: unknown;
      preview?: ChangePreview;
      content?: string;
      locations?: ToolCallLocation[];
    }
  | {
      type: "usage";
      usage: UsageData;
    }
  | {
      type: "approval";
      id: string;
      title: string;
      kind: string;
      rawInput?: unknown;
      preview?: ChangePreview;
      options: Array<{ optionId: string; name: string; kind: string }>;
      status: "pending" | "selected" | "cancelled";
    }
  | {
      type: "question";
      id: string;
      title: string;
      detail?: string;
      options: Array<{ optionId: string; name: string }>;
      status: "pending" | "selected" | "cancelled";
    }
  | {
      type: "plan";
      entries: PlanEntry[];
    };

export function appendUserMessage(items: ChatItem[], text: string): void {
  items.push({ type: "message", role: "user", text });
}

export function appendNotice(items: ChatItem[], text: string): void {
  items.push({ type: "message", role: "notice", text });
}

export function appendApproval(items: ChatItem[], params: PermissionRequestParams): void {
  if (isQuestionRequest(params)) {
    const detail = params.toolCall.content?.map((part) => contentText(part.content)).filter(Boolean).join("\n");
    items.push({
      type: "question",
      id: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "Question",
      ...(detail ? { detail } : {}),
      options: params.options
        .filter((option) => !option.optionId.endsWith(":cancel") && !option.kind.startsWith("reject"))
        .map((option) => ({ optionId: option.optionId, name: option.name })),
      status: "pending",
    });
    return;
  }
  items.push({
    type: "approval",
    id: params.toolCall.toolCallId,
    title: params.toolCall.title ?? params.toolCall.toolCallId,
    kind: params.toolCall.kind ?? "other",
    rawInput: params.toolCall.rawInput,
    preview: params.toolCall.preview,
    options: params.options,
    status: "pending",
  });
}

export function resolveApproval(items: ChatItem[], id: string, selected: boolean): void {
  const item = items.find((candidate): candidate is Extract<ChatItem, { type: "approval" | "question" }> =>
    (candidate.type === "approval" || candidate.type === "question") && candidate.id === id);
  if (item) {
    item.status = selected ? "selected" : "cancelled";
  }
}

export function applySessionUpdate(items: ChatItem[], update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      appendChunk(items, "user", contentText(update.content));
      return;
    case "agent_message_chunk":
      appendChunk(items, "assistant", contentText(update.content));
      return;
    case "agent_thought_chunk":
      appendChunk(items, "thought", contentText(update.content));
      return;
    case "tool_call": {
      const existing = items.find((item): item is Extract<ChatItem, { type: "tool" }> => item.type === "tool" && item.id === update.toolCallId);
      if (existing) {
        existing.title = update.title ?? existing.title;
        existing.kind = update.kind ?? existing.kind;
        existing.status = update.status ?? existing.status;
        existing.rawInput = update.rawInput ?? existing.rawInput;
        if (update.preview !== undefined) {
          existing.preview = update.preview;
        }
        if (update.locations !== undefined) {
          existing.locations = update.locations;
        }
        return;
      }
      const toolItem: Extract<ChatItem, { type: "tool" }> = {
        type: "tool",
        id: update.toolCallId,
        title: update.title ?? update.toolCallId,
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        rawInput: update.rawInput,
        ...(update.locations ? { locations: update.locations } : {}),
      };
      if (update.preview !== undefined) {
        toolItem.preview = update.preview;
      }
      items.push(toolItem);
      return;
    }
    case "tool_call_update": {
      const text = update.content?.map((part) => contentText(part.content)).join("\n") ?? "";
      const existing = items.find((item): item is Extract<ChatItem, { type: "tool" }> => item.type === "tool" && item.id === update.toolCallId);
      if (existing) {
        existing.status = update.status ?? existing.status;
        existing.content = text;
        return;
      }
      items.push({
        type: "tool",
        id: update.toolCallId,
        title: update.toolCallId,
        kind: "other",
        status: update.status ?? "completed",
        content: text,
      });
      return;
    }
    case "usage": {
      const last = items.at(-1);
      if (last?.type === "usage") {
        last.usage = update.usage;
        return;
      }
      items.push({ type: "usage", usage: update.usage });
      return;
    }
    case "plan": {
      const existing = items.find((item): item is Extract<ChatItem, { type: "plan" }> => item.type === "plan");
      if (existing) {
        existing.entries = update.entries;
      } else {
        items.push({ type: "plan", entries: update.entries });
      }
      return;
    }
    case "available_commands_update":
    case "config_option_update":
    case "current_mode_update":
      return;
    default:
      return;
  }
}

function appendChunk(items: ChatItem[], role: "user" | "assistant" | "thought", text: string): void {
  if (text === "") {
    return;
  }
  const last = items.at(-1);
  if (last?.type === "message" && last.role === role) {
    last.text += text;
    return;
  }
  items.push({ type: "message", role, text });
}

export function isQuestionRequest(params: PermissionRequestParams): boolean {
  return params.toolCall.toolCallId.startsWith("ask-")
    || (isRecord(params.toolCall.rawInput) && typeof params.toolCall.rawInput.question === "string");
}

function contentText(content: import("./acpTypes").ContentBlock): string {
  return content.type === "text" ? content.text : content.resource.text ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
