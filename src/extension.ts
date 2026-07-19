import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AcpClient } from "./acpClient";
import type {
  AgentCapabilities,
  AuthMethod,
  AvailableCommand,
  ChangePreview,
  ContentBlock,
  ModelListResult,
  ModelInfo,
  PermissionRequestParams,
  PermissionRequestResult,
  SessionConfigOption,
  SessionModeState,
  SessionModelState,
  SessionStateResult,
  SessionUpdateParams,
  UsageData,
} from "./acpTypes";
import { appendApproval, appendNotice, appendUserMessage, applySessionUpdate, isQuestionRequest, resolveApproval as resolveApprovalItem, type ChatItem } from "./chatState";
import { attachmentToBlock, isImageMime, mimeFromFileName, MAX_ATTACHMENTS, type PendingAttachment } from "./attachments";
import { buildEditorContextBlock, configuredSelectionMode, type IncludeSelectionMode } from "./editorContext";
import { WorkspaceFileBridge } from "./fileBridge";
import { DiffPreviewProvider } from "./preview";
import { buildPromptBlocks } from "./resourceMentions";
import { suggestWorkspaceResources } from "./resourceSuggestions";
import { redactLocalPaths } from "./sanitize";
import { expandSlashCommand } from "./slashCommands";
import { WorkspaceTerminalBridge } from "./terminalBridge";
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
  models?: ModelInfo[];
  sessionModels?: SessionModelState;
  modes?: SessionModeState;
  configOptions?: SessionConfigOption[];
  availableCommands?: AvailableCommand[];
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  sessions?: SessionSummary[];
  mcp?: McpSnapshot;
  executionMode?: CollaborationMode;
  workMode?: TokenMode;
  toolApprovalMode?: ToolApprovalMode;
};

type ChatSnapshot = WorkspaceChatState & {
  workspace: string;
  contextMode: string;
  modelLabel: string;
  effortLabel: string;
  effortSupported: boolean;
  modelOptions: RuntimeSelectOption[];
  effortOptions: RuntimeSelectOption[];
  effortOptionId?: string;
  executionMode: CollaborationMode;
  executionOptions: RuntimeSelectOption[];
  workMode: TokenMode;
  workModeOptions: RuntimeSelectOption[];
  workModeOptionId?: string;
  toolApprovalMode: ToolApprovalMode;
  toolApprovalOptions: RuntimeSelectOption[];
  toolApprovalOptionId?: string;
  cacheLabel?: string;
  locale: string;
  uiLanguage: UiLanguage;
  settings: ReasonixSettings;
  sessions: SessionSummary[];
};

type RuntimeSelectOption = {
  value: string;
  label: string;
  description?: string;
  selected: boolean;
};

type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

type UiLanguage = "auto" | "en" | "zh-CN";
type SettingKey = "binaryPath" | "model" | "uiLanguage" | "autoStart" | "trace" | "includeSelectionMode";
type CollaborationMode = "normal" | "plan" | "goal";
type TokenMode = "economy" | "balanced" | "delivery";
type ToolApprovalMode = "ask" | "auto" | "yolo";

type McpSnapshot = {
  connected: string[];
  configured: string[];
  disconnected: string[];
};

type ReasonixSettings = {
  binaryPath: string;
  model: string;
  uiLanguage: UiLanguage;
  autoStart: boolean;
  trace: boolean;
  includeSelectionMode: IncludeSelectionMode;
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
    provider,
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
    vscode.commands.registerCommand("reasonix.pickEffort", () => provider.pickEffort()),
    vscode.commands.registerCommand("reasonix.pickUiLanguage", () => provider.pickUiLanguage()),
    vscode.commands.registerCommand("reasonix.selectBinary", () => selectReasonixBinary()),
    vscode.commands.registerCommand("reasonix.openSettings", () => provider.openSettings()),
    vscode.commands.registerCommand("reasonix.showOutput", () => output.show()),
    vscode.window.onDidChangeActiveTextEditor(() => provider.refreshActiveWorkspace()),
    vscode.window.onDidChangeTextEditorSelection(() => provider.refreshActiveWorkspace()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("reasonix.uiLanguage") ||
        event.affectsConfiguration("reasonix.includeSelectionMode") ||
        event.affectsConfiguration("reasonix.model") ||
        event.affectsConfiguration("reasonix.binaryPath") ||
        event.affectsConfiguration("reasonix.autoStart") ||
        event.affectsConfiguration("reasonix.trace")
      ) {
        provider.refreshActiveWorkspace();
      }
    }),
  );
  if (process.env.REASONIX_TEST_COMMANDS === "1") {
    context.subscriptions.push(
      vscode.commands.registerCommand("reasonix.test.sendPrompt", async (text: unknown, toolApprovalMode: unknown) => {
        await provider.testSendPrompt(
          typeof text === "string" ? text : "",
          toolApprovalMode === "auto" || toolApprovalMode === "yolo" ? toolApprovalMode : "ask",
        );
      }),
      vscode.commands.registerCommand("reasonix.test.webviewMessage", async (message: unknown) => {
        await provider.testWebviewMessage(message);
      }),
      vscode.commands.registerCommand("reasonix.test.snapshot", () => provider.testSnapshot()),
    );
  }
  provider.refreshActiveWorkspace();
}

export function deactivate(): void {}

class ReasonixChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly clients = new Map<string, AcpClient>();
  private readonly terminals = new Map<string, WorkspaceTerminalBridge>();
  private readonly states = new Map<string, WorkspaceChatState>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly sending = new Set<string>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly preview: DiffPreviewProvider,
    private readonly statusBar: vscode.StatusBarItem,
  ) {}

  dispose(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw) => void this.handleWebviewMessage(raw), undefined, this.context.subscriptions);
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    }, undefined, this.context.subscriptions);
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
    this.clearReconnectTimer(key);
    this.reconnectAttempts.delete(key);
    const current = this.clients.get(key);
    if (current?.connected) {
      try {
        await current.closeSession();
      } catch (err) {
        this.appendOutput(`Reasonix session close failed: ${errorMessage(err)}`, folder);
      }
    }
    current?.dispose();
    this.clients.delete(key);
    this.disposeTerminalBridge(key);
    state.items = [];
    state.running = false;
    state.disconnected = true;
    state.status = "New session";
    state.sessionId = undefined;
    state.sessionTitle = undefined;
    state.usage = undefined;
    state.sessionModels = undefined;
    state.modes = undefined;
    state.configOptions = undefined;
    state.executionMode = undefined;
    state.workMode = undefined;
    state.toolApprovalMode = undefined;
    state.availableCommands = undefined;
    await this.context.workspaceState.update(this.sessionStorageKey(folder), undefined);
    this.postSnapshot();
    await this.ensureClient(folder);
  }

  async sendSelection(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.reasonix");
    const ctx = buildEditorContextBlock("nearby");
    if (!ctx) {
      void vscode.window.showInformationMessage("No editor context is available.");
      return;
    }
    await this.sendPrompt("Use the current VS Code editor context.", true);
  }

  cancelTurn(): void {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return;
    }
    const key = workspaceKey(folder);
    const state = this.stateFor(folder);
    this.clients.get(key)?.cancel();
    this.clearPendingApprovals(key);
    state.status = "Cancelling";
    this.postSnapshot();
  }

  async pickModel(): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before switching model.");
      this.postSnapshot();
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching model.");
      this.postSnapshot();
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      return;
    }
    const modelOption = configOptionByCategory(state.configOptions, "model");
    const nativeModels = modelOption?.options ?? state.sessionModels?.availableModels.map((model) => ({
      value: model.modelId,
      name: model.name,
      description: model.description,
    })) ?? [];
    if (nativeModels.length > 0) {
      const currentValue = modelOption?.currentValue ?? state.sessionModels?.currentModelId;
      const picked = await vscode.window.showQuickPick(nativeModels.map((model) => ({
        label: model.name,
        description: model.value === currentValue ? "current" : model.value,
        detail: model.description,
        value: model.value,
      })), { title: "Reasonix model" });
      if (!picked || picked.value === currentValue) {
        return;
      }
      await this.setModel(picked.value);
      return;
    }

    let models: ModelListResult;
    try {
      models = await client.listModels();
    } catch (err) {
      state.status = "Model list unavailable";
      this.appendOutput(`Reasonix model list unavailable: ${errorMessage(err)}`, folder);
      this.postSnapshot();
      void vscode.window.showInformationMessage("This Reasonix backend did not advertise a model selector.", "Open Settings").then((action) => {
        if (action === "Open Settings") {
          void vscode.commands.executeCommand("workbench.action.openSettings", "reasonix.model");
        }
      });
      return;
    }
    state.models = models.models;
    const legacy = await vscode.window.showQuickPick(models.models.map((model) => ({ label: model.ref, model })), { title: "Reasonix model" });
    if (legacy) {
      await vscode.workspace.getConfiguration("reasonix").update("model", legacy.model.ref, vscode.ConfigurationTarget.Workspace);
      state.status = `Model: ${legacy.model.ref} (next session)`;
      this.postSnapshot();
    }
  }

  async pickEffort(): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before switching effort.");
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching effort.");
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      return;
    }
    const effortOption = configOptionByCategory(state.configOptions, "thought_level")
      ?? state.configOptions?.find((option) => option.id.toLowerCase().includes("effort"));
    if (effortOption && effortOption.options.length > 0) {
      const picked = await vscode.window.showQuickPick(effortOption.options.map((option) => ({
        label: option.name,
        description: option.value === effortOption.currentValue ? "current" : option.value,
        detail: option.description,
        value: option.value,
      })), { title: "Reasonix reasoning effort" });
      if (!picked || picked.value === effortOption.currentValue) {
        return;
      }
      await this.setEffort(effortOption.id, picked.value);
      return;
    }

    void vscode.window.showInformationMessage("The current Reasonix session did not advertise configurable reasoning effort.");
  }

  private async setModel(value: string): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before switching model.");
      this.postSnapshot();
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching model.");
      this.postSnapshot();
      return;
    }
    const option = this.modelOptions(state).find((candidate) => candidate.value === value);
    if (!option) {
      this.appendOutput(`Ignored unavailable model selection: ${JSON.stringify(value)}`, folder);
      this.postSnapshot();
      return;
    }
    if (option.selected) {
      this.postSnapshot();
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      this.postSnapshot();
      return;
    }
    try {
      await client.setModel(value);
      this.syncSessionState(state, client.sessionState);
      state.status = `Model: ${option.label}`;
      await vscode.workspace.getConfiguration("reasonix").update("model", value, vscode.ConfigurationTarget.Workspace);
    } catch (err) {
      this.appendOutput(`Reasonix model update failed: ${errorMessage(err)}`, folder);
      void vscode.window.showErrorMessage(`Reasonix could not switch models: ${errorMessage(err)}`);
    } finally {
      this.postSnapshot();
    }
  }

  private async setEffort(optionId: string, value: string): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before switching effort.");
      this.postSnapshot();
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching effort.");
      this.postSnapshot();
      return;
    }
    const effortOption = this.effortOption(state);
    const selection = effortOption?.id === optionId
      ? effortOption.options.find((candidate) => candidate.value === value)
      : undefined;
    if (!effortOption || !selection) {
      this.appendOutput(`Ignored unavailable effort selection: ${JSON.stringify({ optionId, value })}`, folder);
      this.postSnapshot();
      return;
    }
    if (effortOption.currentValue === value) {
      this.postSnapshot();
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      this.postSnapshot();
      return;
    }
    try {
      await client.setConfigOption(effortOption.id, value);
      this.syncSessionState(state, client.sessionState);
      state.status = `Effort: ${selection.name}`;
    } catch (err) {
      this.appendOutput(`Reasonix effort update failed: ${errorMessage(err)}`, folder);
      void vscode.window.showWarningMessage(`Reasonix could not update reasoning effort: ${errorMessage(err)}`);
    } finally {
      this.postSnapshot();
    }
  }

  private async setExecutionMode(value: CollaborationMode): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      this.postSnapshot();
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching execution method.");
      this.postSnapshot();
      return;
    }
    if (this.executionMode(state) === value) {
      this.postSnapshot();
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      this.postSnapshot();
      return;
    }
    const modeId = this.sessionModeId(state, value);
    try {
      if (modeId) {
        await client.setMode(modeId);
        this.syncSessionState(state, client.sessionState);
      }
      state.executionMode = value;
      state.status = `Execution: ${value}`;
    } catch (err) {
      this.appendOutput(`Reasonix execution method update failed: ${errorMessage(err)}`, folder);
      void vscode.window.showWarningMessage(`Reasonix could not switch execution method: ${errorMessage(err)}`);
    } finally {
      this.postSnapshot();
    }
  }

  private async setWorkMode(optionId: string, value: TokenMode): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      this.postSnapshot();
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching work mode.");
      this.postSnapshot();
      return;
    }
    const option = this.workModeOption(state);
    if (!option) {
      if (optionId === "legacy_work_mode" && value !== "delivery") {
        state.workMode = value;
      }
      this.postSnapshot();
      return;
    }
    const nativeValue = value === "balanced"
      && !option.options.some((candidate) => candidate.value === "balanced")
      && option.options.some((candidate) => candidate.value === "full")
      ? "full"
      : value;
    if (option.id !== optionId || !option.options.some((candidate) => candidate.value === nativeValue)) {
      this.appendOutput(`Ignored unavailable work mode selection: ${JSON.stringify({ optionId, value })}`, folder);
      this.postSnapshot();
      return;
    }
    if (option.currentValue === nativeValue) {
      this.postSnapshot();
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      this.postSnapshot();
      return;
    }
    try {
      await client.setConfigOption(option.id, nativeValue);
      this.syncSessionState(state, client.sessionState);
      state.workMode = value;
      state.status = `Work mode: ${value}`;
    } catch (err) {
      this.appendOutput(`Reasonix work mode update failed: ${errorMessage(err)}`, folder);
      void vscode.window.showWarningMessage(`Reasonix could not switch work mode: ${errorMessage(err)}`);
    } finally {
      this.postSnapshot();
    }
  }

  private async setToolApprovalMode(optionId: string, value: ToolApprovalMode): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      this.postSnapshot();
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching tool approvals.");
      this.postSnapshot();
      return;
    }
    const option = this.toolApprovalOption(state);
    if (!option) {
      if (optionId === "legacy_tool_approval") {
        state.toolApprovalMode = value;
      }
      this.postSnapshot();
      return;
    }
    if (option.id !== optionId || !option.options.some((candidate) => candidate.value === value)) {
      this.appendOutput(`Ignored unavailable tool approval selection: ${JSON.stringify({ optionId, value })}`, folder);
      this.postSnapshot();
      return;
    }
    if (option.currentValue === value) {
      this.postSnapshot();
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      this.postSnapshot();
      return;
    }
    try {
      await client.setConfigOption(option.id, value);
      this.syncSessionState(state, client.sessionState);
      state.toolApprovalMode = value;
      state.status = `Tool approvals: ${value}`;
    } catch (err) {
      this.appendOutput(`Reasonix tool approval update failed: ${errorMessage(err)}`, folder);
      void vscode.window.showWarningMessage(`Reasonix could not switch tool approvals: ${errorMessage(err)}`);
    } finally {
      this.postSnapshot();
    }
  }

  async pickUiLanguage(): Promise<void> {
    const current = configuredUiLanguage();
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Auto", description: "Follow VS Code", value: "auto" satisfies UiLanguage },
        { label: "English", description: "Reasonix UI", value: "en" satisfies UiLanguage },
        { label: "简体中文", description: "Reasonix 界面", value: "zh-CN" satisfies UiLanguage },
      ],
      {
        title: "Reasonix UI Language",
        placeHolder: current,
      },
    );
    if (!picked) {
      return;
    }
    await vscode.workspace.getConfiguration("reasonix").update("uiLanguage", picked.value, vscode.ConfigurationTarget.Global);
    this.postSnapshot();
  }

  async openSettings(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.reasonix");
    await vscode.commands.executeCommand("reasonix.chat.focus");
    this.postSnapshot();
    void this.view?.webview.postMessage({ type: "openSettings" });
  }

  async testSendPrompt(text: string, toolApprovalMode: ToolApprovalMode): Promise<void> {
    const expanded = expandSlashCommand(text);
    await this.sendPrompt(expanded.prompt, false, toolApprovalMode, "normal", "balanced", text);
  }

  async testWebviewMessage(message: unknown): Promise<void> {
    await this.handleWebviewMessage(message);
  }

  testSnapshot(): WorkspaceChatState | undefined {
    const folder = this.currentWorkspaceFolder();
    return folder ? structuredClone(this.stateFor(folder)) : undefined;
  }

  private async handleWebviewMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.appendOutput(`Ignored invalid webview message: ${JSON.stringify(raw)}`);
      return;
    }
    switch (message.command) {
      case "sendPrompt":
        const activeFolder = this.currentWorkspaceFolder();
        const nativeCommand = activeFolder
          ? matchesAvailableCommand(message.text, this.stateFor(activeFolder).availableCommands)
          : false;
        const expanded = nativeCommand ? { prompt: message.text } : expandSlashCommand(message.text);
        await this.sendPrompt(
          expanded.prompt,
          true,
          message.toolApprovalMode,
          message.collaborationMode,
          message.tokenMode,
          message.text,
          message.attachments,
        );
        return;
      case "cancel":
        this.cancelTurn();
        return;
      case "connect":
        await this.ensureClient();
        return;
      case "newSession":
        await this.newSession();
        return;
      case "pickAttachment":
        await this.pickAttachments();
        return;
      case "setContextMode":
        await this.setContextMode(message.mode);
        return;
      case "pickModel":
        await this.pickModel();
        return;
      case "pickEffort":
        await this.pickEffort();
        return;
      case "setModel":
        await this.setModel(message.value);
        return;
      case "setEffort":
        await this.setEffort(message.optionId, message.value);
        return;
      case "setExecutionMode":
        await this.setExecutionMode(message.value);
        return;
      case "setWorkMode":
        await this.setWorkMode(message.optionId, message.value);
        return;
      case "setToolApprovalMode":
        await this.setToolApprovalMode(message.optionId, message.value);
        return;
      case "pickUiLanguage":
        await this.pickUiLanguage();
        return;
      case "selectBinary":
        await selectReasonixBinary();
        this.postSnapshot();
        return;
      case "openNativeSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "reasonix");
        return;
      case "updateSetting":
        await this.updateSetting(message.key, message.value);
        return;
      case "showOutput":
        this.output.show();
        return;
      case "loadSession":
        await this.loadSession(message.sessionId);
        return;
      case "deleteSession":
        await this.deleteSession(message.sessionId);
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
      case "openToolLocation":
        await this.openToolLocation(message.index, message.locationIndex);
        return;
      case "approvalDecision":
        this.resolveApproval(message.id, message.optionId);
        return;
      case "resourceSuggestions":
        await this.postResourceSuggestions(message.requestId, message.query);
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

  private async updateSetting(key: SettingKey, value: string | boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("reasonix");
    switch (key) {
      case "binaryPath":
        if (typeof value === "string") {
          await config.update("binaryPath", value.trim(), vscode.ConfigurationTarget.Global);
        }
        break;
      case "model":
        if (typeof value === "string") {
          await config.update("model", value.trim(), vscode.ConfigurationTarget.Workspace);
        }
        break;
      case "uiLanguage":
        if (value === "auto" || value === "en" || value === "zh-CN") {
          await config.update("uiLanguage", value, vscode.ConfigurationTarget.Global);
        }
        break;
      case "autoStart":
        if (typeof value === "boolean") {
          await config.update("autoStart", value, vscode.ConfigurationTarget.Workspace);
        }
        break;
      case "trace":
        if (typeof value === "boolean") {
          await config.update("trace", value, vscode.ConfigurationTarget.Workspace);
        }
        break;
      case "includeSelectionMode":
        if (value === "off" || value === "selectionOnly" || value === "nearby") {
          await config.update("includeSelectionMode", value, vscode.ConfigurationTarget.Workspace);
        }
        break;
      default:
        assertNever(key);
    }
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
    this.disposeTerminalBridge(key);
    state.items = [];
    state.running = false;
    state.disconnected = true;
    state.status = "Loading session";
    state.sessionId = sessionId;
    state.sessionTitle = entry?.title;
    state.usage = undefined;
    state.sessionModels = undefined;
    state.modes = undefined;
    state.configOptions = undefined;
    state.executionMode = undefined;
    state.workMode = undefined;
    state.toolApprovalMode = undefined;
    state.availableCommands = undefined;
    await this.context.workspaceState.update(this.sessionStorageKey(folder), sessionId);
    this.postSnapshot();
    await this.ensureClient(folder);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return;
    }
    const state = this.stateFor(folder);
    if (state.running) {
      void vscode.window.showWarningMessage("Cancel the current Reasonix turn before deleting a session.");
      return;
    }
    const entry = (state.sessions ?? this.sessionHistory(folder)).find((session) => session.id === sessionId);
    const action = await vscode.window.showWarningMessage(
      `Delete Reasonix session "${entry?.title ?? sessionId}"?`,
      { modal: true },
      "Delete",
    );
    if (action !== "Delete") {
      return;
    }
    const client = await this.ensureClient(folder);
    if (!client) {
      return;
    }
    try {
      if (state.sessionId === sessionId) {
        await client.closeSession(sessionId);
      }
      await client.deleteSession(sessionId);
      state.sessions = (state.sessions ?? []).filter((session) => session.id !== sessionId);
      const history = this.sessionHistory(folder).filter((session) => session.id !== sessionId);
      await this.context.workspaceState.update(this.sessionHistoryKey(folder), history);
      if (state.sessionId === sessionId) {
        client.dispose();
        this.clients.delete(workspaceKey(folder));
        await this.context.workspaceState.update(this.sessionStorageKey(folder), undefined);
        state.items = [];
        state.sessionId = undefined;
        state.sessionTitle = undefined;
        state.status = "Session deleted";
      }
      this.postSnapshot();
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not delete Reasonix session: ${errorMessage(err)}`);
    }
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

  private async postResourceSuggestions(requestId: number, query: string): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    const items = folder ? await suggestWorkspaceResources(query, folder.uri.fsPath) : [];
    void this.view?.webview.postMessage({ type: "resourceSuggestions", requestId, query, items });
  }

  private async pickAttachments(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach",
      title: "Attach files or images",
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const folder = this.currentWorkspaceFolder();
    const state = folder ? this.stateFor(folder) : undefined;
    const supportsImage = state?.agentCapabilities?.promptCapabilities?.image === true;
    const attachments: PendingAttachment[] = [];
    let skippedImage = false;
    for (const uri of picked.slice(0, MAX_ATTACHMENTS)) {
      const name = path.basename(uri.fsPath);
      const mimeType = mimeFromFileName(name);
      const kind = isImageMime(mimeType) ? "image" : "file";
      if (kind === "image" && !supportsImage) {
        skippedImage = true;
        continue;
      }
      attachments.push({ kind, name, uri: uri.toString(), mimeType });
    }
    if (skippedImage) {
      void this.view?.webview.postMessage({ type: "notice", text: "The connected Reasonix does not support image prompts; image files were skipped." });
    }
    if (attachments.length > 0) {
      void this.view?.webview.postMessage({ type: "attachmentsPicked", attachments });
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

  private async openToolLocation(index: number, locationIndex: number): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      return;
    }
    const item = this.stateFor(folder).items[index];
    const location = item?.type === "tool" ? item.locations?.[locationIndex] : undefined;
    if (!location) {
      return;
    }
    const root = path.resolve(folder.uri.fsPath);
    const target = path.resolve(root, location.path);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      void vscode.window.showWarningMessage("Reasonix tool locations outside the workspace cannot be opened.");
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const editor = await vscode.window.showTextDocument(document);
      if (location.line !== undefined) {
        const line = Math.max(0, Math.min(document.lineCount - 1, location.line - 1));
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not open Reasonix tool location: ${errorMessage(err)}`);
    }
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

  private async sendPrompt(
    text: string,
    appendContext: boolean,
    toolApprovalMode?: ToolApprovalMode,
    collaborationMode?: CollaborationMode,
    workMode?: TokenMode,
    displayText = text,
    attachments: PendingAttachment[] = [],
  ): Promise<void> {
    const folder = this.currentWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage("Open a workspace folder before starting Reasonix.");
      return;
    }
    const state = this.stateFor(folder);
    const key = workspaceKey(folder);
    const trimmed = text.trim();
    if ((trimmed === "" && attachments.length === 0) || state.running || this.sending.has(key)) {
      return;
    }
    this.sending.add(key);
    try {
      const client = await this.ensureClient(folder);
      if (!client) {
        return;
      }

      const desiredExecution = collaborationMode ?? this.executionMode(state);
      const desiredWorkMode = workMode ?? this.workMode(state);
      const desiredApproval = toolApprovalMode ?? this.toolApprovalMode(state);
      await this.applyComposerAxes(client, state, desiredExecution, desiredWorkMode, desiredApproval, folder);
      const providerPrompt = promptWithLegacyComposerModes(
        trimmed,
        desiredExecution,
        desiredWorkMode,
        this.sessionModeId(state, "goal") !== undefined,
        this.workModeOption(state) !== undefined,
      );
      const withMentions = await buildPromptBlocks(providerPrompt, folder.uri.fsPath);
      let blocks: ContentBlock[] | undefined = withMentions.blocks;
      if (attachments.length > 0) {
        try {
          const readFile = async (uri: string) => vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
          const attachmentBlocks: ContentBlock[] = [];
          for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
            attachmentBlocks.push(await attachmentToBlock(attachment, readFile));
          }
          blocks = [...blocks, ...attachmentBlocks];
        } catch (err) {
          appendNotice(state.items, `Attachment failed: ${errorMessage(err)}`);
          this.appendOutput(`Attachment read failed: ${errorMessage(err)}`, folder);
          this.postSnapshot();
          return;
        }
      }
      blocks = appendContext ? await this.withConfirmedEditorContext(blocks) : blocks;
      if (!blocks) {
        return;
      }
      if (withMentions.mentions.length > 0) {
        this.appendOutput(`Attached ${withMentions.mentions.length} @ resource mention(s): ${withMentions.mentions.map((mention) => mention.relativePath).join(", ")}`, folder);
      }
      const visiblePrompt = displayText.trim() || trimmed || attachments.map((attachment) => attachment.name).join(", ");
      appendUserMessage(state.items, visiblePrompt);
      await this.updateCurrentSessionTitle(folder, visiblePrompt);
      state.running = true;
      state.status = "Sending";
      this.postSnapshot();

      try {
        const result = await client.sendPrompt(blocks);
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
        if (!client.capabilities) {
          await this.refreshStatus(client, folder);
        }
        await this.refreshSessions(client, folder);
        if (!state.disconnected) {
          this.reconnectAttempts.delete(key);
        }
        this.postSnapshot();
      }
    } finally {
      this.sending.delete(key);
    }
  }

  private async withConfirmedEditorContext(blocks: ContentBlock[]): Promise<ContentBlock[] | undefined> {
    const info = buildEditorContextBlock();
    if (!info) {
      return blocks;
    }
    const action = await vscode.window.showInformationMessage(
      `Reasonix will include VS Code context from ${info.summary}.`,
      { modal: true, detail: truncate(info.block.type === "resource" ? info.block.resource.text ?? "" : "", 4000) },
      "Send with Context",
      "Send without Context",
      "Cancel",
    );
    if (action === "Cancel" || action === undefined) {
      return undefined;
    }
    return action === "Send without Context" ? blocks : [...blocks, info.block];
  }

  private async applyDefaultToolApproval(client: AcpClient, state: WorkspaceChatState, folder: vscode.WorkspaceFolder): Promise<void> {
    const option = this.toolApprovalOption(state);
    if (!option || option.currentValue === "auto" || !option.options.some((candidate) => candidate.value === "auto")) {
      return;
    }
    try {
      await client.setConfigOption(option.id, "auto");
      this.syncSessionState(state, client.sessionState);
      this.appendOutput(`New session defaults tool approval to auto (${option.id}).`, folder);
    } catch (err) {
      this.appendOutput(`Could not set default tool approval: ${errorMessage(err)}`, folder);
    }
  }

  private async applyComposerAxes(
    client: AcpClient,
    state: WorkspaceChatState,
    collaborationMode: CollaborationMode,
    workMode: TokenMode,
    toolApprovalMode: ToolApprovalMode,
    folder: vscode.WorkspaceFolder,
  ): Promise<void> {
    try {
      const modeId = this.sessionModeId(state, collaborationMode);
      if (modeId && state.modes?.currentModeId !== modeId) {
        await client.setMode(modeId);
        this.syncSessionState(state, client.sessionState);
      }
      state.executionMode = collaborationMode;

      const workOption = this.workModeOption(state);
      if (workOption) {
        const nativeWorkMode = workMode === "balanced"
          && !workOption.options.some((candidate) => candidate.value === "balanced")
          && workOption.options.some((candidate) => candidate.value === "full")
          ? "full"
          : workMode;
        if (workOption.currentValue !== nativeWorkMode && workOption.options.some((candidate) => candidate.value === nativeWorkMode)) {
          await client.setConfigOption(workOption.id, nativeWorkMode);
          this.syncSessionState(state, client.sessionState);
        }
      } else {
        state.workMode = workMode === "delivery" ? "balanced" : workMode;
      }

      const approvalOption = this.toolApprovalOption(state);
      if (approvalOption) {
        if (approvalOption.currentValue !== toolApprovalMode && approvalOption.options.some((candidate) => candidate.value === toolApprovalMode)) {
          await client.setConfigOption(approvalOption.id, toolApprovalMode);
          this.syncSessionState(state, client.sessionState);
        }
      } else {
        state.toolApprovalMode = toolApprovalMode;
        const legacyModeId = collaborationMode === "plan" ? "plan" : toolApprovalMode === "yolo" ? "auto" : "default";
        if (state.modes?.availableModes.some((mode) => mode.id === legacyModeId) && state.modes.currentModeId !== legacyModeId) {
          await client.setMode(legacyModeId);
          this.syncSessionState(state, client.sessionState);
          state.executionMode = collaborationMode;
        }
      }
    } catch (err) {
      this.appendOutput(`Reasonix composer mode update failed: ${errorMessage(err)}`, folder);
      throw new Error(`Could not apply Reasonix composer mode: ${errorMessage(err)}`);
    }
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
    const bridgeLog = (message: string): void => this.appendOutput(message, folder);
    const fileSystem = vscode.workspace.isTrusted ? new WorkspaceFileBridge(folder, bridgeLog) : undefined;
    const terminal = vscode.workspace.isTrusted ? new WorkspaceTerminalBridge(folder, bridgeLog) : undefined;
    if (terminal) {
      this.disposeTerminalBridge(key);
      this.terminals.set(key, terminal);
    }

    state.disconnected = false;
    state.status = "Starting";
    this.postSnapshot();
    const client = new AcpClient({
      binaryPath,
      model,
      cwd: folder.uri.fsPath,
      previousSessionId,
      resumeSession: state.items.length > 0,
      output: this.output,
      trace,
      fileSystem,
      terminal,
      onUpdate: (params) => this.handleSessionUpdate(folder, params),
      onPermissionRequest: (params) => this.handlePermissionRequest(folder, params),
      onDisconnect: (reason) => {
        this.appendOutput(`Reasonix ACP disconnected: ${reason}`, folder);
        if (this.clients.get(key) !== client) {
          return;
        }
        this.clearPendingApprovals(key);
        this.clients.delete(key);
        this.disposeTerminalBridge(key);
        state.disconnected = true;
        state.running = false;
        state.status = "Disconnected";
        this.postSnapshot();
        this.scheduleReconnect(folder);
      },
      onSessionId: (sessionId) => {
        state.sessionId = sessionId;
        void this.context.workspaceState.update(this.sessionStorageKey(folder), sessionId);
        void this.rememberSession(folder, sessionId, state.sessionTitle ?? "New session");
      },
      onSessionState: (sessionState) => {
        this.syncSessionState(state, sessionState);
        this.postSnapshot();
      },
    });
    this.clients.set(key, client);
    try {
      const started = await client.start();
      state.disconnected = false;
      state.status = "Idle";
      state.agentCapabilities = client.capabilities;
      state.authMethods = [...client.authMethods];
      this.clearReconnectTimer(key);
      if (started.isNewSession) {
        await this.applyDefaultToolApproval(client, state, folder);
      }
      await this.refreshSessions(client, folder);
      if (!client.capabilities) {
        await this.refreshStatus(client, folder);
      }
      this.postSnapshot();
      return client;
    } catch (err) {
      client.dispose();
      this.clients.delete(key);
      this.disposeTerminalBridge(key);
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
    if (state.sessionId && params.sessionId !== state.sessionId) {
      this.appendOutput(`Ignored update for inactive session ${params.sessionId}`, folder);
      return;
    }
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
      case "available_commands_update":
        state.availableCommands = params.update.availableCommands;
        break;
      case "config_option_update":
        state.configOptions = params.update.configOptions;
        state.workMode = this.workMode(state);
        state.toolApprovalMode = this.toolApprovalMode(state);
        break;
      case "plan":
        state.status = "Planning";
        break;
      case "current_mode_update":
        if (state.modes) {
          state.modes = { ...state.modes, currentModeId: params.update.currentModeId };
        }
        state.executionMode = params.update.currentModeId === "plan" || params.update.currentModeId === "goal"
          ? params.update.currentModeId
          : "normal";
        state.status = `Mode: ${params.update.currentModeId}`;
        break;
      default:
        break;
    }
    if (params.update.sessionUpdate === "usage") {
      state.usage = params.update.usage;
      this.updateStatusBar(folder);
    }
    this.postSnapshot();
  }

  private async handlePermissionRequest(folder: vscode.WorkspaceFolder, params: PermissionRequestParams): Promise<PermissionRequestResult> {
    const state = this.stateFor(folder);
    const approvalMode = this.toolApprovalMode(state);
    const autoResult = this.toolApprovalOption(state) ? undefined : this.autoPermissionResult(params, approvalMode);
    if (autoResult) {
      appendNotice(state.items, `${permissionModeNotice(approvalMode)}: ${params.toolCall.title ?? "tool"}`);
      this.postSnapshot();
      return autoResult;
    }
    appendApproval(state.items, params);
    state.status = isQuestionRequest(params) ? "Waiting for answer" : "Waiting for approval";
    this.postSnapshot();
    if (!isQuestionRequest(params)) {
      try {
        await this.preview.previewPermission(params, folder);
      } catch (err) {
        this.appendOutput(`Reasonix diff preview failed: ${errorMessage(err)}`, folder);
      }
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

  private autoPermissionResult(params: PermissionRequestParams, mode: ToolApprovalMode): PermissionRequestResult | undefined {
    if (mode === "ask" || isQuestionRequest(params)) {
      return undefined;
    }
    const preferredKind = mode === "auto" ? "allow_always" : "allow_once";
    const fallbackKind = mode === "auto" ? "allow_once" : "allow_always";
    const option = params.options.find((candidate) => candidate.kind === preferredKind)
      ?? params.options.find((candidate) => candidate.kind === fallbackKind);
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
  }

  private async modalPermission(params: PermissionRequestParams): Promise<PermissionRequestResult> {
    if (isQuestionRequest(params)) {
      const picked = await vscode.window.showQuickPick(
        params.options
          .filter((option) => !option.kind.startsWith("reject") && !option.optionId.endsWith(":cancel"))
          .map((option) => ({ label: option.name, optionId: option.optionId })),
        { title: params.toolCall.title ?? "Reasonix question", placeHolder: "Choose an answer" },
      );
      return picked ? { outcome: { outcome: "selected", optionId: picked.optionId } } : { outcome: { outcome: "cancelled" } };
    }
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
        resolveApprovalItem(this.states.get(stateKey)?.items ?? [], id, false);
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
    }
  }

  private syncSessionState(state: WorkspaceChatState, sessionState: Readonly<SessionStateResult>): void {
    state.sessionModels = sessionState.models ?? state.sessionModels;
    state.modes = sessionState.modes ?? state.modes;
    state.configOptions = sessionState.configOptions ?? state.configOptions;
    state.executionMode = this.executionMode(state);
    state.workMode = this.workMode(state);
    state.toolApprovalMode = this.toolApprovalMode(state);
  }

  private async refreshSessions(client: AcpClient, folder: vscode.WorkspaceFolder): Promise<void> {
    if (!client.capabilities?.sessionCapabilities?.list) {
      return;
    }
    try {
      const sessions = await client.listSessions();
      this.stateFor(folder).sessions = sessions.map((session) => ({
        id: session.sessionId,
        title: session.title?.trim() || "Untitled session",
        updatedAt: session.updatedAt ? Date.parse(session.updatedAt) || 0 : 0,
      })).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      this.appendOutput(`Reasonix session list failed: ${errorMessage(err)}`, folder);
    }
  }

  private scheduleReconnect(folder: vscode.WorkspaceFolder): void {
    const key = workspaceKey(folder);
    const state = this.stateFor(folder);
    if (!state.sessionId || this.reconnectTimers.has(key)) {
      return;
    }
    const attempt = (this.reconnectAttempts.get(key) ?? 0) + 1;
    if (attempt > 3) {
      state.status = "Reconnect failed";
      appendNotice(state.items, "Reasonix disconnected repeatedly. Send another prompt to retry, or check the output channel.");
      this.postSnapshot();
      return;
    }
    this.reconnectAttempts.set(key, attempt);
    const delay = 1000 * (2 ** (attempt - 1));
    state.status = `Reconnecting (${attempt}/3)`;
    this.postSnapshot();
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(key);
      if (!this.clients.has(key)) {
        void this.ensureClient(folder);
      }
    }, delay);
    this.reconnectTimers.set(key, timer);
  }

  private clearReconnectTimer(key: string): void {
    const timer = this.reconnectTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(key);
    }
  }

  private disposeTerminalBridge(key: string): void {
    this.terminals.get(key)?.dispose();
    this.terminals.delete(key);
  }

  private async refreshStatus(client: AcpClient, folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const status = await client.status();
      const state = this.stateFor(folder);
      state.usage = status.lastUsage ?? state.usage;
      state.mcp = {
        connected: status.connectedMcp ?? [],
        configured: status.configuredMcp ?? [],
        disconnected: status.disconnectedMcp ?? [],
      };
      this.updateStatusBar(folder);
    } catch {
      // Older ACP agents may not expose session/status.
    }
  }

  private postSnapshot(): void {
    const folder = this.currentWorkspaceFolder();
    const state = folder ? this.stateFor(folder) : emptyState();
    const contextMode = configuredSelectionMode();
    const snapshot: ChatSnapshot = {
      ...state,
      workspace: folder?.name ?? "No workspace",
      contextMode,
      modelLabel: this.modelLabel(state),
      effortLabel: this.effortLabel(state),
      effortSupported: this.effortSupported(state),
      modelOptions: this.modelOptions(state),
      effortOptions: this.effortOptions(state),
      effortOptionId: this.effortOption(state)?.id,
      executionMode: this.executionMode(state),
      executionOptions: this.executionOptions(state),
      workMode: this.workMode(state),
      workModeOptions: this.workModeOptions(state),
      workModeOptionId: this.workModeOption(state)?.id ?? "legacy_work_mode",
      toolApprovalMode: this.toolApprovalMode(state),
      toolApprovalOptions: this.toolApprovalOptions(state),
      toolApprovalOptionId: this.toolApprovalOption(state)?.id ?? "legacy_tool_approval",
      cacheLabel: state.usage ? cacheBrief(state.usage) : undefined,
      locale: effectiveUiLocale(),
      uiLanguage: configuredUiLanguage(),
      settings: currentSettings(),
      sessions: folder ? (state.sessions ?? this.sessionHistory(folder)) : [],
    };
    this.updateStatusBar(folder);
    void this.view?.webview.postMessage({ type: "stateSnapshot", state: snapshot });
  }

  private modelLabel(state: WorkspaceChatState): string {
    const modelOption = configOptionByCategory(state.configOptions, "model");
    if (modelOption) {
      return modelOption.options.find((option) => option.value === modelOption.currentValue)?.name ?? modelOption.currentValue;
    }
    if (state.sessionModels) {
      return state.sessionModels.availableModels.find((model) => model.modelId === state.sessionModels?.currentModelId)?.name
        ?? state.sessionModels.currentModelId;
    }
    const configured = vscode.workspace.getConfiguration("reasonix").get<string>("model", "").trim();
    const current = this.currentModel(state);
    if (configured) {
      return configured;
    }
    if (current) {
      return current.ref;
    }
    return "Default model";
  }

  private modelOptions(state: WorkspaceChatState): RuntimeSelectOption[] {
    const modelOption = configOptionByCategory(state.configOptions, "model");
    if (modelOption) {
      return modelOption.options.map((option) => ({
        value: option.value,
        label: option.name,
        description: option.description,
        selected: option.value === modelOption.currentValue,
      }));
    }
    if (state.sessionModels) {
      return state.sessionModels.availableModels.map((model) => ({
        value: model.modelId,
        label: model.name,
        description: model.description,
        selected: model.modelId === state.sessionModels?.currentModelId,
      }));
    }
    return [];
  }

  private effortOption(state: WorkspaceChatState): SessionConfigOption | undefined {
    return configOptionByCategory(state.configOptions, "thought_level")
      ?? state.configOptions?.find((candidate) => candidate.id.toLowerCase().includes("effort"));
  }

  private effortOptions(state: WorkspaceChatState): RuntimeSelectOption[] {
    const option = this.effortOption(state);
    return option?.options.map((value) => ({
      value: value.value,
      label: value.name,
      description: value.description,
      selected: value.value === option.currentValue,
    })) ?? [];
  }

  private executionMode(state: WorkspaceChatState): CollaborationMode {
    const current = state.modes?.currentModeId;
    if (current === "normal" || current === "plan" || current === "goal") {
      return current;
    }
    if (current === "default" || current === "auto") {
      return state.executionMode ?? "normal";
    }
    return state.executionMode ?? "normal";
  }

  private executionOptions(state: WorkspaceChatState): RuntimeSelectOption[] {
    const current = this.executionMode(state);
    const advertised = state.modes?.availableModes ?? [];
    const fallback = [
      { id: "normal", name: "Normal", description: "Work directly and pause when user input is required" },
      { id: "plan", name: "Plan", description: "Research and propose a plan before making changes" },
      { id: "goal", name: "Goal", description: "Keep advancing the next prompt as a goal until complete or blocked" },
    ];
    return fallback.map((mode) => {
      const native = advertised.find((candidate) => candidate.id === mode.id)
        ?? (mode.id === "normal" ? advertised.find((candidate) => candidate.id === "default") : undefined);
      return {
        value: mode.id,
        label: native?.name ?? mode.name,
        description: native?.description ?? mode.description,
        selected: mode.id === current,
      };
    });
  }

  private sessionModeId(state: WorkspaceChatState, mode: CollaborationMode): string | undefined {
    const ids = new Set(state.modes?.availableModes.map((candidate) => candidate.id) ?? []);
    if (ids.has(mode)) {
      return mode;
    }
    if (mode === "normal" && ids.has("default")) {
      return "default";
    }
    return mode === "plan" && ids.has("plan") ? "plan" : undefined;
  }

  private workModeOption(state: WorkspaceChatState): SessionConfigOption | undefined {
    return configOptionByCategory(state.configOptions, "work_mode")
      ?? configOptionByIds(state.configOptions, ["work_mode", "profile", "runtime_profile", "token_mode"]);
  }

  private workMode(state: WorkspaceChatState): TokenMode {
    const value = this.workModeOption(state)?.currentValue;
    if (value === "economy" || value === "balanced" || value === "delivery") {
      return value;
    }
    if (value === "full") {
      return "balanced";
    }
    return state.workMode ?? "balanced";
  }

  private workModeOptions(state: WorkspaceChatState): RuntimeSelectOption[] {
    const option = this.workModeOption(state);
    const current = this.workMode(state);
    if (option) {
      return option.options.flatMap((candidate): RuntimeSelectOption[] => {
        const value = candidate.value === "full" ? "balanced" : candidate.value;
        if (value !== "economy" && value !== "balanced" && value !== "delivery") {
          return [];
        }
        return [{
          value,
          label: candidate.name,
          description: candidate.description,
          selected: value === current,
        }];
      });
    }
    return [
      { value: "economy", label: "Economy", selected: current === "economy" },
      { value: "balanced", label: "Balanced", selected: current === "balanced" },
    ];
  }

  private toolApprovalOption(state: WorkspaceChatState): SessionConfigOption | undefined {
    return configOptionByCategory(state.configOptions, "tool_approval")
      ?? configOptionByIds(state.configOptions, ["tool_approval", "approval", "approval_mode", "tool_approval_mode"]);
  }

  private toolApprovalMode(state: WorkspaceChatState): ToolApprovalMode {
    const value = this.toolApprovalOption(state)?.currentValue;
    if (value === "ask" || value === "auto" || value === "yolo") {
      return value;
    }
    if (state.modes?.currentModeId === "auto") {
      return "yolo";
    }
    return state.toolApprovalMode ?? "ask";
  }

  private toolApprovalOptions(state: WorkspaceChatState): RuntimeSelectOption[] {
    const option = this.toolApprovalOption(state);
    const current = this.toolApprovalMode(state);
    const advertised = option?.options ?? [
      { value: "ask", name: "Ask" },
      { value: "auto", name: "Auto" },
      { value: "yolo", name: "Yolo" },
    ];
    return advertised.flatMap((candidate): RuntimeSelectOption[] => {
      if (candidate.value !== "ask" && candidate.value !== "auto" && candidate.value !== "yolo") {
        return [];
      }
      return [{
        value: candidate.value,
        label: candidate.name,
        description: candidate.description,
        selected: candidate.value === current,
      }];
    });
  }

  private effortLabel(state: WorkspaceChatState): string {
    const option = this.effortOption(state);
    if (option) {
      return option.options.find((value) => value.value === option.currentValue)?.name ?? option.currentValue;
    }
    return this.currentModel(state)?.effort ?? "auto";
  }

  private effortSupported(state: WorkspaceChatState): boolean {
    const option = this.effortOption(state);
    if (option) {
      return option.options.length > 0;
    }
    const current = this.currentModel(state);
    return Boolean(current?.effortSupported && (current.effortLevels?.length ?? 0) > 0);
  }

  private currentModel(state: WorkspaceChatState): ModelInfo | undefined {
    return this.currentModelFromList(state.models);
  }

  private currentModelFromList(models: ModelInfo[] | undefined): ModelInfo | undefined {
    const configured = vscode.workspace.getConfiguration("reasonix").get<string>("model", "").trim();
    return models?.find((model) => model.ref === configured) ?? models?.find((model) => model.current);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "styles.css"));
    const markUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "mark.svg"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Reasonix</title>
