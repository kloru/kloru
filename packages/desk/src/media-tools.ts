/**
 * media_read: a worker looks at a photo or file someone sent (images as images, text and PDFs as
 * text), only for the person who sent it or the owner. Pages embed them as ![name](/m/<id>).
 * media_keep: a file a worker made, or an image on the web, kept as the caller's, so it can be sent
 * to them (send_to_caller) or shown on a page.
 */
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { defineTool, fetchPublic, textResult, type Lookup, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import type { Desk } from "./desk.js";
import { MEDIA_MAX_BYTES, mimeOfId, type MediaStore } from "./media.js";

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const TEXT_MAX = 60_000;

export function mediaTools(desk: Desk, store: MediaStore, o: { workspaceDir?: string; fetchImpl?: typeof fetch; lookup?: Lookup } = {}): RegisteredTool[] {
  return [
    defineTool({
      name: "media_read",
      label: "Look at a photo or file",
      description: "Look at a photo or file someone sent ([photo m_…] or [file m_…] in the conversation), by id. Embed it in a page as ![name](/m/<id>).",
      parameters: Type.Object({ id: Type.String({ description: "e.g. m_0123456789abcdef.jpg" }) }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id }, ctx) => {
        const issue = desk.repo.issue(Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN));
        if (!issue) return failed("Only desk workers can read media.");
        const got = store.get(id);
        if (!got || !desk.mayReadMedia(got.item.phone, issue.filedBy.phone)) return failed(`no media ${id} for this caller`);
        const { item, path } = got;
        const head = `${item.name} (${item.mime}, ${Math.max(1, Math.round(item.size / 1024))} KB, /m/${item.id})`;
        if (item.mime.startsWith("image/") && item.mime !== "image/svg+xml" && item.mime !== "image/heic" && item.mime !== "image/heif") {
          return { content: [{ type: "text" as const, text: head }, { type: "image" as const, data: readFileSync(path).toString("base64"), mimeType: item.mime }] };
        }
        if (item.mime.startsWith("text/") || item.mime === "image/svg+xml") return textResult(`${head}\n\n${readFileSync(path, "utf8").slice(0, TEXT_MAX)}`);
        if (item.mime === "application/pdf") {
          try {
            return textResult(`${head}\n\n${(await pdfText(path)).slice(0, TEXT_MAX)}`);
          } catch (error) {
            return textResult(`${head}\n\nCouldn't read its text (${error instanceof Error ? error.message : String(error)}); it can still go on a page.`);
          }
        }
        return textResult(`${head}\n\nThis kind of file can't be read here; it can go on a page as a download or player.`);
      },
    }),
    defineTool({
      name: "media_keep",
      label: "Keep a file or web image to send",
      description: "Keep a file you made (a workspace path) or an image on the web (an https URL), so you can send it with send_to_caller or show it on a page. Returns its id.",
      parameters: Type.Object({ source: Type.String({ description: "e.g. art/plan.png or https://example.com/photo.jpg" }) }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ source }, ctx) => {
        const issue = desk.repo.issue(Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN));
        if (!issue) return failed("Only desk workers can keep media.");
        try {
          const web = /^https:\/\//i.test(source.trim());
          // The workspace is the owner's (their files, everyone's inbound attachments): only their workers keep from it.
          if (!web && !desk.isOwner(issue.filedBy.phone)) return failed("Only the owner's files can be kept from the workspace; use an https image, or a photo they sent you.");
          const got = web ? await fromWeb(source.trim(), o) : fromWorkspace(source.trim(), o.workspaceDir);
          const item = store.put(got.bytes, { mime: got.mime, name: got.name, phone: issue.filedBy.phone });
          return textResult(`Kept ${item.name} as ${item.id}. Send it with send_to_caller (media: ["${item.id}"]) or show it on a page as ![${item.name}](/m/${item.id}).`);
        } catch (error) {
          return failed(`Couldn't keep ${source}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
  ];
}

interface Got {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

/** A file inside the workspace (never outside it, even through a link), typed by its extension. */
function fromWorkspace(source: string, workspaceDir: string | undefined): Got {
  if (!workspaceDir) throw new Error("there's no workspace here");
  if (isAbsolute(source)) throw new Error("give a path inside the workspace");
  const root = realpathSync(workspaceDir);
  const path = realpathSync(resolve(root, source));
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("that's outside the workspace");
  if (statSync(path).size > MEDIA_MAX_BYTES) throw new Error("it's too large");
  const name = basename(path);
  const ext = (name.split(".").pop() ?? "").toLowerCase().replace(/^jpeg$/, "jpg");
  return { bytes: readFileSync(path), mime: mimeOfId(`m_.${ext}`), name };
}

/** An image (or file) on the public web, through the same guard as every outside fetch. */
async function fromWeb(url: string, o: { fetchImpl?: typeof fetch; lookup?: Lookup }): Promise<Got> {
  const got = await fetchPublic(o.fetchImpl ?? fetch, url, { signal: AbortSignal.timeout(30_000), headers: { accept: "image/*,*/*" }, ...(o.lookup ? { lookup: o.lookup } : {}) });
  if (!got.ok) throw new Error(`can't download it: ${got.reason}`);
  if (!got.res.ok) throw new Error(`download failed: HTTP ${got.res.status}`);
  if (Number(got.res.headers.get("content-length")) > MEDIA_MAX_BYTES) throw new Error("it's too large");
  const bytes = await capped(got.res, MEDIA_MAX_BYTES);
  const name = decodeURIComponent(got.target.pathname.split("/").pop() || "image");
  return { bytes, mime: got.res.headers.get("content-type") ?? "application/octet-stream", name };
}

/**
 * A PDF's text, read in its own short-lived process: these files come from strangers, and a bad one
 * can only stall or crash that process. (The library file itself: the package's index reads a test PDF.)
 * The bytes are copied: Node 22 reads a small file into its shared buffer pool, and the library reads
 * the whole pool instead of the file ("bad XRef entry").
 */
function pdfText(path: string): Promise<string> {
  const lib = createRequire(import.meta.url).resolve("pdf-parse/lib/pdf-parse.js");
  const script = `require(process.argv[1])(new Uint8Array(require("fs").readFileSync(process.argv[2]))).then((r) => process.stdout.write(r.text), (e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); })`;
  return new Promise((resolve, reject) =>
    execFile(process.execPath, ["-e", script, lib, path], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()))),
  );
}

/** The body, but never more than max bytes held: a stream without a length can't fill memory. */
async function capped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("it's too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.length));
  return out;
}
