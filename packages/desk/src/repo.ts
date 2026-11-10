/**
 * The repository: one per Kloru agent, on disk under `<data dir>/repo/`.
 *
 *   calls/<stamp>-<phone digits>-<CallSid>/call.json, transcript.jsonl, inbox.jsonl
 *   issues/<n>.json        each issue, with its thread and PRs
 *   ops/ledger.jsonl       every real-world change, append-only
 *   counters.json          { nextIssue }
 *
 * One process owns it. Everything is cached in memory and written through: JSON files by
 * temp file and rename, JSON lines by append, so a crash never leaves half a record.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "./result.js";
import type { Artifact, ArtifactVersion, CallRecord, Issue, LedgerEntry, Merge, MergeKind, SentNotification, Suggestion, Turn } from "./types.js";

/** 128 random bits, base64url: the only shape an artifact id can have. */
export const ARTIFACT_ID = /^[A-Za-z0-9_-]{22}$/;

/** The parent of every chain's first record. */
export const GENESIS = "0".repeat(64);

/** JSON with sorted keys, so the same record always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A chained record's hash: its parent and its content, without the hash itself. */
function chainHash<T extends { parent: string; hash?: string }>(rec: T): string {
  const { hash: _omit, ...rest } = rec;
  return sha256(`${rec.parent}\n${canonical(rest)}`);
}

export interface ChainBreak {
  /** 1-based position of the first record that doesn't verify. */
  at: number;
  reason: "hash mismatch" | "parent mismatch";
}

function verifyChain(records: Array<{ parent: string; hash: string }>): Result<number, ChainBreak> {
  let parent = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.parent !== parent) return err({ at: i + 1, reason: "parent mismatch" });
    if (chainHash(r) !== r.hash) return err({ at: i + 1, reason: "hash mismatch" });
    parent = r.hash;
  }
  return ok(records.length);
}

export interface MerkleNode {
  name: string;
  hash: string;
  children: MerkleNode[];
}

export interface NewIssue {
  request: string;
  filedBy: { phone: string; call: string };
  baseTurn: number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function list(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      continue;
    }
  }
  return out;
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace(/^(\d{4})(\d{2})(\d{2})T/, "$1-$2-$3T") + "Z";
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "");

export class Repo {
  private readonly calls = new Map<string, CallRecord>();
  private readonly transcripts = new Map<string, Turn[]>();
  private readonly inboxes = new Map<string, Merge[]>();
  private readonly issueMap = new Map<number, Issue>();
  private ledgerCache: LedgerEntry[];
  private nextIssue: number;

