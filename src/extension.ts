import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AcpClient } from "./acpClient";
import type {
  ModelInfo,
  PermissionRequestParams,
  PermissionRequestResult,
  SessionUpdateParams,
  SurfaceListResult,
  UsageData,
} from "./acpTypes";
import { appendApproval, appendNotice, appendUserMessage, applySessionUpdate, resolveApproval as resolveApprovalItem, type ChatItem } from "./chatState";
import { buildEditorContext, buildEditorContextInfo } from "./editorContext";
import { DiffPreviewProvider } from "./preview";
import { redactLocalPaths } from "./sanitize";
import { parseWebviewMessage } from "./webviewProtocol";

const execFileAsync = promisify(execFile);
const viewId = "reasonix.chat";

type WorkspaceChatState = {
  items: ChatItem[];
  running: boolean;
  disconnected: boolean;
  status: string;
  usage?: UsageData;
  surfaces?: SurfaceListResult;
  models?: ModelInfo[];
};

type ChatSnapshot = WorkspaceChatState & {
  workspace: string;
  contextMode: string;
};

type PendingApproval = {
  stateKey: string;
  resolve: (value: PermissionRequestResult) => void;
  options: PermissionRequestParams["options"];
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Reasonix");
  const preview = new DiffPreviewProvider();
  preview.register(context);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "reasonix.openChat";
  const provider = new ReasonixChatProvider(context, output, preview, statusBar);
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerWebviewViewProvider(viewId, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("reasonix.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.reasonix");
      await vscode.commands.executeCommand("reasonix.chat.focus");
    }),
    vscode.commands.registerCommand("reasonix.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("reasonix.sendSelection", () => provider.sendSelection()),
    vscode.commands.registerCommand("reasonix.cancelTurn", () => provider.cancelTurn()),
    vscode.commands.registerCommand("reasonix.pickModel", () => provider.pickModel()),
    vscode.commands.registerCommand("reasonix.showOutput", () => output.show()),
    vscode.window.onDidChangeActiveTextEditor(() => provider.refreshActiveWorkspace()),
  );
  provider.refreshActiveWorkspace();
}

export function deactivate(): void {}

class ReasonixChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly clients = new Map<string, AcpClient>();
  private readonly states = new Map<string, WorkspaceChatState>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly sending = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly preview: DiffPreviewProvider,
    private readonly statusBar: vscode.StatusBarItem,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw) => void this.handleWebviewMessage(raw), undefined, this.context.subscriptions);
    webviewView.onDidDispose(() => { this.view = undefined; }, undefined, this.context.subscriptions);
    this.postSnapshot();

    if (vscode.workspace.getConfiguration("reasonix").get<boolean>("autoStart", false)) {
      void this.ensureClient();
    }
  }

  refreshActiveWorkspace(): void {
    this.postSnapshot();
  }

  async newSession(): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before starting Reasonix.");
      return;
    }
    const key = workspaceKey(folder);
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before starting a new session.");
      return;
    }
    this.clearPendingApprovals(key);
    this.clients.get(key)?.dispose();
    this.clients.delete(key);
    state.items = [];
    state.running = false;
    state.disconnected = true;
    state.status = "New session";
    state.usage = undefined;
    state.surfaces = undefined;
    await this.context.workspaceState.update(this.sessionStorageKey(folder), undefined);
    this.postSnapshot();
    await this.ensureClient(folder);
  }

  async sendSelection(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.reasonix");
    const ctx = buildEditorContext("nearby");
    if (!ctx) {
      void vscode.window.showInformationMessage("No editor context is available.");
      return;
    }
    await this.sendPrompt(`Use the current VS Code editor context.\n\n${ctx}`, false);
  }

  cancelTurn(): void {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return;
    }
    const state = this.stateFor(folder);
    this.clients.get(workspaceKey(folder))?.cancel();
    state.status = "Cancelling";
    this.postSnapshot();
  }

  async pickModel(): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before switching model.");
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching model.");
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      return;
    }
    const models = await client.listModels();
    state.models = models.models;
    const picked = await vscode.window.showQuickPick(
      models.models.map((model) => ({
        label: model.ref,
        description: model.current ? "current" : model.configured ? model.effort ? `effort ${model.effort}` : "" : "missing key",
        detail: model.effortSupported ? `Effort: ${(model.effortLevels ?? []).join(", ")}` : "Effort is not configurable",
        model,
      })),
      { title: "Reasonix model" },
    );
    if (!picked) {
      return;
    }
    const config = vscode.workspace.getConfiguration("reasonix");
    await config.update("model", picked.model.ref, vscode.ConfigurationTarget.Workspace);

    if (picked.model.effortSupported && picked.model.effortLevels && picked.model.effortLevels.length > 0) {
      const effort = await vscode.window.showQuickPick(picked.model.effortLevels, {
        title: `Reasonix effort for ${picked.model.ref}`,
        placeHolder: picked.model.effort ?? picked.model.defaultEffort ?? "auto",
      });
      if (effort) {
        await client.setEffort(picked.model.ref, effort);
      }
    }

    this.clearPendingApprovals(workspaceKey(folder));
    this.clients.get(workspaceKey(folder))?.dispose();
    this.clients.delete(workspaceKey(folder));
    state.items = [];
    state.usage = undefined;
    state.surfaces = undefined;
    state.disconnected = true;
    state.status = `Model: ${picked.model.ref}`;
    await this.context.workspaceState.update(this.sessionStorageKey(folder), undefined);
    this.postSnapshot();
  }

  private async handleWebviewMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.appendOutput(`Ignored invalid webview message: ${JSON.stringify(raw)}`);
      return;
    }
    switch (message.command) {
      case "sendPrompt":
        await this.sendPrompt(message.text, true);
        return;
      case "cancel":
        this.cancelTurn();
        return;
      case "newSession":
        await this.newSession();
        return;
      case "insertSelection": {
        const ctx = buildEditorContext("nearby");
        if (ctx) {
          void this.view?.webview.postMessage({ type: "insertText", text: ctx });
        }
        return;
      }
      case "approvalDecision":
        this.resolveApproval(message.id, message.optionId);
        return;
      case "stateSnapshot":
        this.postSnapshot();
        return;
      default:
        assertNever(message);
    }
  }

  private async sendPrompt(text: string, appendContext: boolean): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before starting Reasonix.");
      return;
    }
    const state = this.stateFor(folder);
    const key = workspaceKey(folder);
    const trimmed = text.trim();
    if (trimmed === "" || state.running || this.sending.has(key)) {
      return;
    }
    this.sending.add(key);
    try {
      const client = await this.ensureClient(folder);
      if (!client) {
        return;
      }

      const prompt = appendContext ? await this.promptWithConfirmedContext(trimmed) : trimmed;
      if (!prompt) {
        return;
      }
      appendUserMessage(state.items, prompt);
      state.running = true;
      state.status = "Running";
      this.postSnapshot();

      try {
        const result = await client.sendPrompt(prompt);
        if (result.stopReason === "cancelled") {
          appendNotice(state.items, "Turn cancelled.");
        } else if (result.stopReason === "error") {
          appendNotice(state.items, "Turn ended with an error. Check the Reasonix output channel.");
        }
      } catch (err) {
        appendNotice(state.items, `Reasonix error: ${errorMessage(err)}`);
        this.appendOutput(`Reasonix prompt failed: ${errorMessage(err)}`, folder);
      } finally {
        state.running = false;
        state.status = state.disconnected ? "Disconnected" : "Idle";
        await this.refreshStatus(client, folder);
        this.postSnapshot();
      }
    } finally {
      this.sending.delete(key);
    }
  }

  private async promptWithConfirmedContext(prompt: string): Promise<string | undefined> {
    const info = buildEditorContextInfo();
    if (!info) {
      return prompt;
    }
    const action = await vscode.window.showInformationMessage(
      `Reasonix will include VS Code context from ${info.summary}.`,
      { modal: true, detail: truncate(info.text, 4000) },
      "Send with Context",
      "Send without Context",
      "Cancel",
    );
    if (action === "Cancel" || action === undefined) {
      return undefined;
    }
    return action === "Send without Context" ? prompt : `${prompt.trimEnd()}\n\n${info.text}`;
  }

  private readonly starting = new Map<string, Promise<AcpClient | undefined>>();

  private ensureClient(folder = this.currentWorkspaceFolder()): Promise<AcpClient | undefined> {
    if (!folder) {
      return Promise.resolve(undefined);
    }
    const key = workspaceKey(folder);
    const existing = this.clients.get(key);
    if (existing?.connected) {
      return Promise.resolve(existing);
    }
    const inFlight = this.starting.get(key);
    if (inFlight) {
      return inFlight;
    }
    const p = this.startClient(folder).finally(() => this.starting.delete(key));
    this.starting.set(key, p);
    return p;
  }

  private async startClient(folder: vscode.WorkspaceFolder): Promise<AcpClient | undefined> {
    const key = workspaceKey(folder);
    const binaryPath = await resolveReasonixBinary();
    if (!binaryPath) {
      return undefined;
    }
    const state = this.stateFor(folder);
    const config = vscode.workspace.getConfiguration("reasonix");
    const model = config.get<string>("model", "");
    const trace = config.get<boolean>("trace", false);
    const previousSessionId = this.context.workspaceState.get<string>(this.sessionStorageKey(folder));

    state.disconnected = false;
    state.status = "Starting";
    this.postSnapshot();
    const client = new AcpClient({
      binaryPath,
      model,
      cwd: folder.uri.fsPath,
      previousSessionId,
      output: this.output,
      trace,
      onUpdate: (params) => this.handleSessionUpdate(folder, params),
      onPermissionRequest: (params) => this.handlePermissionRequest(folder, params),
      onDisconnect: (reason) => {
        this.appendOutput(`Reasonix ACP disconnected: ${reason}`, folder);
        if (this.clients.get(key) !== client) {
          return;
        }
        this.clearPendingApprovals(key);
        this.clients.delete(key);
        state.disconnected = true;
        state.running = false;
        state.status = "Disconnected";
        this.postSnapshot();
      },
      onSessionId: (sessionId) => {
        void this.context.workspaceState.update(this.sessionStorageKey(folder), sessionId);
      },
    });
    this.clients.set(key, client);
    try {
      await client.start();
      state.disconnected = false;
      state.status = "Idle";
      await this.refreshStatus(client, folder);
      await this.refreshSurfaces(client, folder);
      this.postSnapshot();
      return client;
    } catch (err) {
      client.dispose();
      this.clients.delete(key);
      state.disconnected = true;
      state.status = "Start failed";
      appendNotice(state.items, `Could not start Reasonix: ${errorMessage(err)}`);
      this.appendOutput(`Reasonix start failed: ${errorMessage(err)}`, folder);
      this.postSnapshot();
      return undefined;
    }
  }

  private handleSessionUpdate(folder: vscode.WorkspaceFolder, params: SessionUpdateParams): void {
    const state = this.stateFor(folder);
    applySessionUpdate(state.items, params.update);
    if (params.update.sessionUpdate === "usage") {
      state.usage = params.update.usage;
      this.updateStatusBar(folder);
    }
    this.postSnapshot();
  }

  private async handlePermissionRequest(folder: vscode.WorkspaceFolder, params: PermissionRequestParams): Promise<PermissionRequestResult> {
    const state = this.stateFor(folder);
    appendApproval(state.items, params);
    this.postSnapshot();
    try {
      await this.preview.previewPermission(params, folder);
    } catch (err) {
      this.appendOutput(`Reasonix diff preview failed: ${errorMessage(err)}`, folder);
    }

    if (!this.view) {
      const result = await this.modalPermission(params);
      resolveApprovalItem(state.items, params.toolCall.toolCallId, result.outcome.outcome === "selected");
      this.postSnapshot();
      return result;
    }
    return await new Promise<PermissionRequestResult>((resolve) => {
      this.pendingApprovals.set(params.toolCall.toolCallId, { stateKey: workspaceKey(folder), resolve, options: params.options });
    });
  }

  private async modalPermission(params: PermissionRequestParams): Promise<PermissionRequestResult> {
    const choices = [
      { title: "Allow Once", kind: "allow_once" },
      { title: "Allow Session", kind: "allow_always" },
      { title: "Always Allow", kind: "allow_persistent" },
      { title: "Reject", kind: "cancelled" },
    ];
    const picked = await vscode.window.showWarningMessage(
      `Reasonix wants to run ${params.toolCall.title ?? "a tool"}`,
      { modal: true, detail: permissionDetail(params) },
      ...choices.map((choice) => choice.title),
    );
    const choice = choices.find((candidate) => candidate.title === picked);
    if (!choice || choice.kind === "cancelled") {
      return { outcome: { outcome: "cancelled" } };
    }
    const option = params.options.find((candidate) => candidate.kind === choice.kind) ?? params.options.find((candidate) => candidate.optionId === choice.kind);
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private resolveApproval(id: string, optionId: string): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      return;
    }
    this.pendingApprovals.delete(id);
    const state = this.states.get(pending.stateKey);
    let result: PermissionRequestResult;
    if (optionId === "cancelled") {
      result = { outcome: { outcome: "cancelled" } };
    } else {
      const option = pending.options.find((candidate) => candidate.optionId === optionId);
      result = option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    resolveApprovalItem(state?.items ?? [], id, result.outcome.outcome === "selected");
    pending.resolve(result);
    this.postSnapshot();
  }

  private clearPendingApprovals(stateKey: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.stateKey === stateKey) {
        this.pendingApprovals.delete(id);
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
    }
  }

  private async refreshStatus(client: AcpClient, folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const status = await client.status();
      const state = this.stateFor(folder);
      state.usage = status.lastUsage ?? state.usage;
      this.updateStatusBar(folder);
    } catch {
      // Older ACP agents may not expose session/status.
    }
  }

  private async refreshSurfaces(client: AcpClient, folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      this.stateFor(folder).surfaces = await client.listSurfaces();
    } catch {
      // Surface metadata is optional.
    }
  }

  private postSnapshot(): void {
    const folder = this.currentWorkspaceFolder();
    const state = folder ? this.stateFor(folder) : emptyState();
    const snapshot: ChatSnapshot = {
      ...state,
      workspace: folder?.name ?? "No workspace",
      contextMode: vscode.workspace.getConfiguration("reasonix").get<string>("includeSelectionMode", "selectionOnly"),
    };
    this.updateStatusBar(folder);
    void this.view?.webview.postMessage({ type: "stateSnapshot", state: snapshot });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "styles.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Reasonix</title>
</head>
<body>
  <div class="shell">
    <header class="toolbar">
      <div class="status-cluster">
        <span id="statusDot" class="status-dot"></span>
        <div class="status-copy">
          <div id="status" class="status">Idle</div>
          <div id="workspaceName" class="workspace-name"></div>
        </div>
      </div>
      <div class="toolbar-actions">
        <button id="newSession" class="icon-button" title="New session" aria-label="New session" type="button">+</button>
        <button id="insertSelection" class="icon-button" title="Insert editor context" aria-label="Insert editor context" type="button">@</button>
        <button id="cancel" class="icon-button danger" title="Stop turn" aria-label="Stop turn" type="button">Stop</button>
      </div>
    </header>
    <main id="transcript" class="transcript"></main>
    <form id="composer" class="composer">
      <div id="contextHint" class="context-hint"></div>
      <textarea id="prompt" rows="3" placeholder="Message Reasonix"></textarea>
      <div class="composer-footer">
        <div id="surfaceBar" class="surface-bar"></div>
        <button id="send" class="send-button" type="submit">Send</button>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) {
        return folder;
      }
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  private stateFor(folder: vscode.WorkspaceFolder): WorkspaceChatState {
    const key = workspaceKey(folder);
    let state = this.states.get(key);
    if (!state) {
      state = emptyState();
      this.states.set(key, state);
    }
    return state;
  }

  private sessionStorageKey(folder: vscode.WorkspaceFolder): string {
    return `reasonix.session.${workspaceKey(folder)}`;
  }

  private updateStatusBar(folder: vscode.WorkspaceFolder | undefined): void {
    if (!folder) {
      this.statusBar.text = "$(sparkle) Reasonix";
      this.statusBar.tooltip = "Open a workspace folder to use Reasonix.";
      return;
    }
    const state = this.stateFor(folder);
    const usage = state.usage;
    const denom = usage ? usage.sessionCacheHitTokens + usage.sessionCacheMissTokens : 0;
    const hitRate = usage && denom > 0 ? Math.round((usage.sessionCacheHitTokens / denom) * 100) : undefined;
    this.statusBar.text = hitRate === undefined ? `$(sparkle) Reasonix: ${state.status}` : `$(sparkle) Reasonix cache ${hitRate}%`;
    this.statusBar.tooltip = usage
      ? `Reasonix ${folder.name}\n${state.status}\nTokens: ${usage.totalTokens}\nSession cache: ${hitRate ?? 0}%`
      : `Reasonix ${folder.name}\n${state.status}`;
  }

  private appendOutput(value: string, folder?: vscode.WorkspaceFolder): void {
    this.output.appendLine(redactLocalPaths(value, folder?.uri.fsPath));
  }
}

