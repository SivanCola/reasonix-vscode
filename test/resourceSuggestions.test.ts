import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { suggestWorkspaceResources } from "../src/resourceSuggestions";

test("suggestWorkspaceResources lists root files and folders for empty query", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-suggestions-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "node_modules"));
  await fs.writeFile(path.join(workspace, "README.md"), "# demo\n");

  const suggestions = await suggestWorkspaceResources("", workspace);

  assert.deepEqual(suggestions.map((suggestion) => suggestion.insertText), ["src/", "README.md"]);
});

test("suggestWorkspaceResources ranks prefix matches across the workspace", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-suggestions-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "test"));
  await fs.writeFile(path.join(workspace, "src", "webview.ts"), "");
  await fs.writeFile(path.join(workspace, "test", "webviewProtocol.test.ts"), "");

  const suggestions = await suggestWorkspaceResources("src/we", workspace);

  assert.equal(suggestions[0]?.insertText, "src/webview.ts");
});

test("suggestWorkspaceResources lists children when query names a directory", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-suggestions-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "src", "nested"));
  await fs.writeFile(path.join(workspace, "src", "webview.ts"), "");

  const suggestions = await suggestWorkspaceResources("src/", workspace);

  assert.deepEqual(suggestions.map((suggestion) => suggestion.insertText), ["src/nested/", "src/webview.ts"]);
});

test("suggestWorkspaceResources skips common generated directories during broad scans", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "reasonix-suggestions-"));
  await fs.mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(workspace, "node_modules", "pkg", "webview.ts"), "");
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, "src", "webview.ts"), "");

  const suggestions = await suggestWorkspaceResources("webview", workspace);

  assert.deepEqual(suggestions.map((suggestion) => suggestion.insertText), ["src/webview.ts"]);
});
