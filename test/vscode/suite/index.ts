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

  const extension = vscode.extensions.getExtension("SivanLiu.reasonix-agent");
  assert.ok(extension);
  await extension.activate();
  await waitForCommand("reasonix.newSession");

  await vscode.workspace.getConfiguration("reasonix").update("binaryPath", fakeAcp, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration("reasonix").update("model", "fake/default", vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration("reasonix").update("trace", false, vscode.ConfigurationTarget.Workspace);
  await waitForConfig("binaryPath", fakeAcp);
  await waitForConfig("model", "fake/default");

  await vscode.commands.executeCommand("reasonix.openChat");
  await vscode.commands.executeCommand("reasonix.newSession");
  const startEvent = await waitForLog(fakeLog, "process/start");
  assert.deepEqual(startEvent.argv, ["acp", "--model", "fake/default"]);
  await waitForLog(fakeLog, "session/new");
  const statusEvent = await waitForLog(fakeLog, "session/status/result");
  assert.match(JSON.stringify(statusEvent), /fake-mcp/);
  await vscode.commands.executeCommand("reasonix.pickModel");
  await waitForLog(fakeLog, "model/list/error");
  await vscode.commands.executeCommand("reasonix.openSettings");
  await vscode.commands.executeCommand("reasonix.showOutput");
  await vscode.commands.executeCommand("reasonix.test.webviewMessage", { command: "updateSetting", key: "uiLanguage", value: "zh-CN" });
  await waitForConfig("uiLanguage", "zh-CN");
  await vscode.commands.executeCommand("reasonix.test.webviewMessage", { command: "updateSetting", key: "trace", value: true });
  await waitForConfig("trace", true);
  await vscode.commands.executeCommand("reasonix.test.webviewMessage", { command: "setContextMode", mode: "nearby" });
  await waitForConfig("includeSelectionMode", "nearby");

  const doc = await vscode.workspace.openTextDocument(path.join(workspacePath, "sample.ts"));
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, doc.lineAt(0).text.length));

  await vscode.commands.executeCommand("reasonix.sendSelection");
  const promptEvent = await waitForLog(fakeLog, "session/prompt");
  assert.match(JSON.stringify(promptEvent), /sample\.ts/);
  assert.match(JSON.stringify(promptEvent), /const answer = 42/);

  await vscode.workspace.getConfiguration("reasonix").update("includeSelectionMode", "off", vscode.ConfigurationTarget.Workspace);
  await waitForConfig("includeSelectionMode", "off");
  await vscode.commands.executeCommand("reasonix.test.webviewMessage", {
    command: "sendPrompt",
    text: "/mcp mcp_tool skill_use permission_probe @sample.ts @src/",
    collaborationMode: "plan",
    tokenMode: "economy",
    toolApprovalMode: "auto",
  });
  const slashPrompt = await waitForLogMatch(fakeLog, (event) => {
    const serialized = JSON.stringify(event);
    return event.method === "session/prompt" && serialized.includes("Inspect the connected MCP context") && serialized.includes("reasonix_file_mentions");
  }, "expanded slash prompt with @ file context");
  assert.match(JSON.stringify(slashPrompt), /mcp_tool/);
  assert.match(JSON.stringify(slashPrompt), /Plan mode:/);
  assert.match(JSON.stringify(slashPrompt), /Token economy mode:/);
  assert.match(JSON.stringify(slashPrompt), /const answer = 42/);
  assert.match(JSON.stringify(slashPrompt), /<directory path=\\"src\\">/);
  assert.match(JSON.stringify(slashPrompt), /helper\.ts/);
  await waitForLog(fakeLog, "tool/fake-mcp");
  await waitForLog(fakeLog, "tool/fake-skill");
  const permissionResponse = await waitForLog(fakeLog, "permission/response");
  assert.match(JSON.stringify(permissionResponse), /allow-once/);

  await assertWebviewPrompt(fakeLog, "/help", /Commands: \/explain, \/fix, \/tests, \/search, \/mcp, \/skills/);
  await assertWebviewPrompt(fakeLog, "/explain @sample.ts", /Explain the referenced code[\s\S]*reasonix_file_mentions[\s\S]*const answer = 42/);
  await assertWebviewPrompt(fakeLog, "/fix broken test", /Fix the referenced issue[\s\S]*broken test/);
  await assertWebviewPrompt(fakeLog, "/tests unit", /Run or identify the relevant tests[\s\S]*unit/);
  await assertWebviewPrompt(fakeLog, "/search AcpClient", /Search the repository[\s\S]*AcpClient/);
  await assertWebviewPrompt(fakeLog, "/skills design", /Use the appropriate Reasonix\/Codex skills[\s\S]*design/);
  await assertWebviewPrompt(fakeLog, "/future-command keep this", /\/future-command keep this/);

  const slowTurn = vscode.commands.executeCommand("reasonix.test.webviewMessage", {
    command: "sendPrompt",
    text: "slow_prompt",
    toolApprovalMode: "ask",
  });
  await waitForLog(fakeLog, "slow/prompt");
  await vscode.commands.executeCommand("reasonix.test.webviewMessage", { command: "cancel" });
  await waitForLog(fakeLog, "session/cancel");
  await waitForLog(fakeLog, "session/prompt/cancelled");
  await slowTurn;

  await assertQuickPrompt(fakeLog, "explainFile", /Explain the current file/);
  await assertQuickPrompt(fakeLog, "fixSelection", /Fix the selected code/);
  await assertQuickPrompt(fakeLog, "runTests", /Run the relevant tests/);
  await assertQuickPrompt(fakeLog, "searchRepo", /Search the repository/);
}

async function waitForCommand(command: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await vscode.commands.getCommands(true)).includes(command)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for command ${command}`);
}

async function waitForWorkspace(): Promise<vscode.WorkspaceFolder> {
  const deadline = Date.now() + 30_000;
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
  return await waitForLogMatch(file, (event) => event.method === method, method);
}

async function waitForLogMatch(file: string, matches: (event: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
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
        if (matches(event)) {
          return event;
        }
      }
    } catch {
      // Wait until the fake ACP creates the log.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}. Log:\n${last}`);
}

async function assertQuickPrompt(fakeLog: string, action: "explainFile" | "fixSelection" | "runTests" | "searchRepo", promptPattern: RegExp): Promise<void> {
  await vscode.commands.executeCommand("reasonix.test.webviewMessage", { command: "quickPrompt", action });
  const prompt = await waitForLogMatch(fakeLog, (event) => {
    const serialized = JSON.stringify(event);
    return event.method === "session/prompt" && promptPattern.test(serialized);
  }, `quick prompt ${action}`);
  assert.match(JSON.stringify(prompt), promptPattern);
}

async function assertWebviewPrompt(fakeLog: string, text: string, promptPattern: RegExp): Promise<void> {
  await vscode.commands.executeCommand("reasonix.test.webviewMessage", { command: "sendPrompt", text });
  const prompt = await waitForLogMatch(fakeLog, (event) => {
    const serialized = JSON.stringify(event);
    return event.method === "session/prompt" && promptPattern.test(serialized);
  }, `webview prompt ${text}`);
  assert.match(JSON.stringify(prompt), promptPattern);
}

async function waitForConfig(key: string, expected: string | boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (vscode.workspace.getConfiguration("reasonix").get<unknown>(key) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for reasonix.${key}`);
}
