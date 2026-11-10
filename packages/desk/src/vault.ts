/**
 * The vault: secrets the family gives Kloru (cards, logins, API keys), used by reference so the
 * values never enter a conversation, a trace, a prompt or memory. Each entry's secret fields are
 * AES-256-GCM encrypted with KLORU_VAULT_KEY; only the metadata (brand and last 4, site and
 * username) is ever shown to a model. `{{vault:name.field}}` names a value; tools resolve it at the
 * last moment and scrub every value back to its reference in whatever they return.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result } from "./result.js";

export const VAULT_KINDS = ["card", "login", "api_key", "note"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

/** What a model may see about an entry. */
export interface VaultMeta {
  /** card */
  brand?: string;
  last4?: string;
  expYear?: string;
  limits?: { perPurchaseUsd?: number; perDayUsd?: number };
  /** login */
  site?: string;
  username?: string;
  /** api_key */
  service?: string;
  note?: string;
}

/** The fields kept secret, by kind. */
export const SECRET_FIELDS: Record<VaultKind, readonly string[]> = {
  card: ["number", "cvc", "exp", "name", "zip"],
  login: ["password", "totp"],
  api_key: ["key"],
  note: ["text"],
};

export interface VaultEntry {
  name: string;
  /** The phone of the person it belongs to. */
  owner: string;
  kind: VaultKind;
  meta: VaultMeta;
  createdBy: string;
  createdAt: string;
  usedAt?: string;
}

interface Stored extends VaultEntry {
  /** iv.tag.ciphertext, base64 each, of the secret fields as JSON. */
  sealed: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const REF = /\{\{vault:([a-z0-9][a-z0-9-]{1,62})\.([a-z]+)\}\}/g;

/** Card numbers pass the Luhn check; this finds them in text people send (13 to 19 digits, spaces or dashes allowed). */
export function luhnNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    if (sum % 10 === 0) out.push(m[0]);
  }
  return out;
}

/** One entry as a model may see it. */
export function describeEntry(e: VaultEntry, ownerName: (phone: string) => string): string {
  const m = e.meta;
  const what =
    e.kind === "card" ? `${m.brand ?? "card"} ending ${m.last4 ?? "?"}${m.expYear ? `, expires ${m.expYear}` : ""}${m.limits?.perPurchaseUsd ? `, at most $${m.limits.perPurchaseUsd} a purchase` : ""}${m.limits?.perDayUsd ? `, $${m.limits.perDayUsd} a day` : ""}; fields number, cvc, exp, name, zip`
    : e.kind === "login" ? `login for ${m.site ?? "?"} as ${m.username ?? "?"}; field password`
    : e.kind === "api_key" ? `API key for ${m.service ?? "?"}; field key`
    : `note${m.note ? ` (${m.note})` : ""}; field text`;
  return `${e.name} (${ownerName(e.owner)}'s): ${what}`;
}

export class Vault {
  private readonly key: Buffer;

  /** `key`: 32 bytes, base64 (KLORU_VAULT_KEY). */
  constructor(readonly file: string, key: string, private readonly now: () => Date = () => new Date()) {
    const k = Buffer.from(key.trim(), "base64");
    if (k.length !== 32) throw new Error("KLORU_VAULT_KEY must be 32 bytes, base64");
    this.key = k;
  }

