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

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
      };
    };

export interface Implementation {
  name: string;
  title?: string;
  version?: string;
}

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: {
    list?: Record<string, never>;
    resume?: Record<string, never>;
    close?: Record<string, never>;
    delete?: Record<string, never>;
  };
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  type?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface InitializeResult {
  protocolVersion: number;
  agentInfo: Implementation;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
}

export interface SessionModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface SessionModelState {
  availableModels: SessionModelInfo[];
  currentModelId: string;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface SessionConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: SessionConfigSelectOption[];
}

export interface SessionStateResult {
  models?: SessionModelState;
  modes?: SessionModeState;
  configOptions?: SessionConfigOption[];
}

export interface SessionNewResult extends SessionStateResult {
  sessionId: string;
}

export type SessionLoadResult = SessionStateResult;
export type SessionResumeResult = SessionStateResult;

export interface SetSessionConfigOptionResult {
  configOptions: SessionConfigOption[];
}

export interface SessionPromptResult {
  stopReason: "end_turn" | "cancelled" | "error";
  transcriptPath?: string;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  _meta?: Record<string, unknown>;
}

export interface SessionListResult {
  sessions: SessionInfo[];
  nextCursor?: string;
}

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

export type SessionUpdate =
  | MessageChunkUpdate
  | ToolCallUpdate
  | ToolCallResultUpdate
  | AvailableCommandsUpdate
  | ConfigOptionUpdate
  | PlanUpdate
  | CurrentModeUpdate
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

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title?: string;
  kind?: "read" | "edit" | "search" | "execute" | "other" | string;
  status?: "pending" | "completed" | "failed" | string;
  rawInput?: unknown;
  preview?: ChangePreview;
  locations?: ToolCallLocation[];
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

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: AvailableCommand[];
}

export interface ConfigOptionUpdate {
  sessionUpdate: "config_option_update";
  configOptions: SessionConfigOption[];
}

export interface PlanEntry {
  content: string;
  priority: string;
  status: string;
}

export interface PlanUpdate {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
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
    content?: Array<{ type: string; content: ContentBlock }>;
    rawInput?: unknown;
    preview?: ChangePreview;
  };
  options: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
  }>;
}

export interface PermissionRequestResult {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

export interface FSReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface FSReadTextFileResult {
  content: string;
}

export interface FSWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  outputByteLimit?: number;
}

export interface TerminalCreateResult {
  terminalId: string;
}

export interface TerminalIDParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalExitStatus {
  exitCode?: number;
  signal?: string;
}

export interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus;
}

export type TerminalWaitResult = TerminalExitStatus;

// Legacy private-protocol types are kept only for compatibility fallbacks.
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

export interface ModelListResult {
  defaultModel?: string;
  currentModel?: string;
  models: ModelInfo[];
}

export interface EffortSetResult {
  modelRef: string;
  level: string;
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
