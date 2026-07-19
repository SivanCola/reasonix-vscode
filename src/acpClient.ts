import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import { JsonRpcPeer } from "./jsonRpc";
import {
  parseFSReadTextFileParams,
  parseFSWriteTextFileParams,
  parsePermissionRequestParams,
  parseSessionUpdateParams,
  parseTerminalCreateParams,
  parseTerminalIDParams,
  type ProtocolParseResult,
} from "./acpProtocol";
import { redactLocalPaths } from "./sanitize";
import type {
  AgentCapabilities,
  AuthMethod,
  ContentBlock,
  EffortSetResult,
  FSReadTextFileParams,
  FSReadTextFileResult,
  FSWriteTextFileParams,
  InitializeResult,
  ModelListResult,
  PermissionRequestParams,
  PermissionRequestResult,
  SessionConfigOption,
  SessionInfo,
  SessionListResult,
  SessionLoadResult,
  SessionNewResult,
  SessionPromptResult,
  SessionResumeResult,
  SessionStateResult,
  SessionStatusResult,
  SessionUpdateParams,
  SetSessionConfigOptionResult,
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalIDParams,
  TerminalOutputResult,
  TerminalWaitResult,
} from "./acpTypes";

export type AcpOutput = {
  append(value: string): void;
  appendLine(value: string): void;
};

export type AcpFileSystem = {
  readTextFile(params: FSReadTextFileParams): Promise<FSReadTextFileResult>;
  writeTextFile(params: FSWriteTextFileParams): Promise<unknown>;
};

export type AcpTerminal = {
  create(params: TerminalCreateParams): Promise<TerminalCreateResult>;
  output(params: TerminalIDParams): TerminalOutputResult | Promise<TerminalOutputResult>;
  waitForExit(params: TerminalIDParams): Promise<TerminalWaitResult>;
  kill(params: TerminalIDParams): unknown | Promise<unknown>;
  release(params: TerminalIDParams): unknown | Promise<unknown>;
};

export type AcpClientOptions = {
  binaryPath: string;
  model?: string;
  cwd: string;
  previousSessionId?: string;
  resumeSession?: boolean;
  output: AcpOutput;
  trace?: boolean;
  fileSystem?: AcpFileSystem;
  terminal?: AcpTerminal;
  onUpdate: (params: SessionUpdateParams) => void;
  onPermissionRequest: (params: PermissionRequestParams) => Promise<PermissionRequestResult>;
  onDisconnect: (reason: string) => void;
  onSessionId: (sessionId: string) => void;
  onSessionState?: (state: SessionStateResult) => void;
};

