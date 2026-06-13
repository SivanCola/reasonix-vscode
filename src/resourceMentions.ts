import * as fs from "node:fs/promises";
import * as path from "node:path";

export type FileMention = {
  token: string;
  kind: "file" | "directory";
  relativePath: string;
  text: string;
  truncated: boolean;
};

const maxMentions = 5;
const maxFileBytes = 40_000;
const maxDirectoryEntries = 80;
const maxTokenLength = 240;

export async function appendFileMentions(prompt: string, workspacePath: string): Promise<{ prompt: string; mentions: FileMention[] }> {
  const mentions = await resolveFileMentions(prompt, workspacePath);
  if (mentions.length === 0) {
    return { prompt, mentions };
  }
  const blocks = mentions.map((mention) => [
    `<${mention.kind} path="${escapeAttribute(mention.relativePath)}"${mention.truncated ? " truncated=\"true\"" : ""}>`,
    mention.text,
    `</${mention.kind}>`,
  ].join("\n"));
  return {
    prompt: `${prompt.trimEnd()}\n\n<reasonix_file_mentions>\n${blocks.join("\n\n")}\n</reasonix_file_mentions>`,
    mentions,
  };
}

export async function resolveFileMentions(prompt: string, workspacePath: string): Promise<FileMention[]> {
  const seen = new Set<string>();
  const mentions: FileMention[] = [];
  for (const token of extractMentionTokens(prompt)) {
    if (mentions.length >= maxMentions) {
      break;
    }
    const relativePath = normalizeMentionPath(token);
    if (!relativePath || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    const absolutePath = path.resolve(workspacePath, relativePath);
    if (!isInsideWorkspace(absolutePath, workspacePath)) {
      continue;
    }
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.isFile()) {
        const buffer = await fs.readFile(absolutePath);
        const truncated = buffer.byteLength > maxFileBytes;
        mentions.push({
          token,
          kind: "file",
          relativePath,
          text: buffer.subarray(0, maxFileBytes).toString("utf8"),
          truncated,
        });
      } else if (stat.isDirectory()) {
        const entries = await fs.readdir(absolutePath, { withFileTypes: true });
        const sorted = entries
          .filter((entry) => entry.name !== ".DS_Store")
          .sort((a, b) => a.name.localeCompare(b.name));
        const visible = sorted.slice(0, maxDirectoryEntries);
        const truncated = sorted.length > visible.length;
        mentions.push({
          token,
          kind: "directory",
          relativePath,
          text: visible.map((entry) => directoryEntryLine(entry)).join("\n"),
          truncated,
        });
      }
    } catch {
      // Ignore unresolved @ tokens so ordinary mentions do not block sending.
    }
  }
  return mentions;
}

function extractMentionTokens(prompt: string): string[] {
  const tokens: string[] = [];
  const pattern = /(^|[\s([{])@([^\s)\]}>,;:"']+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt)) !== null) {
    const token = stripTrailingPunctuation(match[2] ?? "");
    if (token.length > 0 && token.length <= maxTokenLength) {
      tokens.push(token);
    }
  }
  return tokens;
}

function normalizeMentionPath(token: string): string | undefined {
  const decoded = decodeURIComponent(token);
  if (decoded.includes("\0") || path.isAbsolute(decoded)) {
    return undefined;
  }
  const normalized = path.normalize(decoded).replace(/\\/g, "/");
  const canonical = normalized.replace(/\/+$/g, "");
  if (canonical === "." || canonical.startsWith("../") || canonical === "..") {
    return undefined;
  }
  if (!looksLikePath(decoded) && !looksLikePath(canonical)) {
    return undefined;
  }
  return canonical.startsWith("./") ? canonical.slice(2) : canonical;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes(".") || value.startsWith("./");
}

function isInsideWorkspace(absolutePath: string, workspacePath: string): boolean {
  const relative = path.relative(path.resolve(workspacePath), absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,!?]+$/g, "");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function directoryEntryLine(entry: import("node:fs").Dirent): string {
  if (entry.isDirectory()) {
    return `${entry.name}/`;
  }
  if (entry.isSymbolicLink()) {
    return `${entry.name}@`;
  }
  return entry.name;
}
