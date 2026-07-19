import type { ContentBlock } from "./acpTypes";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_TEXT_BYTES = 40_000;
export const MAX_ATTACHMENT_IMAGE_BYTES = 2_000_000;

export interface PendingAttachment {
  kind: "file" | "image" | "session";
  name: string;
  uri?: string;
  mimeType?: string;
  sessionId?: string;
}

export type ReadFileBytes = (uri: string) => Promise<Uint8Array>;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp"
};

export function mimeFromFileName(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return IMAGE_MIME_BY_EXT[ext] ?? "text/plain";
}

export function isImageMime(mimeType: string | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

export function isPendingAttachment(value: unknown): value is PendingAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const kindOk = candidate.kind === "file" || candidate.kind === "image" || candidate.kind === "session";
  if (!kindOk || typeof candidate.name !== "string" || candidate.name.length === 0) {
    return false;
  }
  if (candidate.kind === "session") {
    return typeof candidate.sessionId === "string" && candidate.sessionId.length > 0;
  }
  return typeof candidate.uri === "string" && candidate.uri.length > 0;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Converts a pending attachment into an ACP prompt content block.
 * File contents are read lazily at send time via the injected readFile.
 */
export async function attachmentToBlock(
  attachment: PendingAttachment,
  readFile: ReadFileBytes
): Promise<ContentBlock> {
  if (attachment.kind === "session") {
    return {
      type: "resource",
      resource: {
        uri: `session://${attachment.sessionId}`,
        mimeType: "text/plain",
        text: `Referenced session: ${attachment.name} (session ${attachment.sessionId})`
      }
    };
  }

  const uri = attachment.uri ?? "";
  const mimeType = attachment.mimeType ?? mimeFromFileName(attachment.name);
  const bytes = await readFile(uri);

  if (attachment.kind === "image" || isImageMime(mimeType)) {
    if (bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) {
      throw new Error(`Image too large: ${attachment.name} (${bytes.length} bytes)`);
    }
    return { type: "image", data: toBase64(bytes), mimeType };
  }

  const truncated = bytes.length > MAX_ATTACHMENT_TEXT_BYTES;
  const slice = truncated ? bytes.subarray(0, MAX_ATTACHMENT_TEXT_BYTES) : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return {
    type: "resource",
    resource: {
      uri,
      mimeType: "text/plain",
      text: `File: ${attachment.name}${truncated ? " (truncated)" : ""}\n${text}`
    }
  };
}
