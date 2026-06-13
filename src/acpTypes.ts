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
  | ToolCallResultUpdate
  | UsageUpdate;

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
  preview?: ChangePreview;
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

export interface UsageUpdate {
  sessionUpdate: "usage";
  usage: UsageData;
}

export interface UsageData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens?: number;
  sessionCacheHitTokens: number;
  sessionCacheMissTokens: number;
  cost?: number;
  currency?: string;
  cacheDiagnostics?: {
    prefixHash: string;
    prefixChanged: boolean;
    prefixChangeReasons?: string[];
    systemHash: string;
    toolsHash: string;
    logRewriteVersion: number;
    toolSchemaTokens: number;
    cacheMissTokens: number;
    cacheHitTokens: number;
  };
}

export interface ChangePreview {
  path: string;
  kind: string;
  oldText?: string;
  newText?: string;
  added: number;
  removed: number;
  diff?: string;
  binary?: boolean;
}

export interface PermissionRequestParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    preview?: ChangePreview;
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

export interface SessionStatusResult {
  label: string;
  running: boolean;
  used: number;
  window: number;
  cacheHit: number;
  cacheMiss: number;
  lastUsage?: UsageData;
  connectedMcp?: string[];
  configuredMcp?: string[];
  disconnectedMcp?: string[];
}

export interface ModelListResult {
  defaultModel?: string;
  currentModel?: string;
  models: ModelInfo[];
}

export interface ModelInfo {
  ref: string;
  provider: string;
  model: string;
  current?: boolean;
  configured: boolean;
  effort?: string;
  effortSupported: boolean;
  effortLevels?: string[];
  defaultEffort?: string;
}

export interface EffortSetResult {
  modelRef: string;
  level: string;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  source?: string;
}

export interface SkillInfo {
  name: string;
  scope: string;
  subagent: boolean;
  description?: string;
}

export interface MCPServerInfo {
  name: string;
  transport?: string;
  tools?: number;
  prompts?: number;
  resources?: number;
  status: string;
  error?: string;
  toolList?: Array<{ name: string; description?: string }>;
}

export interface MCPPromptInfo {
  name: string;
  server: string;
  description?: string;
  args?: string[];
}

export interface MCPResourceInfo {
  uri: string;
  server: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

export interface SlashCompletionInfo {
  label: string;
  insert: string;
  hint?: string;
  descend?: boolean;
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
