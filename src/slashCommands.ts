export type SlashExpansion = {
  prompt: string;
  command?: string;
};

type SlashCommand = {
  names: string[];
  build: (args: string) => string;
};

const commands: SlashCommand[] = [
  {
    names: ["help", "?"],
    build: () => [
      "List the built-in Reasonix VS Code slash commands and when to use them.",
      "",
      "Commands: /explain, /fix, /tests, /search, /mcp, /skills.",
    ].join("\n"),
  },
  {
    names: ["explain"],
    build: (args) => withRequest(
      "Explain the referenced code, file, or workspace area. Focus on purpose, important flows, and risky edges.",
      args,
    ),
  },
  {
    names: ["fix"],
    build: (args) => withRequest(
      "Fix the referenced issue or code. Keep the change focused, preserve existing behavior, and explain what changed.",
      args,
    ),
  },
  {
    names: ["tests", "test"],
    build: (args) => withRequest(
      "Run or identify the relevant tests for this workspace. If failures appear, diagnose the likely cause and propose the smallest fix.",
      args,
    ),
  },
  {
    names: ["search"],
    build: (args) => withRequest(
      "Search the repository for the referenced implementation, summarize what you find, and point to the key files.",
      args,
    ),
  },
  {
    names: ["mcp"],
    build: (args) => withRequest(
      "Inspect the connected MCP context and use MCP tools only when they are relevant to the request. Summarize which MCP server or tool was useful.",
      args,
    ),
  },
  {
    names: ["skills", "skill"],
    build: (args) => withRequest(
      "Use the appropriate Reasonix/Codex skills for this request if they are available. State which skill is relevant and what it contributes.",
      args,
    ),
  },
];

export function expandSlashCommand(input: string): SlashExpansion {
  const trimmedStart = input.trimStart();
  if (!trimmedStart.startsWith("/")) {
    return { prompt: input };
  }
  const match = /^\/([A-Za-z0-9_-]+|\?)(?:\s+([\s\S]*))?$/.exec(trimmedStart);
  if (!match) {
    return { prompt: input };
  }
  const name = (match[1] ?? "").toLowerCase();
  const args = (match[2] ?? "").trim();
  const command = commands.find((candidate) => candidate.names.includes(name));
  if (!command) {
    return { prompt: input };
  }
  return { prompt: command.build(args), command: name };
}

function withRequest(instruction: string, args: string): string {
  if (args === "") {
    return instruction;
  }
  return `${instruction}\n\nUser request:\n${args}`;
}
