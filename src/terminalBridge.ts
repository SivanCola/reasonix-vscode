import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type {
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalExitStatus,
  TerminalIDParams,
  TerminalOutputResult,
  TerminalWaitResult,
} from "./acpTypes";

type TerminalRecord = {
  child: ChildProcessWithoutNullStreams;
  terminal: vscode.Terminal;
  pty: ReasonixPseudoterminal;
  chunks: Buffer[];
  bytes: number;
  byteLimit: number;
  truncated: boolean;
  exitStatus?: TerminalExitStatus;
  exited: Promise<TerminalWaitResult>;
  resolveExit: (status: TerminalWaitResult) => void;
};

export class WorkspaceTerminalBridge implements vscode.Disposable {
  private readonly terminals = new Map<string, TerminalRecord>();
  private nextId = 1;

  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly log: (message: string) => void,
  ) {}

  async create(params: TerminalCreateParams): Promise<TerminalCreateResult> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Workspace trust is required for Reasonix terminal commands");
    }
    const cwd = await this.resolveCwd(params.cwd);
    const args = params.args ?? [];
    const child = spawn(params.command, args, {
      cwd,
      env: process.env,
      shell: args.length === 0,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const terminalId = `reasonix-${Date.now().toString(36)}-${this.nextId++}`;
    const pty = new ReasonixPseudoterminal((data) => child.stdin.write(data), () => {
      if (!child.killed) {
        child.kill();
      }
    });
    const terminal = vscode.window.createTerminal({ name: `Reasonix: ${commandLabel(params.command)}`, pty });
    let resolveExit!: (status: TerminalWaitResult) => void;
    const exited = new Promise<TerminalWaitResult>((resolve) => { resolveExit = resolve; });
    const record: TerminalRecord = {
      child,
      terminal,
      pty,
      chunks: [],
      bytes: 0,
      byteLimit: Math.min(Math.max(params.outputByteLimit ?? (1 << 20), 4096), 4 << 20),
      truncated: false,
      exited,
      resolveExit,
    };
    this.terminals.set(terminalId, record);

    const capture = (chunk: Buffer): void => {
      pty.write(chunk.toString("utf8"));
      record.chunks.push(chunk);
      record.bytes += chunk.byteLength;
      trimOutput(record);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (err) => capture(Buffer.from(`\n${err.message}\n`, "utf8")));
    child.on("close", (code, signal) => {
      const status: TerminalWaitResult = signal ? { signal } : { exitCode: code ?? -1 };
      record.exitStatus = status;
      resolveExit(status);
      pty.finish(code ?? 1);
    });
    terminal.show(true);
    this.log(`ACP terminal started: ${commandLabel(params.command)}`);
    return { terminalId };
  }

  output(params: TerminalIDParams): TerminalOutputResult {
    const record = this.requireTerminal(params.terminalId);
    return {
      output: Buffer.concat(record.chunks).toString("utf8"),
      truncated: record.truncated,
      ...(record.exitStatus ? { exitStatus: record.exitStatus } : {}),
    };
  }

  async waitForExit(params: TerminalIDParams): Promise<TerminalWaitResult> {
    return await this.requireTerminal(params.terminalId).exited;
  }

  kill(params: TerminalIDParams): Record<string, never> {
    const record = this.requireTerminal(params.terminalId);
    if (!record.child.killed && record.exitStatus === undefined) {
      record.child.kill();
    }
    return {};
  }

  release(params: TerminalIDParams): Record<string, never> {
    const record = this.requireTerminal(params.terminalId);
    if (!record.child.killed && record.exitStatus === undefined) {
      record.child.kill();
    }
    record.terminal.dispose();
    this.terminals.delete(params.terminalId);
    return {};
  }

  dispose(): void {
    for (const id of [...this.terminals.keys()]) {
      this.release({ sessionId: "", terminalId: id });
    }
  }

  private requireTerminal(id: string): TerminalRecord {
    const record = this.terminals.get(id);
    if (!record) {
      throw new Error(`Unknown Reasonix terminal: ${id}`);
    }
    return record;
  }

  private async resolveCwd(requested?: string): Promise<string> {
    const root = path.resolve(this.folder.uri.fsPath);
    const cwd = path.resolve(root, requested || ".");
    const relative = path.relative(root, cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Reasonix terminal cwd is limited to the active workspace folder");
    }
    const [realRoot, realCwd] = await Promise.all([fs.realpath(root), fs.realpath(cwd)]);
    const realRelative = path.relative(realRoot, realCwd);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error("Reasonix terminal cwd cannot follow a symlink outside the workspace");
    }
    return realCwd;
  }
}

class ReasonixPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(
    private readonly input: (data: string) => void,
    private readonly closeHandler: () => void,
  ) {}

  open(): void {}
  close(): void { this.closeHandler(); }
  handleInput(data: string): void { this.input(data); }
  write(data: string): void { this.writeEmitter.fire(data.replace(/(?<!\r)\n/g, "\r\n")); }
  finish(code: number): void { this.closeEmitter.fire(code); }
}

function trimOutput(record: TerminalRecord): void {
  while (record.bytes > record.byteLimit && record.chunks.length > 0) {
    const first = record.chunks[0];
    if (!first) {
      break;
    }
    const excess = record.bytes - record.byteLimit;
    if (first.byteLength <= excess) {
      record.chunks.shift();
      record.bytes -= first.byteLength;
    } else {
      record.chunks[0] = first.subarray(excess);
      record.bytes -= excess;
    }
    record.truncated = true;
  }
}

function commandLabel(command: string): string {
  const compact = command.trim().replace(/\s+/g, " ");
  return compact.length > 44 ? `${compact.slice(0, 41)}...` : compact;
}
