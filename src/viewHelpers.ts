import type { ChangePreview } from "./acpTypes";

export function cachePercent(hit: number, miss: number): string {
  const total = hit + miss;
  if (total <= 0) {
    return "n/a";
  }
  return `${Math.round((hit / total) * 100)}%`;
}

export function cacheLabel(hit: number, miss: number): string {
  const total = hit + miss;
  if (total <= 0) {
    return "n/a";
  }
  return `${Math.round((hit / total) * 100)}% (${formatNumber(hit)} cached / ${formatNumber(miss)} new)`;
}

export function getRiskLabel(kind: string): string {
  switch (kind) {
    case "execute":
    case "bash":
    case "shell":
      return "High";
    case "edit":
    case "write":
    case "multi_edit":
      return "Medium";
    case "read":
    case "search":
    case "grep":
      return "Low";
    default:
      return "Info";
  }
}

export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) {
    return "diff-hunk";
  }
  if (line.startsWith("+")) {
    return "diff-added";
  }
  if (line.startsWith("-")) {
    return "diff-removed";
  }
  return "diff-context";
}

export function toolIcon(kind: string): string {
  switch (kind) {
    case "read":
      return "codicon-book";
    case "edit":
    case "write":
      return "codicon-edit";
    case "search":
    case "grep":
      return "codicon-search";
    case "execute":
    case "bash":
    case "shell":
      return "codicon-terminal";
    default:
      return "codicon-tools";
  }
}

export function approvalLabel(option: { name: string; kind: string }): string {
  switch (option.kind) {
    case "allow_once":
      return "Once";
    case "allow_always":
      return "Session";
    case "allow_persistent":
      return "Always";
    default:
      return option.name;
  }
}

export function approvalButtonMap(options: Array<{ optionId: string; name: string; kind: string }>): {
  hasOnce: boolean;
  hasSession: boolean;
  hasAlways: boolean;
} {
  const kinds = new Set(options.map((o) => o.kind));
  return {
    hasOnce: kinds.has("allow_once"),
    hasSession: kinds.has("allow_always"),
    hasAlways: kinds.has("allow_persistent"),
  };
}

export function contextModeLabel(mode: string): string {
  switch (mode) {
    case "off":
      return "No context";
    case "selectionOnly":
      return "Selection";
    case "nearby":
      return "Nearby";
    default:
      return mode.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
}

export function modelDisplayLabel(label: string): string {
  return label === "Default model" ? "Default" : label;
}

export function targetPath(preview: ChangePreview | undefined | null): string {
  if (!preview || !preview.path) {
    return "";
  }
  return preview.path;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
