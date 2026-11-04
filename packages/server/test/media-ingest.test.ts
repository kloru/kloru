import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaStore } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { mediaIngest } from "../src/media-ingest.js";

const EVAN = "+14155550190";
const publicHost = async () => ["93.184.216.34"];

describe("keeping an attachment", () => {
  it("downloads it from a public URL and keeps it with its type and name", async () => {
    const store = new MediaStore(mkdtempSync(join(tmpdir(), "ingest-")));
    const ingest = mediaIngest({ store, lookup: publicHost, fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch });
    const item = await ingest({ url: "https://media.inkbox.ai/x", name: "IMG_1.jpg" }, EVAN);
    expect(item).toMatchObject({ mime: "image/jpeg", name: "IMG_1.jpg", size: 3, phone: EVAN });
    expect(store.get(item!.id)).toBeDefined();
  });

  it("refuses a private address, a failed download, or a file over the cap", async () => {
    const store = new MediaStore(mkdtempSync(join(tmpdir(), "ingest-")), { maxBytes: 2 });
    const ok = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    await expect(mediaIngest({ store, lookup: async () => ["10.0.0.5"], fetchImpl: ok })({ url: "https://internal/x" }, EVAN)).rejects.toThrow();
    await expect(mediaIngest({ store, lookup: publicHost, fetchImpl: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch })({ url: "https://media.inkbox.ai/y" }, EVAN)).rejects.toThrow(/404/);
    await expect(mediaIngest({ store, lookup: publicHost, fetchImpl: ok })({ url: "https://media.inkbox.ai/z", name: "big.png" }, EVAN)).rejects.toThrow(/too large/);
  });
});
