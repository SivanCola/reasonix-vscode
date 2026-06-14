import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";

export type ResourceSuggestion = {
  kind: "file" | "directory";
  relativePath: string;
  insertText: string;
  label: string;
  detail: string;
};

const maxQueryLength = 240;
const maxVisitedEntries = 2500;
const maxScanDepth = 6;
const ignoredDirectoryNames = new Set([".git", ".reasonix", ".codegraph", "node_modules", "dist", "out"]);

type ScannedResource = {
  kind: "file" | "directory";
  relativePath: string;
};

export async function suggestWorkspaceResources(query: string, workspacePath: string, limit = 8): Promise<ResourceSuggestion[]> {
  const root = path.resolve(workspacePath);
  const normalizedQuery = normalizeSuggestionQuery(query);
  if (normalizedQuery.endsWith("/")) {
    return listDirectoryChildren(root, normalizedQuery, limit);
  }

  const scanned = normalizedQuery === ""
    ? await readDirectory(root, root, "")
    : await scanWorkspace(root);
  const ranked = scanned
    .map((resource) => ({ resource, rank: resourceRank(resource, normalizedQuery) }))
    .filter((entry) => entry.rank < Number.POSITIVE_INFINITY)
    .sort((a, b) => a.rank - b.rank || kindRank(a.resource.kind) - kindRank(b.resource.kind) || a.resource.relativePath.localeCompare(b.resource.relativePath))
    .slice(0, limit)
    .map((entry) => toSuggestion(entry.resource));
  return ranked;
}

function normalizeSuggestionQuery(value: string): string {
  const normalized = value
    .slice(0, maxQueryLength)
    .replace(/\\/g, "/")
    .replace(/^@/, "")
    .replace(/^\/+/g, "")
    .replace(/^\.\//, "");
  return normalized.includes("\0") ? "" : normalized;
}

async function listDirectoryChildren(root: string, query: string, limit: number): Promise<ResourceSuggestion[]> {
  const directoryPath = path.resolve(root, query);
  if (!isInsideWorkspace(directoryPath, root)) {
    return [];
  }
  const relativeDirectory = path.relative(root, directoryPath).replace(/\\/g, "/");
  const resources = await readDirectory(root, directoryPath, relativeDirectory === "" ? "" : relativeDirectory);
  return resources
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.relativePath.localeCompare(b.relativePath))
    .slice(0, limit)
    .map((resource) => toSuggestion(resource));
}

async function scanWorkspace(root: string): Promise<ScannedResource[]> {
  const resources: ScannedResource[] = [];
  const queue: { directory: string; depth: number }[] = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < maxVisitedEntries) {
    const current = queue.shift();
    if (!current || current.depth > maxScanDepth) {
      continue;
    }
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > maxVisitedEntries || entry.name === ".DS_Store") {
        continue;
      }
      const absolutePath = path.join(current.directory, entry.name);
      const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
      if (!relativePath || !isInsideWorkspace(absolutePath, root)) {
        continue;
      }
      if (entry.isDirectory()) {
        resources.push({ kind: "directory", relativePath });
        if (!ignoredDirectoryNames.has(entry.name)) {
          queue.push({ directory: absolutePath, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        resources.push({ kind: "file", relativePath });
      }
    }
  }
  return resources;
}

async function readDirectory(root: string, directory: string, relativeDirectory: string): Promise<ScannedResource[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.name !== ".DS_Store" && !(relativeDirectory === "" && entry.isDirectory() && ignoredDirectoryNames.has(entry.name)))
    .map((entry): ScannedResource | undefined => {
      const absolutePath = path.join(directory, entry.name);
      if (!isInsideWorkspace(absolutePath, root)) {
        return undefined;
      }
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        return { kind: "directory", relativePath };
      }
      if (entry.isFile()) {
        return { kind: "file", relativePath };
      }
      return undefined;
    })
    .filter((entry): entry is ScannedResource => entry !== undefined);
}

function resourceRank(resource: ScannedResource, query: string): number {
  if (query === "") {
    return kindRank(resource.kind);
  }
  const pathText = resource.relativePath.toLowerCase();
  const queryText = query.toLowerCase();
  const baseName = path.posix.basename(pathText);
  const queryBaseName = path.posix.basename(queryText);
  if (pathText === queryText) {
    return 0;
  }
  if (pathText.startsWith(queryText)) {
    return 1;
  }
  if (baseName.startsWith(queryBaseName)) {
    return 2;
  }
  if (pathText.includes(queryText)) {
    return 3;
  }
  return Number.POSITIVE_INFINITY;
}

function toSuggestion(resource: ScannedResource): ResourceSuggestion {
  const insertText = resource.kind === "directory" ? `${resource.relativePath}/` : resource.relativePath;
  return {
    kind: resource.kind,
    relativePath: resource.relativePath,
    insertText,
    label: path.posix.basename(resource.relativePath) || resource.relativePath,
    detail: insertText,
  };
}

function kindRank(kind: "file" | "directory"): number {
  return kind === "directory" ? 0 : 1;
}

function isInsideWorkspace(absolutePath: string, workspacePath: string): boolean {
  const relative = path.relative(path.resolve(workspacePath), absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
