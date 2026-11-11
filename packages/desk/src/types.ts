/** The repository's records. */
import type { Capability } from "@kloru/core";

export type IssueKind = "untriaged" | "work" | "ops";

export type IssueStatus =
  | "open" | "in_progress" | "needs_info" | "in_review" | "merged"
  | "needs_confirmation" | "executing" | "done" | "failed" | "reverted"
  | "resolved" | "duplicate" | "wont_do" | "superseded" | "not_planned";

export const CLOSED: ReadonlySet<IssueStatus> = new Set(["merged", "done", "failed", "reverted", "resolved", "duplicate", "wont_do", "superseded", "not_planned"]);
export const isClosed = (s: IssueStatus): boolean => CLOSED.has(s);

export type Author = "talker" | "pm" | "engineer" | "ops" | "qa" | "system";

export interface ThreadEntry {
  at: string;
  by: Author;
  call?: string;
  text: string;
}

export interface PullRequest {
  at: string;
  body: string;
  baseTurn: number;
  status: "open" | "merged" | "rejected";
}

export type Deliverable = "answer" | "email" | "message" | "page" | "app" | "event" | "change" | "automation";

export interface IssueTarget {
  /** The final state the caller would notice. */
  goal: string;
  /** What has to be true to call it done. */
  doneWhen: string;
  deliverable: Deliverable;
}

