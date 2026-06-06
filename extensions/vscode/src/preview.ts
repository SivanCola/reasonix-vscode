import * as path from "node:path";
import * as vscode from "vscode";
import type { PermissionRequestParams } from "./acpTypes";

type PreviewInput = {
  path?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  edits?: Array<{ old_string?: string; new_string?: string; replace_all?: boolean }>;
};

export class DiffPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("reasonix-preview", this));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  async previewPermission(params: PermissionRequestParams, workspaceFolder: vscode.WorkspaceFolder | undefined): Promise<void> {
    if (params.toolCall.preview && params.toolCall.preview.binary !== true) {
      const target = resolveTarget(params.toolCall.preview.path, workspaceFolder);
      await this.openPreview(target, params.toolCall.preview.oldText ?? "", params.toolCall.preview.newText ?? "", workspaceFolder);
      return;
    }
    const raw = params.toolCall.rawInput;
    if (!isRecord(raw)) {
      return;
    }
    const input = raw as PreviewInput;
    if (typeof input.path !== "string" || input.path.trim() === "") {
      return;
    }

    const tool = toolName(params.toolCall.title);
    const target = resolveTarget(input.path, workspaceFolder);
    const oldText = await readText(target);
    const nextText = applyPreview(tool, oldText, input);
    if (nextText === undefined || nextText === oldText) {
      return;
    }

    await this.openPreview(target, oldText, nextText, workspaceFolder);
  }

  private async openPreview(target: vscode.Uri, oldText: string, nextText: string, workspaceFolder: vscode.WorkspaceFolder | undefined): Promise<void> {
    const title = `Reasonix Preview: ${workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, target.fsPath) : target.fsPath}`;
    const oldUri = oldText === "" ? this.putVirtual("old", target, oldText) : target;
    const newUri = this.putVirtual("new", target, nextText);
    await vscode.commands.executeCommand("vscode.diff", oldUri, newUri, title, { preview: true });
  }

  private putVirtual(kind: "old" | "new", target: vscode.Uri, content: string): vscode.Uri {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const uri = vscode.Uri.from({
      scheme: "reasonix-preview",
      authority: kind,
      path: `/${id}/${path.basename(target.fsPath)}`,
    });
    this.docs.set(uri.toString(), content);
    this.emitter.fire(uri);
    return uri;
  }
}

function toolName(title: string | undefined): string {
  return (title ?? "").split(/\s+/, 1)[0] ?? "";
}

function resolveTarget(inputPath: string, workspaceFolder: vscode.WorkspaceFolder | undefined): vscode.Uri {
  if (path.isAbsolute(inputPath)) {
    return vscode.Uri.file(inputPath);
  }
  const root = workspaceFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return vscode.Uri.file(path.join(root, inputPath));
}

async function readText(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return "";
  }
}

function applyPreview(tool: string, oldText: string, input: PreviewInput): string | undefined {
  switch (tool) {
    case "write_file":
      return typeof input.content === "string" ? input.content : undefined;
    case "edit_file":
      if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
        return undefined;
      }
      return replaceOnce(oldText, input.old_string, input.new_string);
    case "multi_edit": {
      if (!Array.isArray(input.edits)) {
        return undefined;
      }
      let text = oldText;
      for (const edit of input.edits) {
        if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") {
          return undefined;
        }
        const next = edit.replace_all
          ? replaceAll(text, edit.old_string, edit.new_string)
          : replaceOnce(text, edit.old_string, edit.new_string);
        if (next === undefined) {
          return undefined;
        }
        text = next;
      }
      return text;
    }
    default:
      return undefined;
  }
}

function replaceOnce(text: string, oldString: string, newString: string): string | undefined {
  if (oldString === "") {
    return undefined;
  }
  const first = text.indexOf(oldString);
  if (first < 0 || text.indexOf(oldString, first + oldString.length) >= 0) {
    return undefined;
  }
  return text.slice(0, first) + newString + text.slice(first + oldString.length);
}

function replaceAll(text: string, oldString: string, newString: string): string | undefined {
  if (oldString === "" || !text.includes(oldString)) {
    return undefined;
  }
  return text.split(oldString).join(newString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
