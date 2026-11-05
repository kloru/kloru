/**
 * Off-site backups of the service's disk (agent memory, permissions, logs) to Cloudflare R2.
 *
 * A backup is `tar czf` of the data directory, sealed with AES-256-GCM under BACKUP_KEY
 * (kept apart from the bucket), uploaded as backups/YYYY/MM/DD/kloru-data-<stamp>.tar.gz.enc.
 * The bucket's lifecycle rule deletes objects after 30 days (see /privacy).
 *
 *   node dist/backup.js          back up KLORU_BACKUP_DIR (default /data) now
 *   node dist/backup.js restore <dest>   restore the newest backup into <dest>
 */
import { execFileSync, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MAGIC = Buffer.from("KLORU1");

export function keyFromHex(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex.trim())) throw new Error("BACKUP_KEY must be 64 hex characters (openssl rand -hex 32)");
  return Buffer.from(hex.trim(), "hex");
}

/** MAGIC | 12-byte IV | ciphertext | 16-byte tag */
export function encrypt(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function decrypt(key: Buffer, box: Buffer): Buffer {
  if (box.length < MAGIC.length + 28 || !box.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a Kloru backup");
  const iv = box.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = box.subarray(box.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(box.subarray(MAGIC.length + 12, box.length - 16)), decipher.final()]);
}

/** encrypt(), streamed into a file: the archive never sits in memory, whatever the disk holds. */
export async function encryptTo(key: Buffer, input: Readable, file: string): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  await pipeline(
    input,
    cipher,
    async function* (sealed: AsyncIterable<Buffer>) {
      yield Buffer.concat([MAGIC, iv]);
      for await (const chunk of sealed) yield chunk;
      yield cipher.getAuthTag();
    },
    createWriteStream(file),
  );
}

/** decrypt(), file to file; throws (and the output must not be used) if the box was altered. */
export async function decryptFile(key: Buffer, box: string, out: string): Promise<void> {
  const size = statSync(box).size;
  const head = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  const fd = openSync(box, "r");
  try {
    if (size < MAGIC.length + 28) throw new Error("not a Kloru backup");
    readSync(fd, head, 0, head.length, 0);
    readSync(fd, tag, 0, 16, size - 16);
  } finally {
    closeSync(fd);
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a Kloru backup");
  const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(box, { start: head.length, end: size - 17 }), decipher, createWriteStream(out));
}

/** A family's short name (KLORU_FAMILY): lowercase, starts with a letter, so it never looks like a year. */
export const FAMILY = /^[a-z][a-z0-9-]{1,30}$/;

function folder(family?: string): string {
  if (family === undefined) return "backups/";
  if (!FAMILY.test(family)) throw new Error(`bad family name ${JSON.stringify(family)}`);
  return `backups/${family}/`;
}

/** Each family's backups under backups/<family>/; the first deployment keeps backups/YYYY/... */
export function backupKey(at: Date, family?: string): string {
  const iso = at.toISOString();
  const stamp = iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `${folder(family)}${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/kloru-data-${stamp}.tar.gz.enc`;
}

/** Where restore looks: this family's folder, or the dated folders only (never another family's). */
export function backupPrefix(family?: string): string {
  return family === undefined ? "backups/2" : folder(family);
}

export interface ObjectStore {
  /** Upload a file's contents. */
  put(key: string, file: string): Promise<void>;
  /** Download an object into a file. */
  get(key: string, file: string): Promise<void>;
  /** The greatest key under a prefix (keys sort by time). */
  latest(prefix: string): Promise<string | undefined>;
}

export class R2Store implements ObjectStore {
  private readonly s3: S3Client;

