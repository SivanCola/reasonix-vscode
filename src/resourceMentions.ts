import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentBlock } from "./acpTypes";

export type FileMention = {
  token: string;
  kind: "file" | "directory";
  relativePath: string;
  text: string;
  truncated: boolean;
};

const maxMentions = 5;
const maxFileBytes = 40_000;
const maxTotalBytes = 120_000;
const maxDirectoryEntries = 80;
const maxTokenLength = 240;

/**
 * Characters that would break the @ mention token grammar used by
 * extractMentionTokens: whitespace plus the token exclusion set, and "%"
 * (a raw percent could corrupt decodeURIComponent in normalizeMentionPath).
 */
const MENTION_TOKEN_BREAKERS = /[\s"')\]}>;,:]|%/;

/**
 * Builds a readable @ mention token for a workspace-relative path. Paths
 * containing characters that would break the mention token grammar
 * (whitespace, quotes, brackets, "%") are wrapped in double (or single)
 * quotes so they stay fully human-readable in the composer. Percent
 * encoding is only a last resort for paths containing every quote style.
 * The workspace root itself and extensionless root-level files get a
 * "./" prefix so the resolver accepts them.
 */
export function mentionTokenForPath(relativePath: string, isDirectory: boolean): string {
  if (relativePath === "") {
    return "./"; // workspace root directory listing
  }
  const base = relativePath.includes("/") || relativePath.includes(".") ? relativePath : `./${relativePath}`;
  const path = isDirectory ? `${base}/` : base;
  if (!MENTION_TOKEN_BREAKERS.test(path)) {
    return path;
  }
  if (path.includes("%")) {
    return percentEncodeToken(path);
  }
  if (!path.includes('"')) {
    return `"${path}"`;
  }
  if (!path.includes("'")) {
    return `'${path}'`;
  }
  return percentEncodeToken(path);
}

function percentEncodeToken(path: string): string {
  return path
    .split("")
    .map((ch) => (MENTION_TOKEN_BREAKERS.test(ch) ? percentEncodeChar(ch) : ch))
    .join("");
}

/**
 * Percent-encodes a single character at the byte level. encodeURIComponent
 * is not used because it leaves URI reserved characters such as ' ( ) that
 * still break the mention token grammar.
 */
function percentEncodeChar(ch: string): string {
  return Array.from(new TextEncoder().encode(ch))
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

export async function buildPromptBlocks(prompt: string, workspacePath: string): Promise<{ blocks: ContentBlock[]; mentions: FileMention[] }> {
  const mentions = await resolveFileMentions(prompt, workspacePath);
  const resources: ContentBlock[] = mentions.map((mention) => ({
    type: "resource",
    resource: {
      uri: pathToFileURL(path.resolve(workspacePath, mention.relativePath)).toString(),
      mimeType: "text/plain",
      text: mention.kind === "file"
        ? `File: ${mention.relativePath}${mention.truncated ? " (truncated)" : ""}\n${mention.text}`
        : `Directory: ${mention.relativePath}${mention.truncated ? " (truncated)" : ""}\n${mention.text}`,
    },
  }));
  return { blocks: [{ type: "text", text: prompt }, ...resources], mentions };
}

export async function resolveFileMentions(prompt: string, workspacePath: string): Promise<FileMention[]> {
  const seen = new Set<string>();
  const mentions: FileMention[] = [];
  let remainingBytes = maxTotalBytes;
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
      const realPath = await fs.realpath(absolutePath);
      if (!isInsideWorkspace(realPath, await fs.realpath(workspacePath))) {
        continue;
      }
      const stat = await fs.stat(realPath);
      if (stat.isFile()) {
        const buffer = await fs.readFile(realPath);
        const allowed = Math.max(0, Math.min(maxFileBytes, remainingBytes));
        if (allowed === 0) {
          break;
        }
        const truncated = buffer.byteLength > allowed;
        const visible = buffer.subarray(0, allowed);
        mentions.push({
          token,
          kind: "file",
          relativePath,
          text: visible.toString("utf8"),
          truncated,
        });
        remainingBytes -= visible.byteLength;
      } else if (stat.isDirectory()) {
        const entries = await fs.readdir(realPath, { withFileTypes: true });
        const sorted = entries
          .filter((entry) => entry.name !== ".DS_Store")
          .sort((a, b) => a.name.localeCompare(b.name));
        const visible = sorted.slice(0, maxDirectoryEntries);
        const truncated = sorted.length > visible.length;
        const text = visible.map((entry) => directoryEntryLine(entry)).join("\n");
        const buffer = Buffer.from(text, "utf8");
        const allowed = Math.max(0, remainingBytes);
        if (allowed === 0) {
          break;
        }
        const visibleBuffer = buffer.subarray(0, allowed);
        mentions.push({
          token,
          kind: "directory",
          relativePath,
          text: visibleBuffer.toString("utf8"),
          truncated: truncated || buffer.byteLength > allowed,
        });
        remainingBytes -= visibleBuffer.byteLength;
      }
    } catch {
      // Ignore unresolved @ tokens so ordinary mentions do not block sending.
    }
  }
  return mentions;
}

function extractMentionTokens(prompt: string): string[] {
  const tokens: string[] = [];
  const pattern = /(^|[\s([{])@(?:"([^"\n]{1,240})"|'([^'\n]{1,240})'|([^\s)\]}>,;:"']+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt)) !== null) {
    const quoted = match[2] ?? match[3];
    const raw = quoted ?? match[4] ?? "";
    const token = quoted ? raw : stripTrailingPunctuation(raw);
    if (token.length > 0 && token.length <= maxTokenLength) {
      tokens.push(token);
    }
  }
  return tokens;
}

function normalizeMentionPath(token: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || path.isAbsolute(decoded)) {
    return undefined;
  }
  const normalized = path.normalize(decoded).replace(/\\/g, "/");
  const canonical = normalized.replace(/\/+$/g, "");
  if (canonical === ".") {
    // The workspace root itself: listing it is useful for drag/drop and explorer additions.
    return "";
  }
  if (canonical.startsWith("../") || canonical === "..") {
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

function directoryEntryLine(entry: import("node:fs").Dirent): string {
  if (entry.isDirectory()) {
    return `${entry.name}/`;
  }
  if (entry.isSymbolicLink()) {
    return `${entry.name}@`;
  }
  return entry.name;
}
