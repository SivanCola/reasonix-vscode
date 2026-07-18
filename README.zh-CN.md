# Reasonix for VS Code

<p align="center">
  <a href="./README.md">English</a>
  &nbsp;·&nbsp;
  <strong>简体中文</strong>
</p>

Reasonix for VS Code 把本地 Reasonix coding agent 带进编辑器。它实现 Reasonix 1.0（`main-v2`）使用的 ACP v1 客户端能力，扩展聚焦 IDE 宿主层：聊天、原生会话、编辑器资源、工具审阅、审批与提问、终端、模型、模式和计划。

本仓库是独立的 VS Code 扩展包仓库，不包含 Reasonix CLI 或上游 Reasonix 源码。

扩展默认不捆绑 Reasonix 二进制。它会优先使用 `reasonix.binaryPath`，未配置时再从 `PATH` 查找 `reasonix`。

## 功能亮点

- VS Code Activity Bar 聊天视图，由本地 `reasonix acp` 进程驱动。
- 原生 `session/list`、`load`、`resume`、`close`、`delete` 生命周期，并支持断线自动恢复。
- ACP 文件覆盖层可读取未保存缓冲区并执行受保护的 workspace edit；客户端终端会在 VS Code 内实时展示命令。
- 当前文件、选区、光标附近上下文与 `@` 引用通过当前 user turn 的 ACP resource block 发送。
- 普通聊天在追加编辑器上下文前会先确认。
- 工具调用卡片展示 raw input、执行结果和后端提供的 diff preview。
- 审批与结构化问题使用不同交互；Ask 问题永远不会被自动回答。
- 参考 Reasonix 桌面端的聊天界面：紧凑命令栏，以及由 ACP 会话轴驱动的独立“执行方式”“工作模式”和询问/自动/Yolo 工具权限菜单。
- 模型、推理强度、执行方式、工作模式和工具权限分别由对应的 ACP 会话 config/mode 接口驱动。
- 动态斜杠命令、结构化计划和可点击工具位置来自 `session/update`。
- 只有后端实际上报 usage/cache telemetry 时才显示对应指标。
- Reasonix OutputChannel 中会脱敏 workspace 路径和 home 目录。

## 环境要求

先安装并配置 Reasonix：

```sh
npm i -g reasonix
# 或：brew install esengine/reasonix/reasonix
```

如果 `reasonix` 不在 `PATH` 中，请把 `reasonix.binaryPath` 设置为 CLI 的绝对路径。

请使用 Reasonix 1.0 或更高版本。Reasonix 本身需要提前配置好 provider credentials 和要使用的模型。扩展会把模型执行、工具、权限、MCP 和 transcript 都委托给本地 Reasonix 后端。

## 快速开始

1. 在 VS Code 中打开一个 folder 或 multi-root workspace。
2. 打开 Reasonix Activity Bar 视图，或执行 `Reasonix: Open Chat`。
3. 打开聊天视图里的 `设置`，或执行 `Reasonix: Open Settings`，配置 CLI 路径、模型、语言、上下文模式、自动启动和 trace 日志。
4. 使用 `Reasonix: New Session` 或聊天视图里的 `+` 按钮启动新会话。
5. 输入 prompt，分别选择执行方式（常规/计划/目标）、工作模式（轻量/均衡/交付）和工具权限（询问/自动/Yolo），再通过发送按钮或 `Cmd/Ctrl+Enter` 发送。
6. 在 prompt 开头输入 `/`，打开当前 Reasonix 会话动态发布的命令菜单。
7. 输入 `@` 打开 workspace 文件和文件夹候选；选择 `@src/file.ts` 或 `@src/` 后，发送时会附加受限资源上下文。
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
| `Reasonix: Pick Effort` | 从会话 ACP config option 中选择推理强度。 |
| `Reasonix: Pick UI Language` | 在自动、英文和简体中文之间切换聊天 UI 语言。 |
| `Reasonix: Select CLI Binary` | 选择已安装的 Reasonix 可执行文件。 |
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
- 编辑器上下文和 `@` 引用只作为 user turn 的 ACP resource block，不进入 system prompt、tool schema 或稳定前缀。
- 文件回调要求 trusted workspace，解析符号链接后仍必须位于工作区内，并拒绝覆盖并发修改。
- 终端回调要求 trusted workspace，cwd 必须位于工作区内，在 VS Code 终端中实时展示，并限制输出缓存。
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

### 模型或 effort 选择不可用

当前会话没有发布对应的模型或 `thought_level` config option。聊天仍会使用已配置的默认模型。

### Diff preview 没有打开

某些编辑无法在执行前安全预览，例如二进制文件、非唯一替换或不支持的工具输入。允许前请审阅 approval card 中的 raw input。

## 开发

安装依赖并构建扩展：

```sh
npm install
npm run compile
```

打开一个加载最新本地构建的 VS Code Extension Development Host：

```sh
npm run dev:host
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

`npm run test:vscode` 使用 `@vscode/test-electron` 和 main-v2 形状的 fake ACP server，在不发起真实模型调用的前提下验证独立的执行/工作/权限轴、缓存稳定的原生 profile 切换、早到命令更新、原生 session、resource block、未保存缓冲区读取、受控写入、VS Code 终端、计划、工具位置、Ask、取消和断线恢复。

`npm run smoke:acp` 会启动真实 `reasonix acp` 后端，检查 capability、会话状态、列表、模式切换、关闭与清理，不发送 prompt，也不会调用真实模型。可以用 `REASONIX_BINARY=/absolute/path/to/reasonix` 指定 CLI；如果希望找不到 `reasonix` 时直接失败，设置 `REASONIX_ACP_SMOKE_REQUIRED=1`。

## 发布检查

- 运行 `npm run debug:extension && npm run package`。
- 确认 VSIX 包含 `dist/extension.js`、`media/webview.js`、`media/styles.css`、`media/icon.svg`、`scripts/acp-smoke.mjs`、`scripts/verify-vsix-contents.mjs`、`README.md`、`CHANGELOG.md`、`LICENSE` 和 `package.json`。
- 在 VS Code 或 Cursor 中安装 VSIX，并用真实 `reasonix acp` 后端跑一次手动 smoke test。

## License

MIT
