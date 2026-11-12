import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupKey, backupPrefix, decrypt, decryptFile, encrypt, encryptTo, keyFromHex, restore, runBackup, tarCreate, type ObjectStore } from "../src/backup.js";

const KEY = "11".repeat(32);

class MemoryStore implements ObjectStore {
  objects = new Map<string, Buffer>();
  async put(key: string, file: string) { this.objects.set(key, readFileSync(file)); }
  async get(key: string, file: string) { const b = this.objects.get(key); if (!b) throw new Error("missing"); writeFileSync(file, b); }
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

  it("the streamed format is the same box, and a tampered one never decrypts", async () => {
    const key = keyFromHex(KEY);
    const dir = mkdtempSync(join(tmpdir(), "bk-stream-"));
    const plain = Buffer.alloc(3 * 1024 * 1024 + 7, 0x61);
    await encryptTo(key, Readable.from([plain.subarray(0, 1000), plain.subarray(1000)]), join(dir, "box"));
    const box = readFileSync(join(dir, "box"));
    expect(decrypt(key, box).equals(plain)).toBe(true);
    await decryptFile(key, join(dir, "box"), join(dir, "out"));
    expect(readFileSync(join(dir, "out")).equals(plain)).toBe(true);
    box[100] ^= 1;
    writeFileSync(join(dir, "bad"), box);
    await expect(decryptFile(key, join(dir, "bad"), join(dir, "out2"))).rejects.toThrow();
    await expect(decryptFile(keyFromHex("22".repeat(32)), join(dir, "box"), join(dir, "out3"))).rejects.toThrow();
  });

  it("on macOS, archives plain file contents a Linux tar can read", () => {
    const mac = tarCreate("/data", "darwin");
    expect(mac.args).toContain("--no-mac-metadata");
    expect(mac.env.COPYFILE_DISABLE).toBe("1");
    expect(tarCreate("/data", "linux").args).toEqual(["--exclude=node_modules", "-czf", "-", "-C", "/data", "."]);
  });

  it("leaves out what npm installed for an app's server: it is installed again after a restore (2026-11-12)", () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-tar-"));
    mkdirSync(join(dir, "kloru", "app-servers", "A", "code", "node_modules", "ws"), { recursive: true });
    writeFileSync(join(dir, "kloru", "app-servers", "A", "code", "node_modules", "ws", "index.js"), "x");
    writeFileSync(join(dir, "kloru", "app-servers", "A", "code", "server.js"), "y");
    const t = tarCreate(dir);
    const made = spawnSync("tar", t.args, { env: t.env, maxBuffer: 1 << 24 });
    const listed = spawnSync("tar", ["tzf", "-"], { input: made.stdout }).stdout.toString();
    expect(listed).toContain("server.js");
    expect(listed).not.toContain("node_modules");
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
