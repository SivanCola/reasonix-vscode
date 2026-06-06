# Reasonix for VS Code

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

Reasonix for VS Code brings the local Reasonix coding agent into the editor. It runs the existing `reasonix acp` backend and keeps the VS Code extension focused on IDE integration: chat, workspace sessions, editor context, tool-call review, approvals, cancellation, model selection, and usage telemetry.

This repository contains the VS Code extension package under `extensions/vscode/`.

The extension does not bundle a Reasonix binary. It uses `reasonix.binaryPath` when configured, then falls back to resolving `reasonix` from `PATH`.

## Highlights

- Chat view in the VS Code Activity Bar, backed by the local `reasonix acp` process.
- Workspace-scoped Reasonix clients and sessions for multi-root workspaces.
- Current file, selection, and nearby cursor context insertion.
- Send-time confirmation before editor context is appended to a user turn.
- Tool-call cards with raw input, results, and backend-provided diff previews.
- Inline approval cards for allow once, allow session, always allow, or reject.
- Usage and cache-hit telemetry in the chat view and VS Code status bar.
- Model picker with configured provider/model entries and effort selection when supported.
- Basic slash command, skill, and MCP surface chips from the ACP backend.
- Path redaction for workspace and home-directory paths in the Reasonix OutputChannel.

## Requirements

Install and configure Reasonix first:

```sh
npm i -g reasonix
```

If `reasonix` is not available on `PATH`, set `reasonix.binaryPath` to the absolute CLI path.

Reasonix itself must already be configured with the provider credentials and models you want to use. The extension delegates model execution, tools, permissions, MCP, and transcripts to the local Reasonix backend.

## Getting Started

1. Open a folder or multi-root workspace in VS Code.
2. Open the Reasonix Activity Bar view, or run `Reasonix: Open Chat`.
3. Start a new session with `Reasonix: New Session` or the `+` button in the chat view.
4. Type a prompt, then send with the button or `Cmd/Ctrl+Enter`.
5. Use `Reasonix: Send Selection` from the command palette or editor context menu to send the current editor context.

When a pending tool call needs approval, Reasonix shows an inline approval card. If the chat view is unavailable, the extension falls back to a VS Code modal approval prompt.

## Commands

| Command | Description |
| --- | --- |
| `Reasonix: Open Chat` | Opens the Reasonix Activity Bar chat view. |
| `Reasonix: New Session` | Stops the current ACP client for the active workspace and starts a fresh session. |
| `Reasonix: Send Selection` | Sends the current file path, language id, selection or nearby cursor window as user-turn context. |
| `Reasonix: Cancel Turn` | Sends `session/cancel` to the active Reasonix session. |
| `Reasonix: Pick Model` | Opens a model picker backed by the Reasonix ACP model list. |
| `Reasonix: Show Output` | Opens the Reasonix OutputChannel. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `reasonix.binaryPath` | `""` | Absolute path to the Reasonix CLI. Empty means resolve `reasonix` from `PATH`. |
| `reasonix.model` | `""` | Optional provider/model reference passed to `reasonix acp --model`. Empty means use the Reasonix config default. |
| `reasonix.autoStart` | `false` | Starts ACP when the chat view opens. |
| `reasonix.trace` | `false` | Writes ACP JSON-RPC traffic diagnostics to the Reasonix OutputChannel. |
| `reasonix.includeSelectionMode` | `selectionOnly` | Controls editor context appended to prompts: `off`, `selectionOnly`, or `nearby`. |

## Context And Privacy

Reasonix for VS Code follows a narrow host boundary:

- The Webview cannot access the shell, file system, or network directly.
- Editor context is appended to user turns only, not to system prompts, tool schemas, or stable prefixes.
- Normal chat sends ask for confirmation before adding active editor context.
- `Reasonix: Send Selection` is an explicit command for sending the active selection or nearby cursor window.
- OutputChannel logs redact the active workspace path and home directory before display.

Use `reasonix.trace` only when debugging protocol issues, because it increases diagnostic output.

## Diff And Approval Review

For edit and write tools, the extension prefers the backend-provided preview from Reasonix ACP. When available, it opens a VS Code diff preview before the approval decision. If a reliable diff cannot be computed, the approval card still shows the tool input so the decision remains explicit.

Approval options map to Reasonix permission outcomes:

- `Once`: allow this tool call.
- `Session`: allow matching calls for this session.
- `Always`: persist the permission when supported by the backend.
- `Reject`: deny the tool call.

## Troubleshooting

### Reasonix CLI was not found

Install Reasonix with `npm i -g reasonix`, make sure it is on `PATH`, or set `reasonix.binaryPath`.

### The chat view says disconnected

Open `Reasonix: Show Output` and check the ACP process logs. Restart with `Reasonix: New Session`.

### Model list or effort selection is unavailable

Older ACP backends may not expose the optional `model/list` or `effort/set` extension methods. The chat flow still works with the configured default model.

### Diff preview did not open

Some edits cannot be previewed safely before execution, especially binary files, ambiguous replacements, or unsupported tool inputs. Review the approval card raw input before allowing the tool call.

## Development

Install dependencies and build the extension:

```sh
cd extensions/vscode
npm install
npm run compile
```

Useful checks:

```sh
cd extensions/vscode
npm run lint
npm test
npm run test:vscode
```

Package a VSIX:

```sh
cd extensions/vscode
npm run package
```

`npm run test:vscode` uses `@vscode/test-electron` with a fake ACP server to verify extension activation, chat command flow, session startup, and editor-context sending without requiring a real model call.

## Release Checklist

- Run `npm run lint && npm test && npm run test:vscode && npm run package` from `extensions/vscode/`.
- Confirm the VSIX includes `dist/extension.js`, `media/webview.js`, `media/styles.css`, `media/icon.svg`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`.
- Install the VSIX in VS Code or Cursor and run a manual smoke test with a real `reasonix acp` backend.

## License

MIT
