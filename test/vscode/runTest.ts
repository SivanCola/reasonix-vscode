import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index.js");
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-vscode-workspace-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-vscode-user-"));
  const fakeAcpScript = path.resolve(extensionDevelopmentPath, "test/vscode/fake-acp.cjs");
  const fakeAcp = path.join(workspacePath, process.platform === "win32" ? "fake-acp.cmd" : "fake-acp");
  const fakeLog = path.join(workspacePath, "fake-acp.log");
  fs.writeFileSync(path.join(workspacePath, "sample.ts"), "const answer = 42;\n");
  writeFakeAcpWrapper(fakeAcp, fakeAcpScript);

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

function writeFakeAcpWrapper(target: string, script: string): void {
  if (process.platform === "win32") {
    fs.writeFileSync(target, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return;
  }
  fs.writeFileSync(target, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(script)} "$@"\n`);
  fs.chmodSync(target, 0o755);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
