/**
 * Keep a photo or file someone texted or emailed: download it from its (public) link, with the
 * SSRF guard every outside fetch uses, and put it in the media store as theirs.
 */
import { fetchPublic, type Lookup } from "@kloru/core";
import { MEDIA_MAX_BYTES, type MediaItem, type MediaStore } from "@kloru/desk";

export function mediaIngest(o: { store: MediaStore; fetchImpl?: typeof fetch; lookup?: Lookup }): (a: { url: string; mime?: string; name?: string }, phone: string) => Promise<MediaItem> {
  return async (a, phone) => {
    const got = await fetchPublic(o.fetchImpl ?? fetch, a.url, { signal: AbortSignal.timeout(30_000), headers: { accept: "*/*" }, ...(o.lookup ? { lookup: o.lookup } : {}) });
    if (!got.ok) throw new Error(`can't download it: ${got.reason}`);
    if (!got.res.ok) throw new Error(`download failed: HTTP ${got.res.status}`);
    const cap = MEDIA_MAX_BYTES;
    if (Number(got.res.headers.get("content-length")) > cap) throw new Error(`${a.name ?? "it"} is too large`);
    const bytes = new Uint8Array(await got.res.arrayBuffer());
    const mime = a.mime || got.res.headers.get("content-type") || "application/octet-stream";
    const name = a.name || decodeURIComponent(new URL(a.url).pathname.split("/").pop() || "attachment");
    return o.store.put(bytes, { mime, name, phone });
  };
}
