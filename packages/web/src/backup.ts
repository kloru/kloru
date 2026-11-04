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
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
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
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
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

  async put(key: string, body: Buffer): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.o.bucket, Key: key, Body: body, ContentType: "application/octet-stream" }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
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

export async function runBackup(o: { dir: string; store: ObjectStore; encryptionKey: string; now?: Date; family?: string }): Promise<string> {
  const tar = tarCreate(o.dir);
  const archive = execFileSync("tar", tar.args, { env: tar.env, maxBuffer: 2 * 1024 * 1024 * 1024 });
  const key = backupKey(o.now ?? new Date(), o.family);
  await o.store.put(key, encrypt(keyFromHex(o.encryptionKey), archive));
  return key;
}

export async function restore(o: { dest: string; store: ObjectStore; encryptionKey: string; key?: string; family?: string }): Promise<string> {
  const key = o.key ?? (await o.store.latest(backupPrefix(o.family)));
  if (!key) throw new Error("no backups found");
  const archive = decrypt(keyFromHex(o.encryptionKey), await o.store.get(key));
  mkdirSync(o.dest, { recursive: true });
  execFileSync("tar", ["xzf", "-", "-C", o.dest], { input: archive });
  return key;
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