async function resolveReasonixBinary(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration("reasonix").get<string>("binaryPath", "").trim();
  if (configured !== "") {
    return configured;
  }
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(command, ["reasonix"]);
    const resolved = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (resolved) {
      return resolved;
    }
  } catch {
    // Fall through to the user-facing install prompt.
  }
  const action = await vscode.window.showErrorMessage("Reasonix CLI was not found. Install it with `npm i -g reasonix` or set reasonix.binaryPath.", "Open Settings");
  if (action === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "reasonix.binaryPath");
  }
  return undefined;
}

function workspaceKey(folder: vscode.WorkspaceFolder): string {
  return folder.uri.toString();
}

function emptyState(): WorkspaceChatState {
  return { items: [], running: false, disconnected: true, status: "Idle" };
}

function permissionDetail(params: PermissionRequestParams): string {
  const lines = [`Kind: ${params.toolCall.kind ?? "other"}`];
  if (params.toolCall.preview) {
    lines.push(`Target: ${params.toolCall.preview.path}`);
    lines.push(`Change: +${params.toolCall.preview.added} -${params.toolCall.preview.removed}`);
  }
  if (params.toolCall.rawInput !== undefined) {
    lines.push("Input:");
    lines.push(truncate(JSON.stringify(params.toolCall.rawInput, null, 2), 2000));
  }
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...(truncated)`;
}

function getNonce(): string {
  return randomBytes(24).toString("base64url").slice(0, 32);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
