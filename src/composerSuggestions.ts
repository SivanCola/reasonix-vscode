import { listSlashCommands, type SlashCommandInfo } from "./slashCommands";

export type ComposerTrigger = {
  kind: "slash" | "resource";
  start: number;
  end: number;
  query: string;
};

export type SlashSuggestion = SlashCommandInfo & {
  insertText: string;
  detail: string;
};

const zhSlashDescriptions: Record<string, string> = {
  help: "查看内置 Reasonix 斜杠命令。",
  explain: "解释代码、文件或工作区区域。",
  fix: "修复指定问题或代码区域。",
  tests: "运行、定位或诊断相关测试。",
  search: "搜索仓库并总结关键文件。",
  mcp: "检查 MCP 上下文并使用相关工具。",
  skills: "使用合适的 Reasonix/Codex 技能。",
};

export function getComposerTrigger(value: string, selectionStart: number, selectionEnd = selectionStart): ComposerTrigger | undefined {
  if (selectionStart !== selectionEnd || selectionStart < 0 || selectionStart > value.length) {
    return undefined;
  }
  const beforeCaret = value.slice(0, selectionStart);

  const slash = /^(\s*)\/([A-Za-z0-9_-]*)$/.exec(beforeCaret);
  if (slash) {
    return {
      kind: "slash",
      start: slash[1]?.length ?? 0,
      end: selectionStart,
      query: slash[2] ?? "",
    };
  }

  const mention = /(^|[\s([{])@([^\s)\]}>,;:"']*)$/.exec(beforeCaret);
  if (!mention) {
    return undefined;
  }
  const prefix = mention[1] ?? "";
  const query = mention[2] ?? "";
  return {
    kind: "resource",
    start: mention.index + prefix.length,
    end: selectionStart,
    query,
  };
}

export function replaceComposerTrigger(value: string, trigger: ComposerTrigger, insertText: string): { value: string; cursor: number } {
  const before = value.slice(0, trigger.start);
  const after = value.slice(trigger.end);
  const token = trigger.kind === "resource" ? `@${insertText}` : insertText.startsWith("/") ? insertText : `/${insertText}`;
  const replacement = /^\s/.test(after) ? token : `${token} `;
  const nextValue = `${before}${replacement}${after}`;
  return {
    value: nextValue,
    cursor: before.length + replacement.length,
  };
}

export function slashSuggestions(query: string, locale: string, limit = 8): SlashSuggestion[] {
  const normalized = query.replace(/^\//, "").toLowerCase();
  const localized = locale.toLowerCase().startsWith("zh") ? zhSlashDescriptions : undefined;
  return listSlashCommands()
    .map((command, index) => {
      const detail = localized?.[command.name] ?? command.description;
      return {
        suggestion: {
          ...command,
          detail,
          insertText: `/${command.name}`,
        },
        index,
      };
    })
    .filter((entry) => matchesSlashCommand(entry.suggestion, normalized))
    .sort((a, b) => slashRank(a.suggestion, normalized) - slashRank(b.suggestion, normalized) || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.suggestion);
}

function matchesSlashCommand(command: SlashSuggestion, query: string): boolean {
  if (query === "") {
    return true;
  }
  return slashTerms(command).some((term) => term.includes(query));
}

function slashRank(command: SlashSuggestion, query: string): number {
  if (query === "") {
    return 0;
  }
  const terms = slashTerms(command);
  if (terms.some((term) => term === query)) {
    return 0;
  }
  if (terms.some((term) => term.startsWith(query))) {
    return 1;
  }
  return 2;
}

function slashTerms(command: SlashSuggestion): string[] {
  return [command.name, ...command.aliases, command.detail].map((value) => value.toLowerCase());
}
