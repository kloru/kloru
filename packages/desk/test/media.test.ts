/**
 * Images and files people text or email Kloru: kept by content in a media store, readable by the
 * desk's workers (images as images), embeddable in pages as /m/<id>.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { MediaStore, mediaNote } from "../src/media.js";
import { mediaTools } from "../src/media-tools.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const EZRA = "+14155550190";
const CLEO = "+14155550191";

describe("the media store", () => {
  it("keeps a file by its content: the same bytes get the same id, with an extension from its type", () => {
    const store = new MediaStore(mkdtempSync(join(tmpdir(), "media-")));
    const a = store.put(PNG, { mime: "image/png", name: "receipt.png", phone: EZRA });
    expect(a.id).toMatch(/^m_[0-9a-f]{16}\.png$/);
    expect(store.put(PNG, { mime: "image/png", name: "again.png", phone: EZRA }).id).toBe(a.id);
    expect(store.get(a.id)).toMatchObject({ item: { mime: "image/png", name: "receipt.png", size: PNG.length } });
    expect(store.get("../etc/passwd")).toBeUndefined();
  });

  it("refuses types outside the list, and anything over the size cap", () => {
    const store = new MediaStore(mkdtempSync(join(tmpdir(), "media-")), { maxBytes: 10 });
    expect(() => store.put(PNG, { mime: "image/png", name: "big.png", phone: EZRA })).toThrow(/too large/);
    const open = new MediaStore(mkdtempSync(join(tmpdir(), "media-")));
    expect(() => open.put(PNG, { mime: "application/x-msdownload", name: "x.exe", phone: EZRA })).toThrow(/type/);
  });

  it("notes a photo or a file the way it appears in a conversation", () => {
    expect(mediaNote({ id: "m_0123456789abcdef.jpg", mime: "image/jpeg", name: "IMG_1.jpg", size: 1, at: "", phone: EZRA })).toBe("[photo m_0123456789abcdef.jpg]");
    expect(mediaNote({ id: "m_0123456789abcdef.pdf", mime: "application/pdf", name: "Quote.pdf", size: 1, at: "", phone: EZRA })).toBe("[file m_0123456789abcdef.pdf: Quote.pdf]");
  });
});

class Host implements WorkerHost {
  run(_i: number, _r: WorkerRole): Promise<string> {
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}
class PM implements Planner {
  async handle(_: Trigger[]): Promise<void> {}
}

describe("media_read", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "media-desk-"));
    const desk = new Desk({ root, host: new Host(), planner: new PM(), ownerPhone: EZRA, isMember: (p) => p === CLEO });
    const store = new MediaStore(join(root, "media"));
    const [read] = mediaTools(desk, store);
    return { desk, store, read: read! };
  }
  const ctx = (issue: number) => ({ conversationKey: `desk:issue:${issue}:engineer` }) as never;

  it("an image comes back as an image the worker can see; text comes back as text", async () => {
    const { desk, store, read } = setup();
    const { call } = desk.startCall({ callSid: "imessage:1", phone: EZRA, channel: "imessage" });
    const issue = desk.fileIssue(call.id, "What's on this receipt?");
    const img = store.put(PNG, { mime: "image/png", name: "r.png", phone: EZRA });
    const out = (await read.spec.execute({ id: img.id }, ctx(issue.id))) as { content: Array<{ type: string; mimeType?: string }> };
    expect(out.content.some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
    const note = store.put(new TextEncoder().encode("Pick up at 5"), { mime: "text/plain", name: "n.txt", phone: EZRA });
    expect(JSON.stringify(await read.spec.execute({ id: note.id }, ctx(issue.id)))).toContain("Pick up at 5");
  });

  it("a PDF comes back as its text", async () => {
    const { desk, store, read } = setup();
    const { call } = desk.startCall({ callSid: "imessage:3", phone: EZRA, channel: "imessage" });
    const issue = desk.fileIssue(call.id, "What's the total on this quote?");
    const pdf = store.put(Uint8Array.from(Buffer.from("JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDgwIFRkIChRdW90ZSB0b3RhbCAxMjM0IGRvbGxhcnMpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzQ1IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDE1CiUlRU9GCg==", "base64")), { mime: "application/pdf", name: "Quote.pdf", phone: EZRA });
    expect(JSON.stringify(await read.spec.execute({ id: pdf.id }, ctx(issue.id)))).toContain("Quote total 1234 dollars");
  });

  it("a member can't read media someone else sent", async () => {
    const { desk, store, read } = setup();
    const img = store.put(PNG, { mime: "image/png", name: "r.png", phone: EZRA });
    const { call } = desk.startCall({ callSid: "imessage:2", phone: CLEO, channel: "imessage" });
    const hers = desk.fileIssue(call.id, "Show me Ezra's photo");
    expect((await read.spec.execute({ id: img.id }, ctx(hers.id))) as { isError?: boolean }).toMatchObject({ isError: true });
  });
});

describe("media_keep", () => {
  function setup(fetchImpl?: typeof fetch, phone = CLEO) {
    const root = mkdtempSync(join(tmpdir(), "media-keep-"));
    const workspaceDir = join(root, "workspace");
    mkdirSync(join(workspaceDir, "art"), { recursive: true });
    writeFileSync(join(workspaceDir, "art", "plan.png"), PNG);
    writeFileSync(join(root, "secret.png"), PNG);
    const desk = new Desk({ root, host: new Host(), planner: new PM(), ownerPhone: EZRA, isMember: (p) => p === CLEO });
    const store = new MediaStore(join(root, "media"));
    const keep = mediaTools(desk, store, { workspaceDir, ...(fetchImpl ? { fetchImpl, lookup: async () => ["93.184.216.34"] } : {}) }).find((t) => t.spec.name === "media_keep")!;
    const { call } = desk.startCall({ callSid: "imessage:k", phone, channel: "imessage" });
    const issue = desk.fileIssue(call.id, "Send me the floor plan");
    return { store, keep, issue };
  }
  const ctx = (issue: number) => ({ conversationKey: `desk:issue:${issue}:engineer` }) as never;
  const text = (r: unknown) => JSON.stringify(r);

  it("a file the owner's worker made is kept as theirs, with how to send it", async () => {
    const { store, keep, issue } = setup(undefined, EZRA);
    const out = text(await keep.spec.execute({ source: "art/plan.png" }, ctx(issue.id)));
    const id = /m_[0-9a-f]{16}\.png/.exec(out)![0];
    expect(store.get(id)!.item).toMatchObject({ phone: EZRA, mime: "image/png", name: "plan.png" });
    expect(out).toContain("send_to_caller");
    expect(out).toContain(`/m/${id}`);
  });

  it("the workspace is the owner's: a member's worker can't keep from it", async () => {
    const { keep, issue } = setup();
    expect(text(await keep.spec.execute({ source: "art/plan.png" }, ctx(issue.id)))).toMatch(/Only the owner/);
  });

  it("a path outside the workspace is refused", async () => {
    const { keep, issue } = setup(undefined, EZRA);
    for (const source of ["../secret.png", "/etc/passwd"]) {
      expect(await keep.spec.execute({ source }, ctx(issue.id))).toMatchObject({ isError: true });
    }
  });

  it("an image on the web is kept; a web page isn't", async () => {
    const fake = (async (url: string) => (String(url).endsWith(".png") ? new Response(PNG, { headers: { "content-type": "image/png" } }) : new Response("<html></html>", { headers: { "content-type": "text/html" } }))) as typeof fetch;
    const { store, keep, issue } = setup(fake);
    const out = text(await keep.spec.execute({ source: "https://example.com/couch.png" }, ctx(issue.id)));
    const id = /m_[0-9a-f]{16}\.png/.exec(out)![0];
    expect(store.get(id)!.item).toMatchObject({ phone: CLEO, name: "couch.png" });
    const page = await keep.spec.execute({ source: "https://example.com/couch" }, ctx(issue.id));
    expect(page).toMatchObject({ isError: true });
    expect(text(page)).toMatch(/text\/html/);
  });
});
