# Changelog

## Unreleased

- Stopped a running turn from dragging the transcript back to the bottom, so the chat can be scrolled and read while the model is still streaming. Auto-follow now resumes when the reader returns to the newest output, and sending a prompt still jumps to it.
- Made reasoning summaries readable while they stream: they expand by default into a height-capped, internally scrolling body that follows the newest text, and the collapse state and scroll position survive the re-render every streaming update triggers.

## 0.3.2

- Removed repeated editor-context confirmation dialogs. The visible composer context mode now controls automatic context inclusion, while explicit `Send Selection` actions attach the current selection or cursor window directly.
- Replaced the fallback tool-permission modal with an automatically revealed inline approval card and a non-modal notification fallback when the chat view cannot be opened.

## 0.3.1

- Restored usage cards and cache telemetry with Reasonix 1.19+ by consuming its advertised namespaced ACP status snapshot and update methods, while retaining compatibility with legacy usage updates.
- Fixed long chat sessions freezing the VS Code renderer by removing selection-change snapshot floods, coalescing Host updates, sending revisioned transcript splices instead of the full history for every ACP chunk, bounding the rendered transcript window, and persisting only lightweight Webview UI state.
- Fixed Windows ACP startup for npm-installed Reasonix CLIs by preferring the packaged native executable, resolving `.cmd` and explicitly configured extensionless shims, and safely launching custom command wrappers when no native binary is available.
- Updated the chat Webview to follow VS Code theme colors across light and dark themes instead of mixing fixed dark surfaces and highlights into the active theme.
- Prevented malformed or extended Markdown fences from entering a non-progress render loop and freezing the Webview.

## 0.3.0

- Added a composer `+` menu with four actions: attach local files or images, reference workspace files or folders, reference past sessions, and insert slash commands. Attachments show as removable chips and are read at send time with size caps; images are sent as ACP `image` blocks when the backend supports them.
- Redesigned settings with a horizontal text tab bar, and turned the Behavior tab tool-approval entry into a functional Ask/Auto/Yolo segmented control backed by the ACP session config.
- New sessions now default the tool approval policy to `auto` when the backend advertises it; resumed sessions keep their previous policy.
- Fixed narrow-width composer clipping: removed the 300px page minimum, restored footer overflow scrolling, and kept popover menus anchored with `position: fixed`.
- Renamed the plan-mode composer chip to match the menu wording, and removed several generations of dead legacy CSS.

## 0.2.0

- Updated the extension to the Reasonix 1.0 `main-v2` ACP contract, including capabilities, config options, models, modes, dynamic commands, plans, tool locations, and native session lifecycle.
- Split composer execution, work profile, and tool approval controls into independent ACP-backed axes (`normal/plan/goal`, `economy/balanced/delivery`, and `ask/auto/yolo`).
- Added trusted-workspace filesystem overlay callbacks for unsaved reads and guarded writes, plus client-owned VS Code terminals with bounded output.
- Replaced prompt XML context with bounded ACP resource blocks and separated structured Ask questions from tool approvals.
- Added automatic reconnect/resume, native session listing/deletion, setup improvements, telemetry fallback behavior, and expanded unit/Extension Host/real-ACP/VSIX verification.

## 0.1.1

- Moved the Marketplace/Open VSX publishing namespace to `SivanLiu`.

## 0.1.0

- Refined the Reasonix chat UI with the compact Reasonix/Cline-inspired layout, bilingual interface controls, streamlined mode/model controls, and a dedicated settings entry.
- Added release automation for CI, VSIX packaging, content verification, Visual Studio Marketplace publishing, and Open VSX publishing.
- Added a formal Marketplace/Open VSX PNG icon and tightened the VSIX file allowlist.

## 0.0.1

- Added the initial Reasonix VS Code extension with ACP process hosting, chat UI, workspace sessions, editor context injection, cancellation, model picking, permission approvals, and diff previews.
- Added usage/cache telemetry, status bar reporting, inline approval cards, slash/skill/MCP surface chips, OutputChannel path redaction, and `@vscode/test-electron` fake-ACP smoke coverage.
