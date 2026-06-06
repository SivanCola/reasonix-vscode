export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ContentBlock {
  type: "text" | "resource";
  text?: string;
  resource?: {
    uri: string;
    mimeType?: string;
    text?: string;
  };
}

export interface InitializeResult {
  protocolVersion: number;
  agentInfo: {
    name: string;
    version?: string;
  };
}

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionPromptResult {
  stopReason: "end_turn" | "cancelled" | "error";
  transcriptPath?: string;
}

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

export type SessionUpdate =
  | MessageChunkUpdate
  | ToolCallUpdate
  | ToolCallResultUpdate;

export interface MessageChunkUpdate {
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
  content: ContentBlock;
  metadata?: {
    error?: {
      name: string;
      message: string;
    };
  };
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title?: string;
  kind?: "read" | "edit" | "search" | "execute" | "other" | string;
  status?: "pending" | "completed" | "failed" | string;
  rawInput?: unknown;
}

export interface ToolCallResultUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: "pending" | "completed" | "failed" | string;
  content?: Array<{
    type: string;
    content: ContentBlock;
  }>;
}

export interface PermissionRequestParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
  };
  options: Array<{
    optionId: string;
    name: string;
    kind:
      | "allow_once"
      | "allow_always"
      | "allow_persistent"
      | "reject_once"
      | "reject_always"
      | string;
  }>;
}

export interface PermissionRequestResult {
  outcome:
    | {
        outcome: "selected";
        optionId: string;
      }
    | {
        outcome: "cancelled";
      };
}