</head>
<body data-reasonix-mark-src="${markUri}">
  <div class="shell">
    <aside class="session-rail" aria-labelledby="sessionRailTitle">
      <div class="session-rail__brand">
        <img src="${markUri}" alt="" aria-hidden="true">
        <span>Reasonix</span>
      </div>
      <button id="railNewSession" class="rail-new-session" type="button">
        <span aria-hidden="true">+</span>
        <span id="railNewSessionLabel">New</span>
      </button>
      <div class="session-rail__heading" id="sessionRailTitle">Sessions</div>
      <div id="sessionRailList" class="session-rail__list"></div>
      <div class="session-rail__footer">
        <div class="rail-runtime">
          <span id="railStatusDot" class="status-dot"></span>
          <span id="railStatus">Idle</span>
        </div>
        <div id="railModel" class="rail-model">Model</div>
      </div>
    </aside>
    <section class="workbench">
      <header class="topbar">
      <div class="brand-stack">
        <div class="brand-title">REASONIX</div>
        <div class="brand-meta">
          <span id="statusDot" class="status-dot"></span>
          <span id="status" class="status">Idle</span>
          <span id="workspaceName" class="workspace-name"></span>
          <span id="toolbarMeta" class="toolbar-meta"></span>
        </div>
      </div>
      <div id="chatToolbarActions" class="top-actions">
        <button id="newSession" class="icon-button" title="New session" aria-label="New session" type="button">+</button>
        <button id="sessionMenu" class="icon-button" title="Recent sessions" aria-label="Recent sessions" type="button">Sessions</button>
        <button id="settingsButton" class="icon-button" title="Open settings" aria-label="Open settings" type="button">Settings</button>
      </div>
      <div id="settingsToolbarActions" class="top-actions settings-toolbar-actions" hidden>
        <span id="settingsModeTitle" class="settings-mode-title">Settings</span>
        <button id="settingsBackButton" class="primary-button" title="Done" aria-label="Done" type="button">Done</button>
      </div>
      <div id="sessionPopover" class="popover session-popover" hidden></div>
      </header>
      <main class="content">
        <div id="transcript" class="transcript"></div>
        <div id="settingsView" class="settings-view" hidden></div>
      </main>
      <form id="composer" class="composer">
      <div id="connectionNotice" class="connection-notice" role="status" aria-live="polite" hidden>
        <span class="connection-notice__indicator" aria-hidden="true"></span>
        <span id="connectionNoticeText" class="connection-notice__text">Reasonix is not connected</span>
        <div class="connection-notice__actions">
          <button id="connectionConnect" class="connection-notice__action connection-notice__action--primary" type="button">Connect</button>
          <button id="connectionSettings" class="connection-notice__action" type="button" hidden>Settings</button>
        </div>
      </div>
      <div id="attachmentTray" class="attachment-tray" aria-live="polite" hidden></div>
      <div class="input-wrap">
        <textarea id="prompt" rows="2" placeholder="Type your task here..."></textarea>
        <div id="composerHint" class="composer-hint">Type @ for context, / for slash command...</div>
        <div id="suggestionMenu" class="suggestion-menu" role="listbox" hidden></div>
        <button id="send" class="send-button" type="submit" aria-label="Send">↑</button>
      </div>
      <div class="composer-footer">
        <div class="context-control">
          <button id="contextButton" class="composer-control context-button" title="Add context" aria-label="Add context" aria-haspopup="menu" aria-expanded="false" aria-controls="contextMenu" type="button">+</button>
          <div id="contextMenu" class="popover context-menu" role="menu" hidden></div>
        </div>
        <div class="collaboration-control">
          <button id="collaborationButton" class="composer-select collaboration-button" title="Collaboration modes" aria-label="Collaboration modes" aria-haspopup="menu" aria-expanded="false" aria-controls="collaborationMenu" type="button">
            <span id="collaborationModeLabel" class="composer-select__label">Normal</span>
            <span class="composer-select__chevron" aria-hidden="true">⌄</span>
          </button>
          <div id="modeChipTray" class="mode-chip-tray" aria-live="polite" hidden></div>
          <div id="collaborationMenu" class="popover collaboration-menu" role="menu" hidden></div>
        </div>
        <div class="work-mode-control">
          <button id="workModeButton" class="composer-select work-mode-button" title="Work mode" aria-label="Work mode" aria-haspopup="menu" aria-expanded="false" aria-controls="workModeMenu" type="button">
            <span id="workModeLabel" class="composer-select__label">Balanced</span>
            <span class="composer-select__chevron" aria-hidden="true">⌄</span>
          </button>
          <div id="workModeMenu" class="popover collaboration-menu work-mode-menu" role="menu" hidden></div>
        </div>
        <div class="controls-control">
          <button id="approvalSummaryButton" class="composer-select approval-summary" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="controlsMenu">
            <span id="approvalSummaryLabel" class="composer-select__label">Ask</span>
            <span class="composer-select__chevron" aria-hidden="true">⌄</span>
          </button>
          <div id="controlsMenu" class="popover controls-menu" hidden>
            <div class="controls-section">
              <div id="controlsApprovalLabel" class="controls-label">Tool approvals</div>
              <div id="approvalModebar" class="approval-menu" data-mode="ask" role="menu" aria-label="Tool approval mode">
                <button id="approvalAsk" class="approval-menu__item" type="button" role="menuitemradio" data-tool-approval-mode="ask">
                  <span class="approval-menu__check" aria-hidden="true">✓</span>
                  <span class="approval-menu__copy">
                    <span class="approval-menu__label" data-approval-mode-label></span>
                    <span class="approval-menu__detail" data-approval-mode-detail></span>
                  </span>
                </button>
                <button id="approvalAuto" class="approval-menu__item" type="button" role="menuitemradio" data-tool-approval-mode="auto">
                  <span class="approval-menu__check" aria-hidden="true">✓</span>
                  <span class="approval-menu__copy">
                    <span class="approval-menu__label" data-approval-mode-label></span>
                    <span class="approval-menu__detail" data-approval-mode-detail></span>
                  </span>
                </button>
                <button id="approvalYolo" class="approval-menu__item" type="button" role="menuitemradio" data-tool-approval-mode="yolo">
                  <span class="approval-menu__check" aria-hidden="true">✓</span>
                  <span class="approval-menu__copy">
                    <span class="approval-menu__label" data-approval-mode-label></span>
                    <span class="approval-menu__detail" data-approval-mode-detail></span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="runtime-control">
          <div class="runtime-option-control">
            <button id="runtimeModelButton" class="composer-select runtime-select runtime-model-button" title="Model" aria-label="Model" aria-haspopup="menu" aria-expanded="false" aria-controls="runtimeModelMenu" type="button">
              <span id="runtimeModelLabel" class="composer-select__label">Model</span>
              <span class="composer-select__chevron" aria-hidden="true">⌄</span>
            </button>
            <div id="runtimeModelMenu" class="popover runtime-option-menu" hidden></div>
          </div>
          <div class="runtime-option-control">
            <button id="runtimeEffortButton" class="composer-select runtime-select runtime-effort-button" title="Reasoning effort" aria-label="Reasoning effort" aria-haspopup="menu" aria-expanded="false" aria-controls="runtimeEffortMenu" type="button">
              <span id="runtimeEffortLabel" class="composer-select__label">auto</span>
              <span class="composer-select__chevron" aria-hidden="true">⌄</span>
            </button>
            <div id="runtimeEffortMenu" class="popover runtime-option-menu" hidden></div>
          </div>
        </div>
      </div>
      </form>
    </section>
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
    const visibleStatus = state.disconnected ? "Disconnected" : state.status;
    const usage = state.usage;
    const denom = usage ? usage.sessionCacheHitTokens + usage.sessionCacheMissTokens : 0;
    const hitRate = usage && denom > 0 ? Math.round((usage.sessionCacheHitTokens / denom) * 100) : undefined;
    this.statusBar.text = hitRate === undefined ? `$(sparkle) Reasonix: ${visibleStatus}` : `$(sparkle) Reasonix cache ${hitRate}%`;
    const tooltip = [`Reasonix ${folder.name}`, visibleStatus];
    if (usage) {
      tooltip.push(`Tokens: ${usage.totalTokens}`);
    }
    if (hitRate !== undefined) {
      tooltip.push(`Session cache: ${hitRate}%`);
    }
    this.statusBar.tooltip = tooltip.join("\n");
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
  const action = await vscode.window.showErrorMessage(
    "Reasonix CLI was not found on PATH. Select an installed binary or follow the Reasonix installation guide.",
    "Select Binary",
    "Installation Guide",
    "Open Settings",
  );
  if (action === "Select Binary") {
    return await selectReasonixBinary();
  }
  if (action === "Installation Guide") {
    await vscode.env.openExternal(vscode.Uri.parse("https://github.com/esengine/DeepSeek-Reasonix#installation"));
  } else if (action === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "reasonix.binaryPath");
  }
  return undefined;
}

