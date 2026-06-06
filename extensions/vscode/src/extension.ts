import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AcpClient } from "./acpClient";
import type { PermissionRequestParams, PermissionRequestResult, SessionUpdateParams } from "./acpTypes";
import { appendNotice, appendUserMessage, applySessionUpdate, type ChatItem } from "./chatState";
import { appendEditorContext, buildEditorContext } from "./editorContext";
import { DiffPreviewProvider } from "./preview";
import { parseWebviewMessage } from "./webviewProtocol";

const execFileAsync = promisify(execFile);
const viewId = "reasonix.chat";

type ChatSnapshot = {
  items: ChatItem[];
  running: boolean;
  disconnected: boolean;
  status: string;
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Reasonix");
  const preview = new DiffPreviewProvider();
  preview.register(context);

  const provider = new ReasonixChatProvider(context, output, preview);
  context.subscriptions.push(
    output,
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
  );
}

export function deactivate(): void {}

class ReasonixChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private client?: AcpClient;
  private items: ChatItem[] = [];
  private running = false;
  private disconnected = true;
  private status = "Idle";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly preview: DiffPreviewProvider,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw) => void this.handleWebviewMessage(raw), undefined, this.context.subscriptions);
    this.postSnapshot();

    if (vscode.workspace.getConfiguration("reasonix").get<boolean>("autoStart", false)) {
      void this.ensureClient();
    }
  }

  async newSession(): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before starting a new session.");
      return;
    }
    this.client?.dispose();
    this.client = undefined;
    this.items = [];
    this.running = false;
    this.disconnected = true;
    this.status = "New session";
    await this.context.workspaceState.update(this.sessionStorageKey(), undefined);
    this.postSnapshot();
    await this.ensureClient();
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
    this.client?.cancel();
    this.running = false;
    this.status = "Cancelling";
    this.postSnapshot();
  }

  async pickModel(): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage("Reasonix is running. Cancel the current turn before switching model.");
      return;
    }
    const config = vscode.workspace.getConfiguration("reasonix");
    const current = config.get<string>("model", "");
    const model = await vscode.window.showInputBox({
      title: "Reasonix model",
      prompt: "Provider/model reference passed to reasonix acp --model. Leave empty to use Reasonix config default.",
      value: current,
    });
    if (model === undefined) {
      return;
    }
    await config.update("model", model.trim(), vscode.ConfigurationTarget.Workspace);
    this.client?.dispose();
    this.client = undefined;
    this.disconnected = true;
    this.status = model.trim() === "" ? "Using config default model" : `Model: ${model.trim()}`;
    this.postSnapshot();
  }

  private async handleWebviewMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.output.appendLine(`Ignored invalid webview message: ${JSON.stringify(raw)}`);
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
      case "stateSnapshot":
        this.postSnapshot();
        return;
      case "approvalDecision":
        return;
      default:
        assertNever(message);
    }
  }

  private async sendPrompt(text: string, appendContext: boolean): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "" || this.running) {
      return;
    }
    const client = await this.ensureClient();
    if (!client) {
      return;
    }

    const prompt = appendContext ? appendEditorContext(trimmed) : trimmed;
    appendUserMessage(this.items, prompt);
    this.running = true;
    this.status = "Running";
    this.postSnapshot();

    try {
      const result = await client.sendPrompt(prompt);
      if (result.stopReason === "cancelled") {
        appendNotice(this.items, "Turn cancelled.");
      } else if (result.stopReason === "error") {
        appendNotice(this.items, "Turn ended with an error. Check the Reasonix output channel.");
      }
    } catch (err) {
      appendNotice(this.items, `Reasonix error: ${errorMessage(err)}`);
      this.output.appendLine(`Reasonix prompt failed: ${errorMessage(err)}`);
    } finally {
      this.running = false;
      this.status = this.disconnected ? "Disconnected" : "Idle";
      this.postSnapshot();
    }
  }

  private async ensureClient(): Promise<AcpClient | undefined> {
    if (this.client?.connected) {
      return this.client;
    }
    const workspaceFolder = this.currentWorkspaceFolder();
    if (!workspaceFolder) {
      void vscode.window.showErrorMessage("Open a workspace folder before starting Reasonix.");
      return undefined;
    }
    const binaryPath = await resolveReasonixBinary();
    if (!binaryPath) {
      return undefined;
    }
    const config = vscode.workspace.getConfiguration("reasonix");
    const model = config.get<string>("model", "");
    const trace = config.get<boolean>("trace", false);
    const previousSessionId = this.context.workspaceState.get<string>(this.sessionStorageKey(workspaceFolder));

    this.disconnected = false;
    this.status = "Starting";
    this.postSnapshot();
    const client = new AcpClient({
      binaryPath,
      model,
      cwd: workspaceFolder.uri.fsPath,
      previousSessionId,
      output: this.output,
      trace,
      onUpdate: (params) => this.handleSessionUpdate(params),
      onPermissionRequest: (params) => this.handlePermissionRequest(params),
      onDisconnect: (reason) => {
        this.output.appendLine(`Reasonix ACP disconnected: ${reason}`);
        this.client = undefined;
        this.disconnected = true;
        this.running = false;
        this.status = "Disconnected";
        this.postSnapshot();
      },
      onSessionId: (sessionId) => {
        void this.context.workspaceState.update(this.sessionStorageKey(workspaceFolder), sessionId);
      },
    });
    this.client = client;
    try {
      await client.start();
      this.disconnected = false;
      this.status = "Idle";
      this.postSnapshot();
      return client;
    } catch (err) {
      client.dispose();
      this.client = undefined;
      this.disconnected = true;
      this.status = "Start failed";
      appendNotice(this.items, `Could not start Reasonix: ${errorMessage(err)}`);
      this.output.appendLine(`Reasonix start failed: ${errorMessage(err)}`);
      this.postSnapshot();
      return undefined;
    }
  }

  private handleSessionUpdate(params: SessionUpdateParams): void {
    applySessionUpdate(this.items, params.update);
    this.postSnapshot();
  }

  private async handlePermissionRequest(params: PermissionRequestParams): Promise<PermissionRequestResult> {
    const workspaceFolder = this.currentWorkspaceFolder();
    try {
      await this.preview.previewPermission(params, workspaceFolder);
    } catch (err) {
      this.output.appendLine(`Reasonix diff preview failed: ${errorMessage(err)}`);
    }

    const title = params.toolCall.title ?? "tool call";
    const detail = permissionDetail(params);
    const allow = "Allow";
    const allowSession = "Allow Session";
    const allowPersistent = "Always Allow";
    const reject = "Reject";
    const picked = await vscode.window.showWarningMessage(
      `Reasonix wants to run ${title}`,
      { modal: true, detail },
      allow,
      allowSession,
      allowPersistent,
      reject,
    );
    if (!picked || picked === reject) {
      return { outcome: { outcome: "cancelled" } };
    }
    const kind = picked === allow ? "allow_once" : picked === allowSession ? "allow_always" : "allow_persistent";
    const option = params.options.find((candidate) => candidate.kind === kind) ?? params.options.find((candidate) => candidate.optionId === kind);
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private postSnapshot(): void {
    const snapshot: ChatSnapshot = {
      items: this.items,
      running: this.running,
      disconnected: this.disconnected,
      status: this.status,
    };
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
      <div id="status" class="status">Idle</div>
      <div class="actions">
        <button id="newSession" class="secondary" type="button">New</button>
        <button id="insertSelection" class="secondary" type="button">Selection</button>
        <button id="cancel" class="secondary" type="button">Cancel</button>
      </div>
    </header>
    <main id="transcript" class="transcript"></main>
    <form id="composer" class="composer">
      <textarea id="prompt" placeholder="Ask Reasonix about this workspace"></textarea>
      <div class="actions">
        <button id="send" type="submit">Send</button>
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

  private sessionStorageKey(folder = this.currentWorkspaceFolder()): string {
    return `reasonix.session.${folder?.uri.toString() ?? "global"}`;
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

function permissionDetail(params: PermissionRequestParams): string {
  const parts = [`Kind: ${params.toolCall.kind ?? "other"}`];
  if (params.toolCall.rawInput !== undefined) {
    parts.push("Input:");
    parts.push(truncate(JSON.stringify(params.toolCall.rawInput, null, 2), 2000));
  }
  return parts.join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + "\n...(truncated)";
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