  private read(): Stored[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Stored[];
    } catch {
      return [];
    }
  }

  private write(entries: Stored[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  private seal(secret: Record<string, string>): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(secret), "utf8"), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
  }

  private open(sealed: string): Record<string, string> {
    const [iv, tag, body] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
    const d = createDecipheriv("aes-256-gcm", this.key, iv!);
    d.setAuthTag(tag!);
    return JSON.parse(Buffer.concat([d.update(body!), d.final()]).toString("utf8")) as Record<string, string>;
  }

  /** Every entry, metadata only. */
  list(): VaultEntry[] {
    return this.read().map(({ sealed: _s, ...e }) => e);
  }

  get(name: string): VaultEntry | undefined {
    return this.list().find((e) => e.name === name);
  }

  /** Add or replace an entry (a person on kloru.com, or Kloru after a sign-up). */
  put(o: { name: string; owner: string; kind: VaultKind; meta: VaultMeta; secret: Record<string, string>; createdBy: string }): Result<VaultEntry> {
    if (!NAME.test(o.name)) return err("a vault name is lowercase letters, digits and dashes, e.g. ezra-credit-card");
    if (!VAULT_KINDS.includes(o.kind)) return err(`kind is one of ${VAULT_KINDS.join(", ")}`);
    const allowed = new Set(SECRET_FIELDS[o.kind]);
    const secret = Object.fromEntries(Object.entries(o.secret).filter(([k, v]) => allowed.has(k) && typeof v === "string" && v.length > 0));
    if (!Object.keys(secret).length) return err(`a ${o.kind} needs at least one of ${[...allowed].join(", ")}`);
    const meta: VaultMeta = { ...o.meta };
    if (o.kind === "card" && secret.number) meta.last4 = secret.number.replace(/\D/g, "").slice(-4);
    const entries = this.read().filter((e) => e.name !== o.name);
    const entry: Stored = { name: o.name, owner: o.owner, kind: o.kind, meta, createdBy: o.createdBy, createdAt: this.now().toISOString(), sealed: this.seal(secret) };
    this.write([...entries, entry]);
    const { sealed: _s, ...shown } = entry;
    return ok(shown);
  }

  remove(name: string): boolean {
    const entries = this.read();
    const kept = entries.filter((e) => e.name !== name);
    if (kept.length === entries.length) return false;
    this.write(kept);
    return true;
  }

  /** A login Kloru makes after signing up: the password is made here, never by a model. */
  generateLogin(o: { name: string; owner: string; site: string; username: string; createdBy: string }): Result<VaultEntry> {
    const password = randomBytes(18).toString("base64url").replace(/[-_]/g, "x").slice(0, 20) + "!9a";
    return this.put({ name: o.name, owner: o.owner, kind: "login", meta: { site: o.site, username: o.username }, secret: { password }, createdBy: o.createdBy });
  }

  /** The references a text uses: [name, field] pairs. */
  static refs(text: string): Array<[string, string]> {
    return [...text.matchAll(REF)].map((m) => [m[1]!, m[2]!]);
  }

  /** Swap every reference for its value, for entries `may` allows; an unknown or refused one is an error. */
  resolve(text: string, may: (e: VaultEntry) => boolean): Result<string> {
    const entries = new Map(this.read().map((e) => [e.name, e]));
    let missing = "";
    const out = text.replace(REF, (whole, name: string, field: string) => {
      const e = entries.get(name);
      if (!e) return (missing ||= `no vault entry ${name}`), whole;
      const { sealed: _s, ...shown } = e;
      if (!may(shown)) return (missing ||= `${name} isn't this request's to use`), whole;
      const value = this.open(e.sealed)[field];
      if (value === undefined) return (missing ||= `${name} has no ${field}`), whole;
      return value;
    });
    if (missing) return err(missing);
    this.touch([...new Set(Vault.refs(text).map(([n]) => n))]);
    return ok(out);
  }

  /** One value, for a tool that fills it itself (a card field). */
  value(name: string, field: string): string | undefined {
    const e = this.read().find((x) => x.name === name);
    return e ? this.open(e.sealed)[field] : undefined;
  }

  /** Every secret field of one entry: only for its owner's own export, never for a model. */
  secretOf(name: string): Record<string, string> | undefined {
    const e = this.read().find((x) => x.name === name);
    return e ? this.open(e.sealed) : undefined;
  }

  /** Every stored value replaced by its reference, so nothing a tool returns can carry one. */
  scrub(text: string): string {
    let out = text;
    for (const e of this.read()) {
      const secret = this.open(e.sealed);
      for (const [field, value] of Object.entries(secret)) {
        // Short values (a CVC, a ZIP) would blank out ordinary numbers; the long ones are what matter.
        if (!value || (value.length < 6 && !(e.kind === "card" && field === "number"))) continue;
        // The name on a card is the person's own name: masking it hides them on every page they read.
        if (e.kind === "card" && field === "name") continue;
        const ref = `{{vault:${e.name}.${field}}}`;
        out = out.split(value).join(ref);
        // A card number may come back spaced, dashed or bare.
        if (e.kind === "card" && field === "number") {
          const digits = value.replace(/\D/g, "");
          const loose = new RegExp(digits.split("").join("[\\s-]?"), "g");
          out = out.replace(loose, ref);
        }
      }
    }
    return out;
  }

  private touch(names: string[]): void {
    if (!names.length) return;
    const at = this.now().toISOString();
    this.write(this.read().map((e) => (names.includes(e.name) ? { ...e, usedAt: at } : e)));
  }
}
