# Reasonix for VS Code

<p align="center">
  <a href="./README.md">English</a>
  &nbsp;·&nbsp;
  <strong>简体中文</strong>
</p>

Reasonix for VS Code 把本地 Reasonix coding agent 带进编辑器。它运行现有的 `reasonix acp` 后端，VS Code 扩展只负责 IDE 宿主层：聊天、工作区会话、编辑器上下文、工具调用审阅、权限确认、取消、模型选择和 usage/cache 遥测。

本仓库是独立的 VS Code 扩展包仓库，不包含 Reasonix CLI 或上游 Reasonix 源码。

扩展默认不捆绑 Reasonix 二进制。它会优先使用 `reasonix.binaryPath`，未配置时再从 `PATH` 查找 `reasonix`。

## 功能亮点

- VS Code Activity Bar 聊天视图，由本地 `reasonix acp` 进程驱动。
- 面向 multi-root workspace 的工作区级 Reasonix client/session。
- 当前文件、选区和光标附近窗口上下文注入。
- 普通聊天在追加编辑器上下文前会先确认。
- 工具调用卡片展示 raw input、执行结果和后端提供的 diff preview。
- 内嵌审批卡片支持本次允许、本会话允许、永久允许或拒绝。
- 参考 Reasonix 桌面端的聊天界面：紧凑命令栏、橙色发送按钮、协作方式弹层和 Ask/Auto/Yolo 工具权限切换。
- 聊天视图和 VS Code status bar 展示 usage 与 cache hit telemetry。
- 模型选择器展示已配置 provider/model，并在后端支持时提供 effort 选择。
- 内置 `/` prompt 命令覆盖常见编码流程，并支持用 `@workspace/path` 附加受限文件或目录资源上下文。
- 在顶部元信息和设置页展示 ACP 后端返回的 MCP 状态；工具调用、Skills 与 MCP 活动会通过 Reasonix tool cards 流式呈现。
- Reasonix OutputChannel 中会脱敏 workspace 路径和 home 目录。

## 环境要求

先安装并配置 Reasonix：

```sh
npm i -g reasonix
```

如果 `reasonix` 不在 `PATH` 中，请把 `reasonix.binaryPath` 设置为 CLI 的绝对路径。

Reasonix 本身需要提前配置好 provider credentials 和要使用的模型。扩展会把模型执行、工具、权限、MCP 和 transcript 都委托给本地 Reasonix 后端。

## 快速开始

1. 在 VS Code 中打开一个 folder 或 multi-root workspace。
2. 打开 Reasonix Activity Bar 视图，或执行 `Reasonix: Open Chat`。
3. 打开聊天视图里的 `设置`，或执行 `Reasonix: Open Settings`，配置 CLI 路径、模型、语言、上下文模式、自动启动和 trace 日志。
4. 使用 `Reasonix: New Session` 或聊天视图里的 `+` 按钮启动新会话。
5. 输入 prompt，可在协作方式弹层中切换计划、目标或省 token 行为，在底部选择询问/自动/Yolo 工具权限，再通过发送按钮或 `Cmd/Ctrl+Enter` 发送。
6. 在 prompt 开头使用 `/explain`、`/fix`、`/tests`、`/search`、`/mcp` 或 `/skills` 触发内置 prompt 命令。
7. 用 `@src/file.ts` 或 `@src/` 这类 workspace 相对路径引用文件或文件夹，发送时会附加受限资源上下文。
8. 使用 command palette 或 editor context menu 中的 `Reasonix: Send Selection` 发送当前编辑器上下文。

当工具调用需要审批时，Reasonix 会显示内嵌 approval card。如果聊天视图不可用，扩展会回退到 VS Code modal approval prompt。

## 命令

