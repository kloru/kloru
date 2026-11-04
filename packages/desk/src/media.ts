/**
 * Images and files people text or email Kloru, kept by their content: `m_<sha256 prefix>.<ext>`
 * beside a small `.json` with its type, name and who sent it. Read from disk each time: the website
 * serves them from another process.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MediaItem {
  id: string;
  mime: string;
  name: string;
  size: number;
  at: string;
  /** Who sent it: only they (or the owner) may read it. */
  phone: string;
}

/** The only shape a media id can have, so a path can never come from outside. */
export const MEDIA_ID = /^m_[0-9a-f]{16}\.[a-z0-9]{1,5}$/;
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/ogg": "ogg", "audio/amr": "amr",
  "application/pdf": "pdf",
  "text/plain": "txt", "text/csv": "csv", "text/markdown": "md", "text/calendar": "ics", "text/vcard": "vcf", "text/x-vcard": "vcf",
  "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** The type for a served file, from its id's extension. */
export function mimeOfId(id: string): string {
  const ext = id.split(".").pop() ?? "";
  return Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
}

export class MediaStore {
  private readonly maxBytes: number;
  constructor(readonly dir: string, o: { maxBytes?: number } = {}) {
    this.maxBytes = o.maxBytes ?? MEDIA_MAX_BYTES;
  }

  put(bytes: Uint8Array, o: { mime: string; name: string; phone: string }): MediaItem {
    const mime = o.mime.split(";")[0]!.trim().toLowerCase();
    const ext = EXT[mime];
    if (!ext) throw new Error(`files of type ${mime || "unknown"} aren't kept`);
    if (bytes.length > this.maxBytes) throw new Error(`${o.name} is too large (${Math.round(bytes.length / 1e6)} MB; at most ${Math.round(this.maxBytes / 1e6)} MB)`);
    const id = `m_${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
    const known = this.get(id);
    if (known) return known.item;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, id), bytes, { mode: 0o600 });
    const item: MediaItem = { id, mime, name: o.name.slice(0, 200) || id, size: bytes.length, at: new Date().toISOString(), phone: o.phone };
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(item), { mode: 0o600 });
    return item;
  }

  get(id: string): { item: MediaItem; path: string } | undefined {
    if (!MEDIA_ID.test(id)) return undefined;
    const path = join(this.dir, id);
    const meta = join(this.dir, `${id}.json`);
    if (!existsSync(path) || !existsSync(meta)) return undefined;
    try {
      return { item: JSON.parse(readFileSync(meta, "utf8")) as MediaItem, path };
    } catch {
      return undefined;
    }
  }
}

/** How a photo or file appears in the conversation: `[photo m_….jpg]`, `[file m_….pdf: Quote.pdf]`. */
export function mediaNote(m: MediaItem): string {
  const kind = m.mime.startsWith("image/") ? "photo" : m.mime.startsWith("video/") ? "video" : m.mime.startsWith("audio/") ? "audio" : "file";
  return kind === "photo" ? `[photo ${m.id}]` : `[${kind} ${m.id}: ${m.name}]`;
}
