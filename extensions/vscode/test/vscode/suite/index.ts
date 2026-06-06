import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const fakeAcp = process.env.REASONIX_FAKE_ACP;
  const fakeLog = process.env.REASONIX_FAKE_LOG;
  const workspacePath = process.env.REASONIX_TEST_WORKSPACE;
  assert.ok(fakeAcp);
  assert.ok(fakeLog);
  assert.ok(workspacePath);

  const folder = await waitForWorkspace();
  assert.equal(path.resolve(folder.uri.fsPath), path.resolve(workspacePath));

  const extension = vscode.extensions.getExtension("esengine.reasonix-vscode");
  assert.ok(extension);
  await extension.activate();
  await waitForCommand("reasonix.newSession");

  await vscode.workspace.getConfiguration("reasonix").update("binaryPath", fakeAcp, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration("reasonix").update("trace", false, vscode.ConfigurationTarget.Global);

  await vscode.commands.executeCommand("reasonix.openChat");
  await vscode.commands.executeCommand("reasonix.newSession");
  await waitForLog(fakeLog, "session/new");

  const doc = await vscode.workspace.openTextDocument(path.join(workspacePath, "sample.ts"));
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, doc.lineAt(0).text.length));

  await vscode.commands.executeCommand("reasonix.sendSelection");
  const promptEvent = await waitForLog(fakeLog, "session/prompt");
  assert.match(JSON.stringify(promptEvent), /sample\.ts/);
  assert.match(JSON.stringify(promptEvent), /const answer = 42/);
}

async function waitForCommand(command: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await vscode.commands.getCommands(true)).includes(command)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for command ${command}`);
}

async function waitForWorkspace(): Promise<vscode.WorkspaceFolder> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      return folder;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for workspace folder");
}

async function waitForLog(file: string, method: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const content = await fs.readFile(file, "utf8");
      last = content;
      for (const line of content.trim().split(/\r?\n/)) {
        if (!line) {
          continue;
        }
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.method === method) {
          return event;
        }
      }
    } catch {
      // Wait until the fake ACP creates the log.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${method}. Log:\n${last}`);
}
