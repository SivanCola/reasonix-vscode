import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AcpClient } from "./acpClient";
import type {
  ChangePreview,
  ModelInfo,
  PermissionRequestParams,
  PermissionRequestResult,
  SessionUpdateParams,
  SurfaceListResult,
  UsageData,
} from "./acpTypes";
import { appendApproval, appendNotice, appendUserMessage, applySessionUpdate, resolveApproval as resolveApprovalItem, type ChatItem } from "./chatState";
import { buildEditorContext, buildEditorContextInfo, configuredSelectionMode, type IncludeSelectionMode } from "./editorContext";
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
  sessionId?: string;
  sessionTitle?: string;
  usage?: UsageData;
  surfaces?: SurfaceListResult;
  models?: ModelInfo[];
};

type ChatSnapshot = WorkspaceChatState & {
  workspace: string;
  contextMode: string;
  contextSummary?: string;
  modelLabel: string;
  cacheLabel?: string;
  locale: string;
  sessions: SessionSummary[];
};

type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
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
    vscode.window.onDidChangeTextEditorSelection(() => provider.refreshActiveWorkspace()),
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
    state.sessionId = undefined;
    state.sessionTitle = undefined;
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

    let selectedEffort = picked.model.effort;
    if (picked.model.effortSupported && picked.model.effortLevels && picked.model.effortLevels.length > 0) {
      const effort = await vscode.window.showQuickPick(picked.model.effortLevels, {
        title: `Reasonix effort for ${picked.model.ref}`,
        placeHolder: picked.model.effort ?? picked.model.defaultEffort ?? "auto",
      });
      if (effort) {
        await client.setEffort(picked.model.ref, effort);
        selectedEffort = effort;
      }
    }
    state.models = models.models.map((model) => ({
      ...model,
      current: model.ref === picked.model.ref,
      effort: model.ref === picked.model.ref ? selectedEffort : model.effort,
    }));

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
      case "setContextMode":
        await this.setContextMode(message.mode);
        return;
      case "pickModel":
        await this.pickModel();
        return;
      case "showOutput":
        this.output.show();
        return;
      case "loadSession":
        await this.loadSession(message.sessionId);
        return;
      case "quickPrompt":
        await this.runQuickPrompt(message.action);
        return;
      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        return;
      case "openExternal":
        await this.openExternal(message.href);
        return;
      case "insertMessage":
        await this.insertMessage(message.index);
        return;
      case "retryMessage":
        await this.retryMessage(message.index);
        return;
      case "continueMessage":
        await this.continueMessage(message.index);
        return;
      case "openToolPreview":
        await this.openToolPreview(message.index);
        return;
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

  private async setContextMode(mode: IncludeSelectionMode): Promise<void> {
    await vscode.workspace.getConfiguration("reasonix").update("includeSelectionMode", mode, vscode.ConfigurationTarget.Workspace);
    this.postSnapshot();
  }

  private async loadSession(sessionId: string): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before loading a Reasonix session.");
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching sessions.");
      return;
    }
    if (state.sessionId === sessionId && this.clients.get(workspaceKey(folder))?.connected) {
      return;
    }
    const key = workspaceKey(folder);
    const entry = this.sessionHistory(folder).find((candidate) => candidate.id === sessionId);
    this.clearPendingApprovals(key);
    this.clients.get(key)?.dispose();
    this.clients.delete(key);
    state.items = [];
    state.running = false;
    state.disconnected = true;
    state.status = "Loading session";
    state.sessionId = sessionId;
    state.sessionTitle = entry?.title;
    state.usage = undefined;
    state.surfaces = undefined;
    await this.context.workspaceState.update(this.sessionStorageKey(folder), sessionId);
    this.postSnapshot();
    await this.ensureClient(folder);
  }

  private async runQuickPrompt(action: "explainFile" | "fixSelection" | "runTests" | "searchRepo"): Promise<void> {
    switch (action) {
      case "explainFile":
        await this.sendPrompt("Explain the current file. Focus on purpose, important flows, and risky areas.", true);
        return;
      case "fixSelection":
        await this.sendPrompt("Fix the selected code. Keep the change focused, preserve existing behavior, and explain what changed.", true);
        return;
      case "runTests":
        await this.sendPrompt("Run the relevant tests for this workspace. If failures appear, diagnose and fix them.", false);
        return;
      case "searchRepo":
        await this.sendPrompt("Search the repository for the relevant implementation, summarize what you find, and point to the key files.", false);
        return;
      default:
        assertNever(action);
    }
  }

  private async openExternal(href: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(href);
      if (uri.scheme !== "http" && uri.scheme !== "https" && uri.scheme !== "mailto") {
        return;
      }
      await vscode.env.openExternal(uri);
    } catch {
      // Ignore malformed links sent by the webview.
    }
  }

  private async insertMessage(index: number): Promise<void> {
    const text = this.messageTextAt(index);
    if (!text) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open an editor before inserting a Reasonix message.");
      return;
    }
    await editor.edit((edit) => edit.insert(editor.selection.active, text));
    await vscode.window.showTextDocument(editor.document);
  }

  private async retryMessage(index: number): Promise<void> {
    const prompt = this.retryPromptAt(index);
    if (prompt) {
      await this.sendPrompt(prompt, true);
    }
  }

  private async continueMessage(_index: number): Promise<void> {
    await this.sendPrompt("Continue from your last response.", false);
  }

  private async openToolPreview(index: number): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    const preview = this.previewAt(index);
    if (!preview) {
      void vscode.window.showInformationMessage("No diff preview is available for this item.");
      return;
    }
    await this.preview.previewChange(preview, folder);
  }

  private messageTextAt(index: number): string | undefined {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return undefined;
    }
    const item = this.stateFor(folder).items[index];
    if (item?.type === "message") {
      return item.text;
    }
    if (item?.type === "tool") {
      return item.content ?? (item.rawInput === undefined ? undefined : JSON.stringify(item.rawInput, null, 2));
    }
    if (item?.type === "approval") {
      return item.rawInput === undefined ? undefined : JSON.stringify(item.rawInput, null, 2);
    }
    return undefined;
  }

  private retryPromptAt(index: number): string | undefined {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return undefined;
    }
    const items = this.stateFor(folder).items;
    const direct = items[index];
    if (direct?.type === "message" && direct.role === "user") {
      return direct.text;
    }
    for (let i = Math.min(index, items.length - 1); i >= 0; i -= 1) {
      const item = items[i];
      if (item?.type === "message" && item.role === "user") {
        return item.text;
      }
    }
    return undefined;
  }

  private previewAt(index: number): ChangePreview | undefined {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return undefined;
    }
    const item = this.stateFor(folder).items[index];
    return item?.type === "tool" || item?.type === "approval" ? item.preview : undefined;
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
      appendUserMessage(state.items, trimmed);
      await this.updateCurrentSessionTitle(folder, trimmed);
      state.running = true;
      state.status = "Sending";
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
        state.sessionId = sessionId;
        void this.context.workspaceState.update(this.sessionStorageKey(folder), sessionId);
        void this.rememberSession(folder, sessionId, state.sessionTitle ?? "New session");
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
    switch (params.update.sessionUpdate) {
      case "agent_thought_chunk":
        state.status = "Thinking";
        break;
      case "agent_message_chunk":
        state.status = "Responding";
        break;
      case "tool_call":
        state.status = params.update.title ? `Using ${params.update.title}` : "Using tool";
        break;
      case "tool_call_update":
        state.status = params.update.status === "failed" ? "Tool failed" : "Working";
        break;
      case "usage":
        state.status = "Updating usage";
        break;
      case "user_message_chunk":
        state.status = "Sending";
        break;
      default:
        assertNever(params.update);
    }
    if (params.update.sessionUpdate === "usage") {
      state.usage = params.update.usage;
      this.updateStatusBar(folder);
    }
    this.postSnapshot();
  }

  private async handlePermissionRequest(folder: vscode.WorkspaceFolder, params: PermissionRequestParams): Promise<PermissionRequestResult> {
    const state = this.stateFor(folder);
    appendApproval(state.items, params);
    state.status = "Waiting for approval";
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
    const contextMode = configuredSelectionMode();
    const contextInfo = buildEditorContextInfo(contextMode);
    const snapshot: ChatSnapshot = {
      ...state,
      workspace: folder?.name ?? "No workspace",
      contextMode,
      contextSummary: contextInfo?.summary,
      modelLabel: this.modelLabel(state),
      cacheLabel: state.usage ? cacheBrief(state.usage) : undefined,
      locale: vscode.env.language,
      sessions: folder ? this.sessionHistory(folder) : [],
    };
    this.updateStatusBar(folder);
    void this.view?.webview.postMessage({ type: "stateSnapshot", state: snapshot });
  }

  private modelLabel(state: WorkspaceChatState): string {
    const configured = vscode.workspace.getConfiguration("reasonix").get<string>("model", "").trim();
    const current = state.models?.find((model) => model.ref === configured) ?? state.models?.find((model) => model.current);
    if (configured) {
      return current?.effort ? `${configured} / ${current.effort}` : configured;
    }
    if (current) {
      return current.effort ? `${current.ref} / ${current.effort}` : current.ref;
    }
    return "Default model";
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
          <div id="toolbarMeta" class="toolbar-meta"></div>
        </div>
      </div>
      <div class="toolbar-actions">
        <button id="sessionMenu" class="toolbar-button" title="Recent sessions" aria-label="Recent sessions" type="button">Sessions</button>
        <button id="newSession" class="toolbar-button" title="New session" aria-label="New session" type="button">New</button>
        <button id="modelButton" class="toolbar-button" title="Pick model and effort" aria-label="Pick model and effort" type="button">Model</button>
        <button id="outputButton" class="icon-button" title="Show output" aria-label="Show output" type="button">Logs</button>
      </div>
      <div id="sessionPopover" class="popover session-popover" hidden></div>
    </header>
    <main id="transcript" class="transcript"></main>
    <form id="composer" class="composer">
      <div class="context-row">
        <button id="contextModeButton" class="context-pill" type="button"></button>
        <span id="contextSummary" class="context-summary"></span>
        <button id="insertSelection" class="context-action" title="Insert editor context" aria-label="Insert editor context" type="button">Add</button>
        <div id="contextMenu" class="popover context-menu" hidden></div>
      </div>
      <div class="input-wrap">
        <textarea id="prompt" rows="3" placeholder="Message Reasonix"></textarea>
        <button id="send" class="send-button" type="submit">Send</button>
      </div>
      <div id="surfaceBar" class="surface-bar"></div>
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

  private sessionHistoryKey(folder: vscode.WorkspaceFolder): string {
    return `reasonix.sessionHistory.${workspaceKey(folder)}`;
  }

  private sessionHistory(folder: vscode.WorkspaceFolder): SessionSummary[] {
    const raw = this.context.workspaceState.get<unknown>(this.sessionHistoryKey(folder));
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter(isSessionSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12);
  }

  private async rememberSession(folder: vscode.WorkspaceFolder, sessionId: string, title: string): Promise<void> {
    const normalizedTitle = title.trim() || "New session";
    const now = Date.now();
    const history = this.sessionHistory(folder).filter((entry) => entry.id !== sessionId);
    history.unshift({ id: sessionId, title: normalizedTitle, updatedAt: now });
    await this.context.workspaceState.update(this.sessionHistoryKey(folder), history.slice(0, 12));
  }

  private async updateCurrentSessionTitle(folder: vscode.WorkspaceFolder, prompt: string): Promise<void> {
    const state = this.stateFor(folder);
    const sessionId = state.sessionId ?? this.clients.get(workspaceKey(folder))?.id;
    if (!sessionId) {
      return;
    }
    const title = state.sessionTitle && state.sessionTitle !== "New session" ? state.sessionTitle : titleFromPrompt(prompt);
    state.sessionId = sessionId;
    state.sessionTitle = title;
    await this.rememberSession(folder, sessionId, title);
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

function cacheBrief(usage: UsageData): string | undefined {
  const total = usage.sessionCacheHitTokens + usage.sessionCacheMissTokens;
  if (total <= 0) {
    return undefined;
  }
  return `cache ${Math.round((usage.sessionCacheHitTokens / total) * 100)}%`;
}

function titleFromPrompt(prompt: string): string {
  const compact = prompt
    .replace(/<vscode_context>[\s\S]*?<\/vscode_context>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact === "") {
    return "New session";
  }
  return compact.length > 58 ? `${compact.slice(0, 55)}...` : compact;
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string" && typeof value.title === "string" && typeof value.updatedAt === "number";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
