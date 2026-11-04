import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENESIS, Repo } from "../src/repo.js";

const clock = (iso: string) => () => new Date(iso);
const root = () => mkdtempSync(join(tmpdir(), "repo-"));

describe("Repo", () => {
  it("each call is a directory with its transcript; turns are numbered commits", () => {
    const dir = root();
    const repo = new Repo(dir, clock("2026-10-28T18:03:00Z"));
    const call = repo.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    expect(call.id).toBe("2026-10-28T1803Z-14155550190-CA1");
    expect(repo.addTurn(call.id, { role: "caller", text: "Create an event Wednesday" }).n).toBe(1);
    expect(repo.addTurn(call.id, { role: "kloru", text: "Sure, what's it for?", interrupted: true }).n).toBe(2);
    expect(repo.turns(call.id).map((t) => t.text)).toEqual(["Create an event Wednesday", "Sure, what's it for?"]);
    expect(repo.turns(call.id, 1).map((t) => t.n)).toEqual([2]);
    expect(repo.lastTurn(call.id)).toBe(2);
    expect(existsSync(join(dir, "calls", call.id, "transcript.jsonl"))).toBe(true);
    expect(repo.liveCalls().map((c) => c.id)).toEqual([call.id]);
    repo.endCall(call.id);
    expect(repo.call(call.id)!.endedAt).toBe("2026-10-28T18:03:00.000Z");
    expect(repo.liveCalls()).toEqual([]);
  });

  it("issues get increasing numbers and survive a restart, as do calls, turns and merges", () => {
    const dir = root();
    const repo = new Repo(dir, clock("2026-10-28T18:03:00Z"));
    const call = repo.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    repo.addTurn(call.id, { role: "caller", text: "hi" });
    const a = repo.newIssue({ request: "check Wednesday", filedBy: { phone: "+14155550190", call: call.id }, baseTurn: 1 });
    const b = repo.newIssue({ request: "who drops off", filedBy: { phone: "+14155550190", call: call.id }, baseTurn: 1 });
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a).toMatchObject({ kind: "untriaged", status: "open", resources: [], thread: [], prs: [], links: {} });
    b.status = "in_progress";
    repo.saveIssue(b);
    repo.appendInbox(call.id, { kind: "info", text: "4 events", issue: 1 });
    repo.appendLedger({ issue: 2, call: call.id, phone: "+14155550190", tool: "app_x", slug: "GOOGLECALENDAR_CREATE_EVENT", args: {}, ok: true, result: "ev_9" });

    const again = new Repo(dir, clock("2026-10-28T18:05:00Z"));
    expect(again.issue(2)!.status).toBe("in_progress");
    expect(again.newIssue({ request: "x", filedBy: { phone: "+1", call: call.id }, baseTurn: 0 }).id).toBe(3);
    expect(again.turns(call.id)).toHaveLength(1);
    expect(again.inbox(call.id, 0).map((m) => m.text)).toEqual(["4 events"]);
    expect(again.ledger(2)[0]!.result).toBe("ev_9");
    expect(again.issues((i) => i.status === "open").map((i) => i.id)).toEqual([1, 3]);
    expect(readdirSync(join(dir, "issues")).sort()).toEqual(["1.json", "2.json", "3.json"]);
  });

  it("merges are numbered per call; acknowledging is how delivery is recorded", () => {
    const repo = new Repo(root(), clock("2026-10-28T18:03:00Z"));
    const call = repo.startCall({ callSid: "CA1", phone: "+1555", channel: "voice" });
    repo.appendInbox(call.id, { kind: "info", text: "one" });
    repo.appendInbox(call.id, { kind: "events", text: "two" });
    expect(repo.inbox(call.id, 0).map((m) => m.seq)).toEqual([1, 2]);
    expect(repo.inbox(call.id, 1).map((m) => m.text)).toEqual(["two"]);
    repo.ack(call.id, 1);
    expect(repo.undelivered(call.id).map((m) => m.text)).toEqual(["two"]);
    repo.ack(call.id, 0);
    expect(repo.call(call.id)!.deliveredSeq).toBe(1);
  });

  it("finds a phone's earlier calls, newest first", () => {
    const repo = new Repo(root(), clock("2026-10-28T18:03:00Z"));
    const first = repo.startCall({ callSid: "CA1", phone: "+1555", channel: "voice" });
    const other = repo.startCall({ callSid: "CA2", phone: "+1777", channel: "voice" });
    const second = repo.startCall({ callSid: "CA3", phone: "+1555", channel: "voice" });
    expect(repo.callsFor("+1555").map((c) => c.id)).toEqual([second.id, first.id]);
    expect(other.id).toContain("-1777-");
  });

  it("the ledger is append-only JSON lines", () => {
    const dir = root();
    const repo = new Repo(dir, clock("2026-10-28T18:03:00Z"));
    repo.appendLedger({ issue: 1, call: "c", phone: "+1", tool: "t", slug: "S", args: { a: 1 }, ok: true, result: "r" });
    repo.appendLedger({ issue: 2, call: "c", phone: "+1", tool: "t", slug: "S", args: {}, ok: false, result: "err" });
    const lines = readFileSync(join(dir, "ops", "ledger.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ at: "2026-10-28T18:03:00.000Z", issue: 1, args: { a: 1 } });
    expect(repo.ledger().map((e) => e.issue)).toEqual([1, 2]);
  });
});

describe("Repo: hashes", () => {
  it("each call's turns form a hash chain, and an issue records the head it was based on", () => {
    const dir = root();
    const repo = new Repo(dir, clock("2026-10-28T18:03:00Z"));
    const call = repo.startCall({ callSid: "CA1", phone: "+1555", channel: "voice" });
    expect(repo.head(call.id)).toBe(GENESIS);
    const a = repo.addTurn(call.id, { role: "caller", text: "hi" });
    const b = repo.addTurn(call.id, { role: "kloru", text: "hello" });
    expect(a.parent).toBe(GENESIS);
    expect(b.parent).toBe(a.hash);
    expect(repo.head(call.id)).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.verifyCall(call.id)).toEqual({ ok: true, value: 2 });
    const issue = repo.newIssue({ request: "x", filedBy: { phone: "+1555", call: call.id }, baseTurn: 2 });
    expect(issue.baseHash).toBe(b.hash);
  });

  it("an edited transcript or ledger line breaks verification at that line", () => {
    const dir = root();
    const repo = new Repo(dir, clock("2026-10-28T18:03:00Z"));
    const call = repo.startCall({ callSid: "CA1", phone: "+1555", channel: "voice" });
    repo.addTurn(call.id, { role: "caller", text: "Create an event" });
    repo.addTurn(call.id, { role: "caller", text: "never mind" });
    repo.appendLedger({ issue: 1, call: call.id, phone: "+1555", tool: "t", slug: "S", args: {}, ok: true, result: "ev_9" });
    repo.appendLedger({ issue: 2, call: call.id, phone: "+1555", tool: "t", slug: "S", args: {}, ok: true, result: "deleted" });
    expect(repo.verifyLedger()).toEqual({ ok: true, value: 2 });
    const tFile = join(dir, "calls", call.id, "transcript.jsonl");
    writeFileSync(tFile, readFileSync(tFile, "utf8").replace("never mind", "keep it"));
    const lFile = join(dir, "ops", "ledger.jsonl");
    writeFileSync(lFile, readFileSync(lFile, "utf8").replace("ev_9", "ev_0"));
    const reopened = new Repo(dir, clock("2026-10-28T18:04:00Z"));
    expect(reopened.verifyCall(call.id)).toEqual({ ok: false, error: { at: 2, reason: "hash mismatch" } });
    expect(reopened.verifyLedger()).toEqual({ ok: false, error: { at: 1, reason: "hash mismatch" } });
  });

  it("the Merkle root covers every call head, issue and the ledger, and changes when any of them does", () => {
    const repo = new Repo(root(), clock("2026-10-28T18:03:00Z"));
    const call = repo.startCall({ callSid: "CA1", phone: "+1555", channel: "voice" });
    const r0 = repo.root();
    expect(repo.root()).toEqual(r0);
    repo.addTurn(call.id, { role: "caller", text: "hi" });
    const r1 = repo.root();
    expect(r1.hash).not.toBe(r0.hash);
    const issue = repo.newIssue({ request: "x", filedBy: { phone: "+1555", call: call.id }, baseTurn: 1 });
    const r2 = repo.root();
    expect(r2.children.map((c) => c.name)).toEqual(["calls", "issues", "ledger"]);
    expect(r2.children[0]!.hash).toBe(r1.children[0]!.hash);
    expect(r2.children[1]!.hash).not.toBe(r1.children[1]!.hash);
    issue.status = "in_progress";
    repo.saveIssue(issue);
    expect(repo.root().children[1]!.hash).not.toBe(r2.children[1]!.hash);
  });
});

describe("read-only", () => {
  it("opens a repository without creating anything, so another process can inspect it", async () => {
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(mkdtempSync(join(tmpdir(), "repo-ro-")), "repo");
    const empty = new Repo(dir, undefined, { readOnly: true });
    expect(existsSync(dir)).toBe(false);
    expect(empty.issues()).toEqual([]);
    const w = new Repo(dir);
    const call = w.startCall({ callSid: "CA1", phone: "+1", channel: "voice" });
    w.addTurn(call.id, { role: "caller", text: "hi" });
    const r = new Repo(dir, undefined, { readOnly: true });
    expect(r.turns(call.id)).toHaveLength(1);
    expect(r.verifyCall(call.id).ok).toBe(true);
    expect(r.root().hash).toBe(w.root().hash);
  });
});
