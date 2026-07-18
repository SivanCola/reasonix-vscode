import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FSReadTextFileParams, FSReadTextFileResult, FSWriteTextFileParams } from "./acpTypes";

export class WorkspaceFileBridge {
  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly log: (message: string) => void,
  ) {}

  async readTextFile(params: FSReadTextFileParams): Promise<FSReadTextFileResult> {
    this.requireTrustedWorkspace("read files");
    const uri = await this.resolveExisting(params.path);
    const open = await this.openDocument(uri);
    const document = open ?? await vscode.workspace.openTextDocument(uri);
    const content = pageLines(document.getText(), params.line, params.limit);
    this.log(`ACP read ${this.relativeLabel(uri)}`);
    return { content };
  }

  async writeTextFile(params: FSWriteTextFileParams): Promise<Record<string, never>> {
    this.requireTrustedWorkspace("write files");
    const uri = await this.resolveForWrite(params.path);
    const open = await this.openDocument(uri);
    if (open) {
      const version = open.version;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, fullDocumentRange(open), params.content);
      if (open.version !== version) {
        throw new Error(`Refusing ACP write because ${this.relativeLabel(uri)} changed concurrently`);
      }
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error(`VS Code rejected the ACP write to ${this.relativeLabel(uri)}`);
      }
      if (open.version !== version + 1) {
        throw new Error(`Refusing to save ${this.relativeLabel(uri)} because it changed during the ACP write`);
      }
      if (!await open.save()) {
        throw new Error(`VS Code could not save the ACP write to ${this.relativeLabel(uri)}`);
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content, "utf8"));
    }
    this.log(`ACP wrote ${this.relativeLabel(uri)}`);
    return {};
  }

  private requireTrustedWorkspace(action: string): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error(`Workspace trust is required for Reasonix to ${action}`);
    }
  }

  private async resolveExisting(requestedPath: string): Promise<vscode.Uri> {
    const candidate = this.resolveLexical(requestedPath);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new Error(`File does not exist: ${this.relativeLabel(vscode.Uri.file(candidate))}`);
    }
    await this.assertRealPathInside(real);
    return vscode.Uri.file(real);
  }

  private async resolveForWrite(requestedPath: string): Promise<vscode.Uri> {
    const candidate = this.resolveLexical(requestedPath);
    try {
      const real = await fs.realpath(candidate);
      await this.assertRealPathInside(real);
      return vscode.Uri.file(real);
    } catch (err) {
      if (!isMissingPathError(err)) {
        throw err;
      }
    }

    const parent = path.dirname(candidate);
    let realParent: string;
    try {
      realParent = await fs.realpath(parent);
    } catch {
      throw new Error(`Parent directory does not exist: ${this.relativeLabel(vscode.Uri.file(parent))}`);
    }
    await this.assertRealPathInside(realParent);
    return vscode.Uri.file(path.join(realParent, path.basename(candidate)));
  }

  private resolveLexical(requestedPath: string): string {
    if (requestedPath.includes("\0")) {
      throw new Error("ACP file path contains a null byte");
    }
    const root = path.resolve(this.folder.uri.fsPath);
    const candidate = path.resolve(root, requestedPath);
    if (!isInside(candidate, root)) {
      throw new Error("Reasonix file access is limited to the active workspace folder");
    }
    return candidate;
  }

  private async assertRealPathInside(candidate: string): Promise<void> {
    const root = await fs.realpath(this.folder.uri.fsPath);
    if (!isInside(candidate, root)) {
      throw new Error("Reasonix file access cannot follow a symlink outside the workspace");
    }
  }

  private async openDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const target = normalizePath(uri.fsPath);
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== "file") {
        continue;
      }
      if (normalizePath(document.uri.fsPath) === target) {
        return document;
      }
      try {
        if (normalizePath(await fs.realpath(document.uri.fsPath)) === target) {
          return document;
        }
      } catch {
        // Untitled/deleted documents cannot match an existing filesystem target.
      }
    }
    return undefined;
  }

  private relativeLabel(uri: vscode.Uri): string {
    return path.relative(this.folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/") || ".";
  }
}

function pageLines(content: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) {
    return content;
  }
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, (line ?? 1) - 1);
  return lines.slice(start, limit === undefined ? undefined : start + limit).join("\n");
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = Math.max(0, document.lineCount - 1);
  return new vscode.Range(new vscode.Position(0, 0), document.lineAt(lastLine).rangeIncludingLineBreak.end);
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(normalizePath(root), normalizePath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isMissingPathError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}
