# Reasonix for VS Code

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

Reasonix for VS Code brings the local Reasonix coding agent into the editor. It implements the ACP v1 client surface used by Reasonix 1.0 (`main-v2`) and keeps the extension focused on IDE integration: chat, native sessions, editor resources, tool review, approvals and questions, terminals, models, modes, and plans.

This repository is the standalone VS Code extension package. It does not include the Reasonix CLI or upstream Reasonix source code.

The extension does not bundle a Reasonix binary. It uses `reasonix.binaryPath` when configured, then falls back to resolving `reasonix` from `PATH`.

## Highlights

- Chat view in the VS Code Activity Bar, backed by the local `reasonix acp` process.
- Native `session/list`, `load`, `resume`, `close`, and `delete` lifecycle with automatic reconnect/resume.
- ACP filesystem overlay reads unsaved buffers and applies guarded workspace edits; client-owned terminals stream commands in VS Code.
- Current file, selection, nearby cursor context, and `@` mentions sent as ACP resource blocks on the current user turn.
- Send-time confirmation before editor context is appended to a user turn.
- Tool-call cards with raw input, results, and backend-provided diff previews.
- Separate inline approval and structured question controls; Ask questions are never auto-answered.
- Reasonix-styled chat surface with independent Execution Method, Work Mode, and Ask/Auto/Yolo tool permission menus backed by ACP session axes.
- Model, reasoning effort, execution method, work mode, and tool approval controls backed by the corresponding ACP session config and mode methods.
- Dynamic slash commands, structured plans, and clickable tool locations from `session/update` notifications.
- Usage and cache telemetry are shown only when the backend actually reports them.
- Path redaction for workspace and home-directory paths in the Reasonix OutputChannel.

## Requirements

Install and configure Reasonix first:

```sh
npm i -g reasonix
# or: brew install esengine/reasonix/reasonix
```

If `reasonix` is not available on `PATH`, set `reasonix.binaryPath` to the absolute CLI path.

Use Reasonix 1.0 or newer. Reasonix itself must already be configured with the provider credentials and models you want to use. The extension delegates model execution, tools, permissions, MCP, and transcripts to the local Reasonix backend.

## Getting Started

1. Open a folder or multi-root workspace in VS Code.
2. Open the Reasonix Activity Bar view, or run `Reasonix: Open Chat`.
3. Open `Settings` in the chat view, or run `Reasonix: Open Settings`, to configure the CLI path, model, language, context mode, auto start, and trace logging.
4. Start a new session with `Reasonix: New Session` or the `+` button in the chat view.
5. Type a prompt, choose an execution method (Standard, Plan, or Goal), a work mode (Lightweight, Balanced, or Delivery), and an Ask/Auto/Yolo tool approval policy, then send with the button or `Cmd/Ctrl+Enter`.
6. Type `/` at the start of a prompt to open the command menu advertised by the active Reasonix session.
7. Type `@` to open workspace file and folder suggestions; selecting `@src/file.ts` or `@src/` attaches bounded resource context to the user turn.
8. Use `Reasonix: Send Selection` from the command palette or editor context menu to send the current editor context.

When a pending tool call needs approval, Reasonix shows an inline approval card. If the chat view is unavailable, the extension falls back to a VS Code modal approval prompt.

## Commands

| Command | Description |
| --- | --- |
| `Reasonix: Open Chat` | Opens the Reasonix Activity Bar chat view. |
| `Reasonix: New Session` | Stops the current ACP client for the active workspace and starts a fresh session. |
| `Reasonix: Send Selection` | Sends the current file path, language id, selection or nearby cursor window as user-turn context. |
| `Reasonix: Cancel Turn` | Sends `session/cancel` to the active Reasonix session. |
| `Reasonix: Pick Model` | Opens a model picker backed by the Reasonix ACP model list. |
| `Reasonix: Pick Effort` | Selects a reasoning level from the session's ACP config options. |
| `Reasonix: Pick UI Language` | Switches the chat UI between Auto, English, and Simplified Chinese. |
| `Reasonix: Select CLI Binary` | Selects an installed Reasonix executable. |
| `Reasonix: Open Settings` | Opens the Reasonix settings view inside the Activity Bar chat view. |
| `Reasonix: Show Output` | Opens the Reasonix OutputChannel. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `reasonix.binaryPath` | `""` | Absolute path to the Reasonix CLI. Empty means resolve `reasonix` from `PATH`. |
| `reasonix.model` | `""` | Optional provider/model reference passed to `reasonix acp --model`. Empty means use the Reasonix config default. |
| `reasonix.uiLanguage` | `auto` | Controls the chat UI language: `auto`, `en`, or `zh-CN`. |
| `reasonix.autoStart` | `false` | Starts ACP when the chat view opens. |
| `reasonix.trace` | `false` | Writes ACP JSON-RPC traffic diagnostics to the Reasonix OutputChannel. |
| `reasonix.includeSelectionMode` | `selectionOnly` | Controls editor context appended to prompts: `off`, `selectionOnly`, or `nearby`. |

## Context And Privacy

Reasonix for VS Code follows a narrow host boundary:

- The Webview cannot access the shell, file system, or network directly.
- Editor context and mentions are ACP resource blocks on user turns only, never system prompts, tool schemas, or stable prefixes.
- Filesystem callbacks require a trusted workspace, stay inside the workspace after symlink resolution, and refuse stale concurrent edits.
- Terminal callbacks require a trusted workspace, keep the working directory inside it, stream through a VS Code terminal, and bound captured output.
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

### Model or effort selection is unavailable

The active session did not advertise the relevant model or `thought_level` config option. Chat continues with the configured default.

### Diff preview did not open

Some edits cannot be previewed safely before execution, especially binary files, ambiguous replacements, or unsupported tool inputs. Review the approval card raw input before allowing the tool call.

## Development

Install dependencies and build the extension:

```sh
npm install
npm run compile
```

Open a fresh VS Code Extension Development Host with the latest local build:

```sh
npm run dev:host
```

Useful checks:

```sh
npm run lint
npm test
npm run test:vscode
npm run smoke:acp
npm run debug:extension
```

Package a VSIX:

```sh
npm run package
```

`npm run test:vscode` uses `@vscode/test-electron` with a main-v2-shaped fake ACP server. It verifies independent execution/work/approval axes, cache-stable native profile switching, early command updates, native sessions, resource blocks, unsaved-buffer reads, guarded writes, VS Code terminals, plans, tool locations, Ask handling, cancellation, and reconnect/resume without a model call.

`npm run smoke:acp` starts the real `reasonix acp` backend and checks capabilities, session state, list, mode switching, close, and cleanup without sending a prompt or invoking a model. Set `REASONIX_BINARY=/absolute/path/to/reasonix` to test a specific CLI. Set `REASONIX_ACP_SMOKE_REQUIRED=1` if missing `reasonix` should fail instead of skip.

## Release Checklist

- Run `npm run debug:extension && npm run package`.
- Confirm the VSIX includes `dist/extension.js`, `media/webview.js`, `media/styles.css`, `media/icon.svg`, `scripts/acp-smoke.mjs`, `scripts/verify-vsix-contents.mjs`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`.
- Install the VSIX in VS Code or Cursor and run a manual smoke test with a real `reasonix acp` backend.

## License

MIT
