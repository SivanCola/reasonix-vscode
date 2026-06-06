import * as path from "node:path";
import * as vscode from "vscode";

export type IncludeSelectionMode = "off" | "selectionOnly" | "nearby";

const cursorWindowRadius = 40;

export function configuredSelectionMode(): IncludeSelectionMode {
  const value = vscode.workspace.getConfiguration("reasonix").get<string>("includeSelectionMode", "selectionOnly");
  return value === "off" || value === "nearby" || value === "selectionOnly" ? value : "selectionOnly";
}

export function buildEditorContext(mode = configuredSelectionMode()): string | undefined {
  if (mode === "off") {
    return undefined;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const doc = editor.document;
  if (doc.isUntitled) {
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const filePath = workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, doc.uri.fsPath) : doc.uri.fsPath;
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const range = hasSelection ? selection : cursorWindow(doc, selection.active.line);
  const text = doc.getText(range);
  if (text.trim() === "") {
    return undefined;
  }

  const label = hasSelection ? "Selection" : "Cursor window";
  return [
    "<vscode_context>",
    `File: ${filePath}`,
    `Language: ${doc.languageId}`,
    `${label}: lines ${range.start.line + 1}-${range.end.line + 1}`,
    "```" + doc.languageId,
    text,
    "```",
    "</vscode_context>",
  ].join("\n");
}

export function appendEditorContext(prompt: string, mode = configuredSelectionMode()): string {
  const ctx = buildEditorContext(mode);
  if (!ctx) {
    return prompt;
  }
  return `${prompt.trimEnd()}\n\n${ctx}`;
}

function cursorWindow(doc: vscode.TextDocument, line: number): vscode.Range {
  const start = Math.max(0, line - cursorWindowRadius);
  const end = Math.min(doc.lineCount - 1, line + cursorWindowRadius);
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}
