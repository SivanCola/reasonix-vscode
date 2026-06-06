# Reasonix for VS Code

Reasonix for VS Code connects the editor to the local `reasonix acp` agent. The extension provides a native chat view, workspace-scoped sessions, tool-call rendering, permission prompts, cancellation, and editor-selection context.

## Requirements

Install the Reasonix CLI first:

```sh
npm i -g reasonix
```

Set `reasonix.binaryPath` if `reasonix` is not available on PATH.

## Development

```sh
npm install
npm run compile
npm test
```

Open this folder in VS Code and press F5 to start an Extension Development Host.
