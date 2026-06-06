import type { SessionUpdate } from "./acpTypes";

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
      content?: string;
    };

export function appendUserMessage(items: ChatItem[], text: string): void {
  items.push({ type: "message", role: "user", text });
}

export function appendNotice(items: ChatItem[], text: string): void {
  items.push({ type: "message", role: "notice", text });
}

export function applySessionUpdate(items: ChatItem[], update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      appendChunk(items, "user", update.content.text ?? "");
      return;
    case "agent_message_chunk":
      appendChunk(items, "assistant", update.content.text ?? "");
      return;
    case "agent_thought_chunk":
      appendChunk(items, "thought", update.content.text ?? "");
      return;
    case "tool_call": {
      const existing = items.find((item): item is Extract<ChatItem, { type: "tool" }> => item.type === "tool" && item.id === update.toolCallId);
      if (existing) {
        existing.title = update.title ?? existing.title;
        existing.kind = update.kind ?? existing.kind;
        existing.status = update.status ?? existing.status;
        existing.rawInput = update.rawInput ?? existing.rawInput;
        return;
      }
      items.push({
        type: "tool",
        id: update.toolCallId,
        title: update.title ?? update.toolCallId,
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        rawInput: update.rawInput,
      });
      return;
    }
    case "tool_call_update": {
      const text = update.content?.map((part) => part.content.text ?? "").join("\n") ?? "";
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
    default:
      assertNever(update);
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

function assertNever(value: never): never {
  throw new Error(`Unhandled session update: ${JSON.stringify(value)}`);
}