async function selectReasonixBinary(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Use Reasonix CLI",
    title: "Select the Reasonix executable",
  });
  const selected = picked?.[0]?.fsPath;
  if (!selected) {
    return undefined;
  }
  await vscode.workspace.getConfiguration("reasonix").update("binaryPath", selected, vscode.ConfigurationTarget.Global);
  return selected;
}

function workspaceKey(folder: vscode.WorkspaceFolder): string {
  return folder.uri.toString();
}

function emptyState(): WorkspaceChatState {
  return { items: [], running: false, disconnected: true, status: "Disconnected", mcp: { connected: [], configured: [], disconnected: [] } };
}

function currentSettings(): ReasonixSettings {
  const config = vscode.workspace.getConfiguration("reasonix");
  const includeSelectionMode = configuredSelectionMode();
  return {
    binaryPath: config.get<string>("binaryPath", ""),
    model: config.get<string>("model", ""),
    uiLanguage: configuredUiLanguage(),
    autoStart: config.get<boolean>("autoStart", false),
    trace: config.get<boolean>("trace", false),
    includeSelectionMode,
  };
}

function configuredUiLanguage(): UiLanguage {
  const value = vscode.workspace.getConfiguration("reasonix").get<string>("uiLanguage", "auto");
  return value === "en" || value === "zh-CN" || value === "auto" ? value : "auto";
}