export interface Issue {
  id: number;
  /** What the PM said the work needs (a member's request): a permission on someone's account. */
  needs?: import("./access.js").Need[];
  /** The CISO's review of those needs: what's allowed, what needs an owner's yes, what isn't. */
  access?: import("./access.js").AccessReview;
  kind: IssueKind;
  status: IssueStatus;
  /** The talking model's words. */
  request: string;
  /** The PM's. */
  spec?: string;
  /** The PM's template: what done looks like, so the worker aims at it and the PM checks a result against it. */
  target?: IssueTarget;
  filedBy: { phone: string; call: string };
  /** Transcript turn of the filing call when the issue was filed. */
  baseTurn: number;
  /** Hash of that turn: the commit the issue is based on. Rebasing means the call moved past it. */
  baseHash: string;
  resources: string[];
  thread: ThreadEntry[];
  prs: PullRequest[];
  links: { duplicateOf?: number; supersededBy?: number; revertedBy?: number; reverts?: number; parent?: number; /** A follow-up run in this earlier issue's worker conversation (it has the context). */ continues?: number };
  /**
   * Set by the ops guard when a write needs the caller's yes. `draft` is written from the exact
   * call; `id` names it, and a yes must name the same id. One yes allows one send (`used`).
   */
  confirmation?: { id: string; draft: string; argsHash: string; /** The phone whose yes counts (the owner, for a member's ask); unset: anyone's on the call. */ by?: string; /** Asked about their own things: only their own yes counts (not any owner's). */ personal?: boolean; /** For an owner's yes: the exact tool it covers (with argsHash). */ tool?: string; /** When it was asked, and the last turn of the asker's call then: where a yes must be newer than its question. */ asked?: { at: string; turn: number }; confirmedBy?: string; confirmedAt?: string; used?: boolean; writesBefore?: number };
  /** "Never mind" arrived while ops was mid-change: no more writes, and undo what was done. */
  cancelRequested?: boolean;
  /** How many times the sweeper has nudged the PM about this issue without it moving. */
  nudges?: number;
  /** Exact app actions the fast path chose for a simple change, and what the caller hears when they're done. */
  fast?: { changes: Array<{ slug: string; args: Record<string, unknown>; account?: string }>; say: string };
  /** The artifact (page) this issue made or edited. */
  artifact?: string;
  /** QA on the app this issue made or changed: how many times it sent the engineer back, the version it last tried, and what it found there. */
  qa?: { rounds: number; version?: number; verdict?: { usable: boolean; bugs: string } };
  /** A family member the owner described, waiting on the owner's yes to the read-back. */
  member?: MemberPlan;
  /** A line the person asked to add to their own policy.md, tied to the read-back (draft id) their own yes answers. */
  policyLine?: { line: string; draft: string };
  /** An issue the desk files itself: "memory" updates memory from a finished call; "scout" looks for what the caller will want next. */
  purpose?: "memory" | "scout";
  /** What started an event automation (an email, a webhook's body): outside content, trimmed. */
  event?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CallRecord {
  id: string;
  callSid: string;
  phone: string;
  name?: string;
  channel: string;
  startedAt: string;
  endedAt?: string;
  /** Highest inbox seq the call has received. */
  deliveredSeq: number;
  /** "Remember that…" from the call, for the memory worker. */
  notes?: string[];
}

export interface Turn {
  n: number;
  at: string;
  role: "caller" | "kloru";
  text: string;
  interrupted?: boolean;
  /** Hash of the previous turn (GENESIS for the first); `hash` covers this turn and its parent. */
  parent: string;
  hash: string;
}

export type MergeKind = "info" | "events";

export interface Merge {
  seq: number;
  at: string;
  kind: MergeKind;
  text: string;
  issue?: number;
  /** Set when the merge asks for a yes: the confirmation id the yes must name. */
  draft?: string;
  /** A change told as it happened, while its issue's work goes on. */
  progress?: boolean;
  /** It asks them something the work waits on (a question, a yes, a takeover link). */
  question?: boolean;
}

export interface LedgerEntry {
  at: string;
  issue: number;
  call: string;
  phone: string;
  tool: string;
  slug: string;
  args: unknown;
  ok: boolean;
  result: string;
  /** For a message: what the message check decided (send, hold, drop, ask, ask_owner). */
  decision?: string;
  /** The ledger is a hash chain, like a call's turns. */
  parent: string;
  hash: string;
}

/** A page a worker published (a comparison, a plan, a report), shared by an unguessable link. */
export interface Artifact {
  id: string;
  title: string;
  markdown: string;
  issue: number;
  call: string;
  phone: string;
  createdAt: string;
  /** When its link went out in an after-call email. */
  emailedAt?: string;
  /** Living document: every edit bumps the version (old ones in versions/<id>.jsonl). */
  version?: number;
  updatedAt?: string;
  /** A page (markdown) or an app (one HTML file with a data store). Missing means page. */
  kind?: "page" | "app";
  /** An app's file. Pages keep `markdown`; an app's `markdown` is "". */
  html?: string;
  /** What someone with the link who isn't signed in may do with an app. Missing means none. */
  visitors?: AppVisitors;
  /** Opens an app on scratch data (<link>?test=<key>), so a worker can try it in a browser without touching what people entered. */
  testKey?: string;
}

/** none: family only. add: guests add records and see their own. all: guests see and change everything. */
export type AppVisitors = "none" | "add" | "all";

/** One kept version of an artifact. */
export interface ArtifactVersion {
  version: number;
  at: string;
  title: string;
  markdown: string;
  html?: string;
  visitors?: AppVisitors;
  /** The issue that wrote it, or who edited it on the website. */
  issue?: number;
  by?: string;
}

/** Something the scout thinks the caller will want, offered on their next calls. */
export interface Suggestion {
  id: string;
  phone: string;
  /** What Kloru offers to do, in the caller's terms. */
  ask: string;
  /** The goal it serves. */
  goal: string;
  /** Why now: what the scout saw. */
  why: string;
  /** A one-off, or something to run on a schedule. */
  kind: "one_off" | "automation";
  issue: number;
  createdAt: string;
  /** Calls it was offered on. */
  offeredOn: string[];
}

/** What the owner's words about a family member come to: who they are, their tier, and what they may do beyond it. */
export interface MemberPlan {
  /** A person, or anyone who calls (the general public: no name or number). */
  who: "person" | "anyone";
  name: string;
  /** E.164. */
  phone: string;
  email?: string;
  /** owner: a co-owner, with the owner's say over everything. */
  tier: "owner" | "partner" | "family" | "friend";
  /** Capabilities granted beyond the tier, already limited to what a member may hold. */
  capabilities: Capability[];
  /** What the words asked for that no member may hold. */
  leftOut: Capability[];
  /** What Kloru says back to the owner for a yes. */
  readBack: string;
  /** The owner's words, verbatim: the member's trust policy. */
  words: string;
}

/** One notification Kloru sent someone (after a call, an owner ask): the history repeats are checked against. */
export interface SentNotification {
  at: string;
  phone: string;
  channel: string;
  subject: string;
  text: string;
  call: string;
  issues: number[];
}
