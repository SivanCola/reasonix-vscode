import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import { JsonRpcPeer } from "./jsonRpc";
import { redactLocalPaths } from "./sanitize";
import type {
  InitializeResult,
  EffortSetResult,
  ModelListResult,
  PermissionRequestParams,
  PermissionRequestResult,
  SessionNewResult,
  SessionPromptResult,
  SessionStatusResult,
  SessionUpdateParams,
  SurfaceListResult,
} from "./acpTypes";

export type AcpOutput = {
  append(value: string): void;
  appendLine(value: string): void;
};

export type AcpClientOptions = {
  binaryPath: string;
  model?: string;
  cwd: string;
  previousSessionId?: string;
  output: AcpOutput;
  trace?: boolean;
  onUpdate: (params: SessionUpdateParams) => void;
  onPermissionRequest: (params: PermissionRequestParams) => Promise<PermissionRequestResult>;
  onDisconnect: (reason: string) => void;
  onSessionId: (sessionId: string) => void;
};

export class AcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private peer?: JsonRpcPeer;
  private sessionId?: string;
  private runningPrompt = false;

  constructor(private readonly options: AcpClientOptions) {}

  get connected(): boolean {
    return this.child !== undefined && this.peer !== undefined;
  }

  get running(): boolean {
    return this.runningPrompt;
  }

  get id(): string | undefined {
    return this.sessionId;
  }

  async start(): Promise<string> {
    if (this.sessionId && this.connected) {
      return this.sessionId;
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
        onError: (err) => this.appendLine(`ACP parse error: ${err.message}`),
      },
      this.options.trace ? (line) => this.appendLine(line) : undefined,
    );

    this.child.stdout.on("data", (chunk: Buffer) => this.peer?.handleData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.append(chunk.toString()));
    this.child.on("error", (err) => {
      this.peer?.close(err);
      this.options.onDisconnect(err.message);
    });
    this.child.on("close", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      this.peer?.close(new Error(`Reasonix ACP closed: ${reason}`));
      this.peer = undefined;
      this.child = undefined;
      this.runningPrompt = false;
      this.options.onDisconnect(reason);
    });

    await this.peer.sendRequest<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "reasonix-vscode", title: "Reasonix VS Code" },
    });

    if (this.options.previousSessionId) {
      try {
        await this.peer.sendRequest("session/load", {
          sessionId: this.options.previousSessionId,
          cwd: this.options.cwd,
          mcpServers: [],
        });
        this.sessionId = this.options.previousSessionId;
        this.options.onSessionId(this.sessionId);
        return this.sessionId;
      } catch (err) {
        this.appendLine(`Could not load Reasonix session ${this.options.previousSessionId}: ${errorMessage(err)}`);
      }
    }

    const created = await this.peer.sendRequest<SessionNewResult>("session/new", {
      cwd: this.options.cwd,
      mcpServers: [],
    });
    this.sessionId = created.sessionId;
    this.options.onSessionId(created.sessionId);
    return created.sessionId;
  }

  async sendPrompt(text: string): Promise<SessionPromptResult> {
    const peer = this.requirePeer();
    const sessionId = this.requireSession();
    this.runningPrompt = true;
    try {
      return await peer.sendRequest<SessionPromptResult>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
    } finally {
      this.runningPrompt = false;
    }
  }

  cancel(): void {
    if (!this.peer || !this.sessionId) {
      return;
    }
    this.peer.sendNotification("session/cancel", { sessionId: this.sessionId });
  }

  async status(): Promise<SessionStatusResult> {
    return await this.requirePeer().sendRequest<SessionStatusResult>("session/status", { sessionId: this.requireSession() });
  }

  async listModels(): Promise<ModelListResult> {
    return await this.requirePeer().sendRequest<ModelListResult>("model/list", {});
  }

  async setEffort(modelRef: string, level: string): Promise<EffortSetResult> {
    return await this.requirePeer().sendRequest<EffortSetResult>("effort/set", { modelRef, level });
  }

  async listSurfaces(): Promise<SurfaceListResult> {
    return await this.requirePeer().sendRequest<SurfaceListResult>("surface/list", { sessionId: this.requireSession() });
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

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      this.options.onUpdate(params as SessionUpdateParams);
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      return await this.options.onPermissionRequest(params as PermissionRequestParams);
    }
    throw new Error(`unsupported ACP request: ${method}`);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
