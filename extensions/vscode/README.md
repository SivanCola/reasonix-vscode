# Reasonix for VS Code

Reasonix for VS Code connects the editor to the local `reasonix acp` agent. The extension keeps the Go Reasonix agent as the source of truth and provides the IDE host layer: chat, workspace sessions, tool-call rendering, approval review, cancellation, model selection, and editor context.


## Features

- Activity Bar chat view backed by the local `reasonix acp` process.
- One Reasonix client/session per VS Code workspace folder, with session ids stored in workspace state.
- Current file and selection context injection, with a send-time confirmation before editor context is appended.
- Tool cards, Go-provided diff previews, and inline approval cards for allow once, allow session, always allow, or reject.
- Usage and cache-hit telemetry in the chat view and status bar.
- Model picker with configured provider/model entries and effort selection when supported.
- Basic slash command, skill, and MCP surface chips from the ACP backend.
- `@vscode/test-electron` smoke tests using a fake ACP server.

## Requirements

Install the Reasonix CLI first:

```sh
npm i -g reasonix
```

Set `reasonix.binaryPath` if `reasonix` is not available on PATH.

## Settings

- `reasonix.binaryPath`: absolute path to the Reasonix CLI.
- `reasonix.model`: optional provider/model reference passed to `reasonix acp --model`.
- `reasonix.autoStart`: start ACP when the chat view opens.
- `reasonix.trace`: write ACP JSON-RPC diagnostics to the Reasonix output channel.
- `reasonix.includeSelectionMode`: controls selection or nearby cursor context appended to prompts.

## Privacy

The Webview cannot access the shell, file system, or network directly. Editor context is appended only to user turns after confirmation. OutputChannel logs redact the active workspace path and home directory before display.

## Development

```sh
npm install
npm run compile
npm run lint
npm test
npm run test:vscode
```

Open this folder in VS Code and press F5 to start an Extension Development Host. For a release smoke test, package with `npm run package`, install the generated VSIX, then open the Reasonix chat view in a workspace.