export class AcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private peer?: JsonRpcPeer;
  private sessionId?: string;
  private runningPrompt = false;
  private initialized?: InitializeResult;
  private state: SessionStateResult = {};

  constructor(private readonly options: AcpClientOptions) {}

  get connected(): boolean {
    return this.child !== undefined && this.peer !== undefined && !this.peer.isClosed;
  }

  get running(): boolean {
    return this.runningPrompt;
  }

  get id(): string | undefined {
    return this.sessionId;
  }

  get capabilities(): AgentCapabilities | undefined {
    return this.initialized?.agentCapabilities;
  }

  get authMethods(): readonly AuthMethod[] {
    return this.initialized?.authMethods ?? [];
  }

  get sessionState(): Readonly<SessionStateResult> {
    return this.state;
  }

  async start(): Promise<{ sessionId: string; isNewSession: boolean }> {
    if (this.sessionId && this.connected) {
      return { sessionId: this.sessionId, isNewSession: false };
    }
    const args = ["acp"];
    if (this.options.model && this.options.model.trim() !== "") {
      args.push("--model", this.options.model.trim());
    }
    this.appendLine(`Starting ${this.options.binaryPath} ${args.join(" ")}`);
    this.child = spawn(this.options.binaryPath, args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.peer = new JsonRpcPeer(
      this.child.stdin as Writable,
      {
        onNotification: (method, params) => this.handleNotification(method, params),
        onRequest: (method, params) => this.handleRequest(method, params),
        onError: (err) => this.appendLine(`ACP protocol error: ${err.message}`),
      },
      this.options.trace ? (line) => this.appendLine(line) : undefined,
    );

    this.child.stdout.on("data", (chunk: Buffer) => this.peer?.handleData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.append(chunk.toString()));
    this.child.on("error", (err) => {
      this.peer?.close(err);
    });
    this.child.on("close", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      this.peer?.close(new Error(`Reasonix ACP closed: ${reason}`));
      this.peer = undefined;
      this.child = undefined;
      this.runningPrompt = false;
      this.options.onDisconnect(reason);
    });

    this.initialized = await this.peer.sendRequest<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "reasonix-vscode", title: "Reasonix VS Code", version: "0.2.0" },
      clientCapabilities: {
        fs: {
          readTextFile: this.options.fileSystem !== undefined,
          writeTextFile: this.options.fileSystem !== undefined,
        },
        terminal: this.options.terminal !== undefined,
      },
    });

    if (this.options.previousSessionId) {
      const previous = this.options.previousSessionId;
      this.sessionId = previous;
      this.options.onSessionId(previous);
      try {
        const resumed = await this.openExistingSession(previous);
        this.applySessionState(resumed);
        return { sessionId: previous, isNewSession: false };
      } catch (err) {
        this.appendLine(`Could not restore Reasonix session ${previous}: ${errorMessage(err)}`);
        this.sessionId = undefined;
      }
    }

    const created = await this.peer.sendRequest<SessionNewResult>("session/new", {
      cwd: this.options.cwd,
      mcpServers: [],
    });
    if (!created || typeof created.sessionId !== "string" || created.sessionId.trim() === "") {
      throw new Error("Reasonix returned an invalid session/new result");
    }
    this.sessionId = created.sessionId;
    this.applySessionState(created);
    this.options.onSessionId(created.sessionId);
    return { sessionId: created.sessionId, isNewSession: true };
  }

  async sendPrompt(prompt: string | ContentBlock[]): Promise<SessionPromptResult> {
    const peer = this.requirePeer();
    const sessionId = this.requireSession();
    const blocks = typeof prompt === "string" ? [{ type: "text", text: prompt } satisfies ContentBlock] : prompt;
    this.runningPrompt = true;
    try {
      return await peer.sendRequest<SessionPromptResult>("session/prompt", { sessionId, prompt: blocks });
    } finally {
      this.runningPrompt = false;
    }
  }

  cancel(): void {
    if (this.peer && this.sessionId) {
      this.peer.sendNotification("session/cancel", { sessionId: this.sessionId });
    }
  }

  async setMode(modeId: string): Promise<void> {
    await this.requirePeer().sendRequest("session/set_mode", { sessionId: this.requireSession(), modeId });
    if (this.state.modes) {
      this.applySessionState({ modes: { ...this.state.modes, currentModeId: modeId } });
    }
  }

  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    const result = await this.requirePeer().sendRequest<SetSessionConfigOptionResult>("session/set_config_option", {
      sessionId: this.requireSession(),
      configId,
      value,
    });
    const options = result?.configOptions ?? this.state.configOptions?.map((option) => option.id === configId ? { ...option, currentValue: value } : option) ?? [];
    this.applySessionState({ configOptions: options });
    return options;
  }

  async setModel(modelId: string): Promise<void> {
    const option = this.configOption("model");
    if (option) {
      await this.setConfigOption(option.id, modelId);
      return;
    }
    await this.requirePeer().sendRequest("session/set_model", { sessionId: this.requireSession(), modelId });
    if (this.state.models) {
      this.applySessionState({ models: { ...this.state.models, currentModelId: modelId } });
    }
  }

  async setEffort(_modelRef: string, level: string): Promise<EffortSetResult> {
    const option = this.configOption("thought_level") ?? this.state.configOptions?.find((candidate) => candidate.id.toLowerCase().includes("effort"));
    if (option) {
      await this.setConfigOption(option.id, level);
      return { modelRef: this.currentModelId(), level };
    }
    return await this.requirePeer().sendRequest<EffortSetResult>("effort/set", { modelRef: this.currentModelId(), level });
  }

  async listSessions(): Promise<SessionInfo[]> {
    const result = await this.requirePeer().sendRequest<SessionListResult>("session/list", { cwd: this.options.cwd });
    return Array.isArray(result?.sessions) ? result.sessions : [];
  }

  async closeSession(sessionId = this.requireSession()): Promise<void> {
    await this.requirePeer().sendRequest("session/close", { sessionId });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.requirePeer().sendRequest("session/delete", { sessionId });
  }

  // Private main-branch methods remain as guarded fallbacks for older binaries.
  async status(): Promise<SessionStatusResult> {
    return await this.requirePeer().sendRequest<SessionStatusResult>("session/status", { sessionId: this.requireSession() });
  }

  async listModels(): Promise<ModelListResult> {
    return await this.requirePeer().sendRequest<ModelListResult>("model/list", {});
  }

  dispose(): void {
    this.peer?.close(new Error("Reasonix ACP disposed"));
    this.peer = undefined;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
    this.runningPrompt = false;
  }

  private async openExistingSession(sessionId: string): Promise<SessionStateResult> {
    const params = { sessionId, cwd: this.options.cwd, mcpServers: [] };
    if (this.options.resumeSession && this.capabilities?.sessionCapabilities?.resume) {
      try {
        return await this.requirePeer().sendRequest<SessionResumeResult>("session/resume", params);
      } catch (err) {
        this.appendLine(`Could not resume without replay; falling back to session/load: ${errorMessage(err)}`);
      }
    }
    return await this.requirePeer().sendRequest<SessionLoadResult>("session/load", params);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") {
      this.appendLine(`Ignoring unsupported ACP notification: ${method}`);
      return;
    }
    const parsed = parseSessionUpdateParams(params);
    if (!parsed.ok) {
      this.appendLine(`Ignoring invalid ACP session/update: ${parsed.error}`);
      return;
    }
    const update = parsed.value.update;
    if (update.sessionUpdate === "config_option_update") {
      this.applySessionState({ configOptions: update.configOptions });
    } else if (update.sessionUpdate === "current_mode_update" && this.state.modes) {
      this.applySessionState({ modes: { ...this.state.modes, currentModeId: update.currentModeId } });
    }
    this.options.onUpdate(parsed.value);
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission": {
        const parsed = requireParsed(parsePermissionRequestParams(params));
        this.assertRequestSession(parsed.sessionId);
        return await this.options.onPermissionRequest(parsed);
      }
      case "fs/read_text_file": {
        const parsed = requireParsed(parseFSReadTextFileParams(params));
        this.assertRequestSession(parsed.sessionId);
        return await this.requireFileSystem().readTextFile(parsed);
      }
      case "fs/write_text_file": {
        const parsed = requireParsed(parseFSWriteTextFileParams(params));
        this.assertRequestSession(parsed.sessionId);
        return await this.requireFileSystem().writeTextFile(parsed);
      }
      case "terminal/create": {
        const parsed = requireParsed(parseTerminalCreateParams(params));
        this.assertRequestSession(parsed.sessionId);
        return await this.requireTerminal().create(parsed);
      }
      case "terminal/output": {
        const parsed = requireParsed(parseTerminalIDParams(params));
        this.assertRequestSession(parsed.sessionId);
        return await this.requireTerminal().output(parsed);
      }
      case "terminal/wait_for_exit": {
        const parsed = requireParsed(parseTerminalIDParams(params));
        this.assertRequestSession(parsed.sessionId);
        return await this.requireTerminal().waitForExit(parsed);
      }
      case "terminal/kill": {
        const parsed = requireParsed(parseTerminalIDParams(params));
        this.assertRequestSession(parsed.sessionId);
        return await this.requireTerminal().kill(parsed);
      }
      case "terminal/release": {
        const parsed = requireParsed(parseTerminalIDParams(params));
        this.assertRequestSession(parsed.sessionId);
        return await this.requireTerminal().release(parsed);
      }
      default:
        throw new Error(`unsupported ACP request: ${method}`);
    }
  }

  private applySessionState(next: SessionStateResult): void {
    this.state = {
      models: next.models ?? this.state.models,
      modes: next.modes ?? this.state.modes,
      configOptions: next.configOptions ?? this.state.configOptions,
    };
    this.options.onSessionState?.(this.state);
  }

  private configOption(category: string): SessionConfigOption | undefined {
    return this.state.configOptions?.find((option) => option.category === category);
  }

  private currentModelId(): string {
    return this.configOption("model")?.currentValue ?? this.state.models?.currentModelId ?? this.options.model ?? "";
  }

  private assertRequestSession(sessionId: string): void {
    if (this.sessionId && sessionId !== this.sessionId) {
      throw new Error(`ACP request targets unexpected session ${sessionId}`);
    }
  }

  private requireFileSystem(): AcpFileSystem {
    if (!this.options.fileSystem) {
      throw new Error("Reasonix requested filesystem access that the client did not advertise");
    }
    return this.options.fileSystem;
  }

  private requireTerminal(): AcpTerminal {
    if (!this.options.terminal) {
      throw new Error("Reasonix requested a terminal that the client did not advertise");
    }
    return this.options.terminal;
  }

  private requirePeer(): JsonRpcPeer {
    if (!this.peer) {
      throw new Error("Reasonix ACP is not connected");
    }
    return this.peer;
  }

  private requireSession(): string {
    if (!this.sessionId) {
      throw new Error("Reasonix session is not ready");
    }
    return this.sessionId;
  }

  private append(value: string): void {
    this.options.output.append(redactLocalPaths(value, this.options.cwd));
  }

  private appendLine(value: string): void {
    this.options.output.appendLine(redactLocalPaths(value, this.options.cwd));
  }
}

function requireParsed<T>(result: ProtocolParseResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
