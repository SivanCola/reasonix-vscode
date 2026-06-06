import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index.js");
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-vscode-workspace-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-vscode-user-"));
  const fakeAcp = path.resolve(extensionDevelopmentPath, "test/vscode/fake-acp.cjs");
  const fakeLog = path.join(workspacePath, "fake-acp.log");
  fs.chmodSync(fakeAcp, 0o755);
  fs.writeFileSync(path.join(workspacePath, "sample.ts"), "const answer = 42;\n");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, "--user-data-dir", userDataDir, "--disable-extensions"],
    extensionTestsEnv: {
      REASONIX_FAKE_ACP: fakeAcp,
      REASONIX_FAKE_LOG: fakeLog,
      REASONIX_TEST_WORKSPACE: workspacePath,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
