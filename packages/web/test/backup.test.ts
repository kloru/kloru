import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupKey, backupPrefix, decrypt, encrypt, keyFromHex, restore, runBackup, tarCreate, type ObjectStore } from "../src/backup.js";

const KEY = "11".repeat(32);

class MemoryStore implements ObjectStore {
  objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) { this.objects.set(key, body); }
  async get(key: string) { const b = this.objects.get(key); if (!b) throw new Error("missing"); return b; }
  async latest(prefix: string) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort().at(-1); }
}

describe("backup", () => {
  it("encrypts with AES-256-GCM and refuses tampering or another key", () => {
    const key = keyFromHex(KEY);
    const box = encrypt(key, Buffer.from("hello"));
    expect(box.subarray(0, 6).toString()).toBe("KLORU1");
    expect(decrypt(key, box).toString()).toBe("hello");
    const bad = Buffer.from(box); bad[bad.length - 1] ^= 1;
    expect(() => decrypt(key, bad)).toThrow();
    expect(() => decrypt(keyFromHex("22".repeat(32)), box)).toThrow();
    expect(() => keyFromHex("abc")).toThrow(/64 hex/);
  });

  it("on macOS, archives plain file contents a Linux tar can read", () => {
    const mac = tarCreate("/data", "darwin");
    expect(mac.args).toContain("--no-mac-metadata");
    expect(mac.env.COPYFILE_DISABLE).toBe("1");
    expect(tarCreate("/data", "linux").args).toEqual(["czf", "-", "-C", "/data", "."]);
  });

  it("names objects by date so lifecycle rules and 'latest' work", () => {
    expect(backupKey(new Date("2026-10-27T09:05:03Z"))).toBe("backups/2026/10/27/kloru-data-20261027T090503Z.tar.gz.enc");
  });

  it("backs up a directory and restores it", async () => {
    const src = mkdtempSync(join(tmpdir(), "bk-src-"));
    mkdirSync(join(src, "instinct", "memory"), { recursive: true });
    writeFileSync(join(src, "instinct", "memory", "MEMORY.md"), "vegetarian");
    writeFileSync(join(src, "instinct", "policy.json"), "{}");
    const store = new MemoryStore();
    const key = await runBackup({ dir: src, store, encryptionKey: KEY, now: new Date("2026-10-27T09:05:03Z") });
    expect(store.objects.has(key)).toBe(true);
    expect(store.objects.get(key)!.includes(Buffer.from("vegetarian"))).toBe(false);
    const dest = mkdtempSync(join(tmpdir(), "bk-dst-"));
    const restored = await restore({ dest, store, encryptionKey: KEY });
    expect(restored).toBe(key);
    expect(readFileSync(join(dest, "instinct", "memory", "MEMORY.md"), "utf8")).toBe("vegetarian");
  });
});

describe("one bucket, many families", () => {
  it("a family's backups live under its own folder; yours stay where they are", () => {
    expect(backupKey(new Date("2026-10-27T09:05:03Z"), "smiths")).toBe("backups/smiths/2026/10/27/kloru-data-20261027T090503Z.tar.gz.enc");
    expect(backupKey(new Date("2026-10-27T09:05:03Z"))).toBe("backups/2026/10/27/kloru-data-20261027T090503Z.tar.gz.enc");
    expect(() => backupKey(new Date(), "../evil")).toThrow();
  });

  it("restore only ever picks this family's newest backup", async () => {
    const store = new MemoryStore();
    const key = keyFromHex("ab".repeat(32));
    store.objects.set("backups/2026/10/27/kloru-data-20261027T090503Z.tar.gz.enc", encrypt(key, Buffer.from("x")));
    store.objects.set("backups/smiths/2026/10/28/kloru-data-20261028T090503Z.tar.gz.enc", encrypt(key, Buffer.from("x")));
    expect(backupPrefix()).toBe("backups/2");
    expect(await store.latest(backupPrefix())).toBe("backups/2026/10/27/kloru-data-20261027T090503Z.tar.gz.enc");
    expect(await store.latest(backupPrefix("smiths"))).toBe("backups/smiths/2026/10/28/kloru-data-20261028T090503Z.tar.gz.enc");
  });
});