  constructor(private readonly o: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.s3 = new S3Client({
      region: "auto",
      endpoint: `https://${o.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
    });
  }

  async put(key: string, file: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.o.bucket, Key: key, Body: createReadStream(file), ContentLength: statSync(file).size, ContentType: "application/octet-stream" }));
  }

  async get(key: string, file: string): Promise<void> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
    await pipeline(res.Body as Readable, createWriteStream(file));
  }

  async latest(prefix: string): Promise<string | undefined> {
    let token: string | undefined;
    let best: string | undefined;
    do {
      const res = await this.s3.send(new ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
      for (const obj of res.Contents ?? []) if (obj.Key && (!best || obj.Key > best)) best = obj.Key;
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return best;
  }
}

/**
 * macOS tar can store APFS-compressed files as Mac metadata with an empty data fork, which
 * Linux tar restores as empty files. On macOS, archive plain contents and no metadata.
 */
export function tarCreate(dir: string, platform: NodeJS.Platform = process.platform): { args: string[]; env: NodeJS.ProcessEnv } {
  if (platform === "darwin") return { args: ["--no-mac-metadata", "--no-xattrs", "-czf", "-", "-C", dir, "."], env: { ...process.env, COPYFILE_DISABLE: "1" } };
  return { args: ["czf", "-", "-C", dir, "."], env: process.env };
}

/**
 * Streams tar through the cipher into a temp file outside the data directory, then uploads it.
 * Memory stays flat: holding the archive in memory (twice, once sealed) ran a 2 GB machine out.
 */
export async function runBackup(o: { dir: string; store: ObjectStore; encryptionKey: string; now?: Date; family?: string }): Promise<string> {
  const encryptionKey = keyFromHex(o.encryptionKey);
  const key = backupKey(o.now ?? new Date(), o.family);
  const work = mkdtempSync(join(tmpdir(), "kloru-backup-"));
  try {
    const sealed = join(work, "backup.enc");
    const tar = tarCreate(o.dir);
    const child = spawn("tar", tar.args, { env: tar.env, stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<number | null>((resolve, reject) => child.on("error", reject).on("close", resolve));
    await encryptTo(encryptionKey, child.stdout, sealed);
    const code = await exited;
    if (code !== 0) throw new Error(`tar exited with ${code}`);
    await o.store.put(key, sealed);
    return key;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function restore(o: { dest: string; store: ObjectStore; encryptionKey: string; key?: string; family?: string }): Promise<string> {
  const key = o.key ?? (await o.store.latest(backupPrefix(o.family)));
  if (!key) throw new Error("no backups found");
  const work = mkdtempSync(join(tmpdir(), "kloru-restore-"));
  try {
    await o.store.get(key, join(work, "backup.enc"));
    // Verified before tar sees a byte of it.
    await decryptFile(keyFromHex(o.encryptionKey), join(work, "backup.enc"), join(work, "backup.tar.gz"));
    mkdirSync(o.dest, { recursive: true });
    execFileSync("tar", ["xzf", join(work, "backup.tar.gz"), "-C", o.dest]);
    return key;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function storeFromEnv(env: NodeJS.ProcessEnv): R2Store {
  const need = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "BACKUP_KEY"];
  const missing = need.filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`backup: missing env ${missing.join(", ")}`);
  return new R2Store({ accountId: env.R2_ACCOUNT_ID!, accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY!, bucket: env.R2_BUCKET! });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const [cmd, dest] = process.argv.slice(2);
  (async () => {
    const store = storeFromEnv(env);
    const family = env.KLORU_FAMILY?.trim() || undefined;
    if (cmd === "restore") {
      if (!dest) throw new Error("usage: backup.js restore <dest>");
      console.log(`[backup] restored ${await restore({ dest, store, encryptionKey: env.BACKUP_KEY!, ...(family ? { family } : {}) })} into ${dest}`);
    } else {
      console.log(`[backup] uploaded ${await runBackup({ dir: env.KLORU_BACKUP_DIR ?? "/data", store, encryptionKey: env.BACKUP_KEY!, ...(family ? { family } : {}) })}`);
    }
  })().catch((err: unknown) => {
    console.error(`[backup] failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