function effectiveUiLocale(): string {
  const language = configuredUiLanguage();
  return language === "auto" ? vscode.env.language : language;
}

function cacheBrief(usage: UsageData): string | undefined {
  const total = usage.sessionCacheHitTokens + usage.sessionCacheMissTokens;
  if (total <= 0) {
    return undefined;
  }
  return `cache ${Math.round((usage.sessionCacheHitTokens / total) * 100)}%`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function configOptionByCategory(options: SessionConfigOption[] | undefined, category: string): SessionConfigOption | undefined {
  return options?.find((option) => option.category === category);
}

function configOptionByIds(options: SessionConfigOption[] | undefined, ids: string[]): SessionConfigOption | undefined {
  const accepted = new Set(ids);
  return options?.find((option) => accepted.has(option.id));
}

function matchesAvailableCommand(prompt: string, commands: AvailableCommand[] | undefined): boolean {
  const match = /^\s*\/([A-Za-z0-9_-]+)/.exec(prompt);
  return match !== null && commands?.some((command) => command.name.toLowerCase() === match[1]?.toLowerCase()) === true;
}

function titleFromPrompt(prompt: string): string {
  const compact = prompt
    .replace(/\s+/g, " ")
    .trim();
  if (compact === "") {
    return "New session";
  }
  return compact.length > 58 ? `${compact.slice(0, 55)}...` : compact;
}

function promptWithLegacyComposerModes(
  prompt: string,
  collaborationMode: CollaborationMode,
  tokenMode: TokenMode,
  supportsGoalMode: boolean,
  supportsWorkMode: boolean,
): string {
  const prefixes: string[] = [];
  if (collaborationMode === "goal" && !supportsGoalMode) {
    prefixes.push("Goal mode: treat this as a concrete goal. Keep working toward completion, stop when blocked, and call out the next required user decision clearly.");
  }
  if (tokenMode === "economy" && !supportsWorkMode) {
    prefixes.push("Token economy mode: keep the initial approach lean, avoid loading broad context unless needed, and prefer focused reads/searches before expanding scope.");
  }
  return prefixes.length === 0 ? prompt : [...prefixes, "", prompt].join("\n");
}

function permissionModeNotice(mode: ToolApprovalMode): string {
  switch (mode) {
    case "ask":
      return "Approval requested";
    case "auto":
      return "Auto-approved";
    case "yolo":
      return "Yolo auto-approved";
  }
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