  /** readOnly: create nothing, so another process (the website) can inspect a live repository. */
  constructor(readonly dir: string, private readonly now: () => Date = () => new Date(), o: { readOnly?: boolean } = {}) {
    if (!o.readOnly) for (const d of ["calls", "issues", "ops"]) mkdirSync(join(dir, d), { recursive: true });
    for (const id of list(join(dir, "calls"))) {
      const rec = readJson<CallRecord | undefined>(join(dir, "calls", id, "call.json"), undefined);
      if (!rec) continue;
      this.calls.set(id, rec);
      this.transcripts.set(id, readLines<Turn>(join(dir, "calls", id, "transcript.jsonl")));
      this.inboxes.set(id, readLines<Merge>(join(dir, "calls", id, "inbox.jsonl")));
    }
    for (const f of list(join(dir, "issues"))) {
      if (!/^\d+\.json$/.test(f)) continue;
      const issue = readJson<Issue | undefined>(join(dir, "issues", f), undefined);
      if (issue) this.issueMap.set(issue.id, issue);
    }
    this.ledgerCache = readLines<LedgerEntry>(join(dir, "ops", "ledger.jsonl"));
    const counted = readJson<{ nextIssue?: number }>(join(dir, "counters.json"), {}).nextIssue ?? 1;
    this.nextIssue = Math.max(counted, ...[...this.issueMap.keys()].map((n) => n + 1));
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private callDir(id: string): string {
    return join(this.dir, "calls", id);
  }

  // Calls -------------------------------------------------------------------

  startCall(o: { callSid: string; phone: string; name?: string; channel: string }): CallRecord {
    const at = this.now();
    let id = `${stamp(at)}-${o.phone.replace(/\D/g, "")}-${safe(o.callSid) || "call"}`;
    for (let k = 2; this.calls.has(id); k++) id = `${id.replace(/~\d+$/, "")}~${k}`;
    const rec: CallRecord = { id, callSid: o.callSid, phone: o.phone, ...(o.name ? { name: o.name } : {}), channel: o.channel, startedAt: at.toISOString(), deliveredSeq: 0 };
    mkdirSync(this.callDir(id), { recursive: true });
    writeJson(join(this.callDir(id), "call.json"), rec);
    this.calls.set(id, rec);
    this.transcripts.set(id, []);
    this.inboxes.set(id, []);
    return rec;
  }

  call(id: string): CallRecord | undefined {
    return this.calls.get(id);
  }

  /** Every call from this phone, newest first. */
  callsFor(phone: string): CallRecord[] {
    return [...this.calls.values()].filter((c) => c.phone === phone).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : -1));
  }

  liveCalls(): CallRecord[] {
    return [...this.calls.values()].filter((c) => !c.endedAt);
  }

  /** This phone's newest call that hasn't ended. */
  liveCallFor(phone: string): CallRecord | undefined {
    return this.callsFor(phone).find((c) => !c.endedAt);
  }

  endCall(id: string): void {
    const rec = this.mustCall(id);
    if (rec.endedAt) return;
    rec.endedAt = this.iso();
    writeJson(join(this.callDir(id), "call.json"), rec);
  }

  /** Calls in the order they started. */
  allCalls(): CallRecord[] {
    return [...this.calls.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1));
  }

  noteCall(id: string, text: string): void {
    const rec = this.mustCall(id);
    rec.notes = [...(rec.notes ?? []), text];
    writeJson(join(this.callDir(id), "call.json"), rec);
  }

  private mustCall(id: string): CallRecord {
    const rec = this.calls.get(id);
    if (!rec) throw new Error(`no such call: ${id}`);
    return rec;
  }

  // Transcript ----------------------------------------------------------------

  addTurn(callId: string, t: { role: Turn["role"]; text: string; interrupted?: boolean }): Turn {
    this.mustCall(callId);
    const list = this.transcripts.get(callId)!;
    const draft = { n: list.length + 1, at: this.iso(), role: t.role, text: t.text, ...(t.interrupted ? { interrupted: true } : {}), parent: list.at(-1)?.hash ?? GENESIS };
    const turn: Turn = { ...draft, hash: chainHash(draft) };
    appendFileSync(join(this.callDir(callId), "transcript.jsonl"), JSON.stringify(turn) + "\n");
    list.push(turn);
    return turn;
  }

  turns(callId: string, afterN = 0): Turn[] {
    return (this.transcripts.get(callId) ?? []).filter((t) => t.n > afterN);
  }

  lastTurn(callId: string): number {
    return this.transcripts.get(callId)?.length ?? 0;
  }

  /** Hash of the call's latest turn: the commit everything filed now is based on. */
  head(callId: string): string {
    return this.transcripts.get(callId)?.at(-1)?.hash ?? GENESIS;
  }

  /** Every turn as written: the number of turns, or the first one that was changed. */
  verifyCall(callId: string): Result<number, ChainBreak> {
    return verifyChain(this.transcripts.get(callId) ?? []);
  }

  // Inbox (merges into a call) ---------------------------------------------------

  appendInbox(callId: string, m: { kind: MergeKind; text: string; issue?: number; draft?: string; progress?: boolean; question?: boolean }): Merge {
    this.mustCall(callId);
    const list = this.inboxes.get(callId)!;
    const merge: Merge = { seq: list.length + 1, at: this.iso(), kind: m.kind, text: m.text, ...(m.issue !== undefined ? { issue: m.issue } : {}), ...(m.draft ? { draft: m.draft } : {}), ...(m.progress ? { progress: true } : {}), ...(m.question ? { question: true } : {}) };
    appendFileSync(join(this.callDir(callId), "inbox.jsonl"), JSON.stringify(merge) + "\n");
    list.push(merge);
    return merge;
  }

  inbox(callId: string, afterSeq: number): Merge[] {
    return (this.inboxes.get(callId) ?? []).filter((m) => m.seq > afterSeq);
  }

  /** The call has received everything up to seq (never past what exists). */
  ack(callId: string, seq: number): void {
    const rec = this.mustCall(callId);
    seq = Math.min(seq, this.inboxes.get(callId)?.length ?? 0);
    if (seq <= rec.deliveredSeq) return;
    rec.deliveredSeq = seq;
    writeJson(join(this.callDir(callId), "call.json"), rec);
  }

  undelivered(callId: string): Merge[] {
    return this.inbox(callId, this.mustCall(callId).deliveredSeq);
  }

  // Issues ---------------------------------------------------------------------

  newIssue(o: NewIssue): Issue {
    const at = this.iso();
    const baseHash = this.transcripts.get(o.filedBy.call)?.find((t) => t.n === o.baseTurn)?.hash ?? GENESIS;
    const issue: Issue = { id: this.nextIssue++, kind: "untriaged", status: "open", request: o.request, filedBy: o.filedBy, baseTurn: o.baseTurn, baseHash, resources: [], thread: [], prs: [], links: {}, createdAt: at, updatedAt: at };
    writeJson(join(this.dir, "counters.json"), { nextIssue: this.nextIssue });
    this.saveIssue(issue, false);
    return issue;
  }

  issue(id: number): Issue | undefined {
    return this.issueMap.get(id);
  }

  saveIssue(issue: Issue, touch = true): void {
    if (touch) issue.updatedAt = this.iso();
    writeJson(join(this.dir, "issues", `${issue.id}.json`), issue);
    this.issueMap.set(issue.id, issue);
  }

  issues(filter?: (i: Issue) => boolean): Issue[] {
    const all = [...this.issueMap.values()].sort((a, b) => a.id - b.id);
    return filter ? all.filter(filter) : all;
  }

  // Ops ledger -----------------------------------------------------------------

  appendLedger(e: Omit<LedgerEntry, "at" | "parent" | "hash">): LedgerEntry {
    const draft = { at: this.iso(), ...e, parent: this.ledgerCache.at(-1)?.hash ?? GENESIS };
    const entry: LedgerEntry = { ...draft, hash: chainHash(draft) };
    appendFileSync(join(this.dir, "ops", "ledger.jsonl"), JSON.stringify(entry) + "\n");
    this.ledgerCache.push(entry);
    return entry;
  }

  ledger(issue?: number): LedgerEntry[] {
    return issue === undefined ? [...this.ledgerCache] : this.ledgerCache.filter((e) => e.issue === issue);
  }

  verifyLedger(): Result<number, ChainBreak> {
    return verifyChain(this.ledgerCache);
  }

  // Messages sent -----------------------------------------------------------------

  /**
   * What this phone was sent on Kloru's channels, oldest first; only since `sinceMs` (epoch ms) when
   * given. From the ledger, and from notifications.jsonl for what was sent before the ledger kept them.
   */
  notifications(phone: string, sinceMs = 0): SentNotification[] {
    const file = join(this.dir, "notifications.jsonl");
    const old = !existsSync(file)
      ? []
      : readFileSync(file, "utf8")
          .split("\n")
          .flatMap((l) => {
            try {
              return l ? [JSON.parse(l) as SentNotification] : [];
            } catch {
              return [];
            }
          });
    const sent = this.ledgerCache
      .filter((e) => e.slug === "MESSAGE" && e.ok)
      .map((e): SentNotification => {
        const a = (e.args ?? {}) as { to?: string; channel?: string; subject?: string; text?: string };
        return { at: e.at, phone: a.to ?? e.phone, channel: a.channel ?? "default", subject: a.subject ?? "", text: a.text ?? "", call: e.call, issues: [e.issue] };
      });
    return [...old, ...sent].filter((n) => n.phone === phone && Date.parse(n.at) >= sinceMs).sort((x, y) => x.at.localeCompare(y.at));
  }

  // Suggestions -------------------------------------------------------------------

  suggestions(): Suggestion[] {
    return readJson<Suggestion[]>(join(this.dir, "suggestions.json"), []);
  }

  saveSuggestions(all: Suggestion[]): void {
    writeJson(join(this.dir, "suggestions.json"), all);
  }

  // Artifacts ---------------------------------------------------------------------
  // Read from disk each time: the website reads them from another process.

  saveArtifact(a: Artifact): void {
    if (!ARTIFACT_ID.test(a.id)) throw new Error(`bad artifact id ${a.id}`);
    mkdirSync(join(this.dir, "artifacts"), { recursive: true });
    writeJson(join(this.dir, "artifacts", `${a.id}.json`), a);
  }

  artifact(id: string): Artifact | undefined {
    return ARTIFACT_ID.test(id) ? readJson<Artifact | undefined>(join(this.dir, "artifacts", `${id}.json`), undefined) : undefined;
  }

  /** Keep a version of an artifact, oldest first in versions/<id>.jsonl. */
  appendArtifactVersion(id: string, v: ArtifactVersion): void {
    if (!ARTIFACT_ID.test(id)) throw new Error(`bad artifact id ${id}`);
    mkdirSync(join(this.dir, "artifacts", "versions"), { recursive: true });
    appendFileSync(join(this.dir, "artifacts", "versions", `${id}.jsonl`), JSON.stringify(v) + "\n");
  }

  artifactVersions(id: string): ArtifactVersion[] {
    return ARTIFACT_ID.test(id) ? readLines<ArtifactVersion>(join(this.dir, "artifacts", "versions", `${id}.jsonl`)) : [];
  }

  artifacts(): Artifact[] {
    return list(join(this.dir, "artifacts"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.artifact(f.slice(0, -5)))
      .filter((a): a is Artifact => !!a)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Merkle root --------------------------------------------------------------------

  /**
   * The repository as a Merkle tree: calls (each call's head), issues (each issue's content)
   * and the ledger head. Two repos with the same root hold the same history.
   */
  root(): MerkleNode {
    const node = (name: string, children: MerkleNode[]): MerkleNode => ({ name, hash: sha256(children.map((c) => `${c.name}:${c.hash}`).join("\n")), children });
    const leaf = (name: string, hash: string): MerkleNode => ({ name, hash, children: [] });
    const calls = node("calls", [...this.calls.keys()].sort().map((id) => leaf(id, this.head(id))));
    const issues = node("issues", this.issues().map((i) => leaf(String(i.id), sha256(canonical(i)))));
    const ledger = leaf("ledger", this.ledgerCache.at(-1)?.hash ?? GENESIS);
    return node("repo", [calls, issues, ledger]);
  }
}
