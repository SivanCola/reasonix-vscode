import * as path from "node:path";
import * as vscode from "vscode";
import type { ContentBlock } from "./acpTypes";

export type IncludeSelectionMode = "off" | "selectionOnly" | "nearby";

const cursorWindowRadius = 40;

export function configuredSelectionMode(): IncludeSelectionMode {
  const value = vscode.workspace.getConfiguration("reasonix").get<string>("includeSelectionMode", "selectionOnly");
  return value === "off" || value === "nearby" || value === "selectionOnly" ? value : "selectionOnly";
}

export function buildEditorContextBlock(mode = configuredSelectionMode()): { block: ContentBlock; summary: string } | undefined {
  if (mode === "off") {
    return undefined;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.isUntitled) {
    return undefined;
  }
  const document = editor.document;
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  if (mode === "selectionOnly" && !hasSelection) {
    return undefined;
  }
  const range = hasSelection ? selection : cursorWindow(document, selection.active.line);
  const text = document.getText(range);
  if (text.trim() === "") {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const filePath = folder ? path.relative(folder.uri.fsPath, document.uri.fsPath).replace(/\\/g, "/") : document.uri.fsPath;
  const summary = `${filePath} lines ${range.start.line + 1}-${range.end.line + 1}`;
  const label = hasSelection ? "Selection" : "Cursor window";
  return {
    summary,
    block: {
      type: "resource",
      resource: {
        uri: document.uri.with({ fragment: `L${range.start.line + 1}-L${range.end.line + 1}` }).toString(),
        mimeType: "text/plain",
        text: `VS Code ${label.toLowerCase()}: ${summary}\nLanguage: ${document.languageId}\n${text}`,
      },
    },
  };
}

function cursorWindow(doc: vscode.TextDocument, line: number): vscode.Range {
  const start = Math.max(0, line - cursorWindowRadius);
  const end = Math.min(doc.lineCount - 1, line + cursorWindowRadius);
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}