| 命令 | 说明 |
| --- | --- |
| `Reasonix: Open Chat` | 打开 Reasonix Activity Bar 聊天视图。 |
| `Reasonix: New Session` | 停止当前 active workspace 的 ACP client，并启动一个新 session。 |
| `Reasonix: Send Selection` | 将当前文件路径、language id、选区或光标附近窗口作为 user-turn context 发送。 |
| `Reasonix: Cancel Turn` | 向当前 Reasonix session 发送 `session/cancel`。 |
| `Reasonix: Pick Model` | 打开由 Reasonix ACP model list 支撑的模型选择器。 |
| `Reasonix: Pick UI Language` | 在自动、英文和简体中文之间切换聊天 UI 语言。 |
| `Reasonix: Open Settings` | 在 Activity Bar 聊天视图内打开 Reasonix 设置页。 |
| `Reasonix: Show Output` | 打开 Reasonix OutputChannel。 |

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `reasonix.binaryPath` | `""` | Reasonix CLI 绝对路径。为空时从 `PATH` 查找 `reasonix`。 |
| `reasonix.model` | `""` | 可选 provider/model reference，会传给 `reasonix acp --model`。为空时使用 Reasonix config 默认模型。 |
| `reasonix.uiLanguage` | `auto` | 控制聊天 UI 语言：`auto`、`en` 或 `zh-CN`。 |
| `reasonix.autoStart` | `false` | 打开 chat view 时自动启动 ACP。 |
| `reasonix.trace` | `false` | 将 ACP JSON-RPC 诊断流量写入 Reasonix OutputChannel。 |
| `reasonix.includeSelectionMode` | `selectionOnly` | 控制追加到 prompt 的编辑器上下文：`off`、`selectionOnly` 或 `nearby`。 |

## 上下文与隐私

Reasonix for VS Code 保持很窄的宿主边界：

- Webview 不能直接访问 shell、文件系统或网络。
- 编辑器上下文只会追加到 user turn，不进入 system prompt、tool schema 或稳定前缀。
- 普通聊天发送前，会先确认是否追加 active editor context。
- `Reasonix: Send Selection` 是显式发送 active selection 或 nearby cursor window 的命令。
- OutputChannel 日志会在展示前脱敏 active workspace 路径和 home 目录。

只有在排查协议问题时才建议打开 `reasonix.trace`，因为它会增加诊断输出。

## Diff 与审批审阅

对于 edit/write 类工具，扩展会优先使用 Reasonix ACP 后端提供的 preview。可用时，它会在审批前打开 VS Code diff preview。若无法可靠计算 diff，approval card 仍会展示工具 input，保证审批决策是显式的。

审批选项对应 Reasonix permission outcome：

- `Once`：允许本次工具调用。
- `Session`：本会话内允许匹配调用。
- `Always`：后端支持时持久化该权限。
- `Reject`：拒绝工具调用。

## 常见问题

### 找不到 Reasonix CLI

使用 `npm i -g reasonix` 安装 Reasonix，确认它在 `PATH` 中，或设置 `reasonix.binaryPath`。

### Chat view 显示 disconnected

执行 `Reasonix: Show Output` 查看 ACP 进程日志。可以用 `Reasonix: New Session` 重启。

### 模型列表或 effort 选择不可用

较旧的 ACP 后端可能没有实现可选的 `model/list` 或 `effort/set` 扩展方法。聊天主流程仍会使用已配置的默认模型正常工作。

### Diff preview 没有打开

某些编辑无法在执行前安全预览，例如二进制文件、非唯一替换或不支持的工具输入。允许前请审阅 approval card 中的 raw input。

## 开发

安装依赖并构建扩展：

```sh
npm install
npm run compile
```

常用检查：

```sh
npm run lint
npm test
npm run test:vscode
npm run smoke:acp
npm run debug:extension
```

打包 VSIX：

```sh
npm run package
```

`npm run test:vscode` 使用 `@vscode/test-electron` 和 fake ACP server，在不发起真实模型调用的前提下验证 extension activation、chat command flow、session startup、editor-context sending、webview `sendPrompt` 链路、slash command 展开、`@workspace/path` 文件与目录引用、MCP/Skill 工具更新、自动审批和可选 model-list 兜底。

`npm run smoke:acp` 会启动真实 `reasonix acp` 后端，只检查 `initialize`、`session/new` 以及可选的 `session/status` / `model/list` 兼容性，不发送 prompt，也不会调用真实模型。可以用 `REASONIX_BINARY=/absolute/path/to/reasonix` 指定 CLI；如果希望找不到 `reasonix` 时直接失败，设置 `REASONIX_ACP_SMOKE_REQUIRED=1`。

## 发布检查

- 运行 `npm run debug:extension && npm run package`。
- 确认 VSIX 包含 `dist/extension.js`、`media/webview.js`、`media/styles.css`、`media/icon.svg`、`scripts/acp-smoke.mjs`、`scripts/verify-vsix-contents.mjs`、`README.md`、`CHANGELOG.md`、`LICENSE` 和 `package.json`。
- 在 VS Code 或 Cursor 中安装 VSIX，并用真实 `reasonix acp` 后端跑一次手动 smoke test。

## License

MIT
