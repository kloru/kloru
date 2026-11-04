import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk, type Planner, type Trigger, type WorkerHost } from "@kloru/desk";
import type { InstinctConfig } from "@kloru/core";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer, type HttpApp } from "../src/http.js";
import { familyCallers } from "../src/boot.js";

const config = { version: 1, owner: { name: "Evan", phones: [], emails: [], timezone: "UTC" }, agent: { name: "Kloru" }, model: { primary: "faux/x" }, computer: { mode: "none" }, apps: { enabled: false, toolkits: [] }, features: {} } as unknown as InstinctConfig;
const TOKEN = "tok";

class Host implements WorkerHost {
  run(): Promise<string> {
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(react: (t: Trigger, d: Desk) => void = () => {}, o: { token?: string | null; callers?: HttpApp["callers"] } = {}) {
  const planner: Planner = { handle: async (ts, d) => ts.forEach((t) => react(t, d)) };
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "routes-")), host: new Host(), planner });
  const app: HttpApp = { runtime: { handleInbound: async () => { throw new Error("unused"); }, stats: () => ({ conversations: 0, busy: 0 }) }, scheduler: { toMaritimeSchedules: () => [] }, config, desk, ...(o.callers ? { callers: o.callers } : {}) };
  const server = createHttpServer(app, { env: {}, ...(o.token === null ? {} : { chatToken: o.token ?? TOKEN }) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
  const call = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { desk, call };
}

describe("desk routes", () => {
  it("say who may call: the owner, and members; nobody else, and nobody when unset", async () => {
    const callers = (p: string) => (p === "+14155550190" ? { allowed: true, name: "Evan", tier: "owner" as const } : p === "+14155550191" ? { allowed: true, name: "Cara", tier: "partner" as const } : { allowed: false });
    const { call } = await start(undefined, { callers });
    expect(await call("GET", "/desk/callers/%2B14155550191")).toEqual({ status: 200, json: { allowed: true, name: "Cara", tier: "partner" } });
    expect((await call("GET", "/desk/callers/%2B14155550123")).json).toEqual({ allowed: false });
  });

  it("with no callers configured, nobody is a member", async () => {
    const { call } = await start();
    expect((await call("GET", "/desk/callers/%2B14155550191")).json).toEqual({ allowed: false });
  });

  it("need the chat token", async () => {
    const { call } = await start();
    expect((await call("POST", "/desk/calls", { callSid: "CA1", phone: "+1" }, "wrong")).status).toBe(401);
  });

  it("a call files issues, posts turns, comments, and reads merges from its inbox", async () => {
    const { desk, call } = await start((t, d) => {
      if (t.kind === "filed") d.resolve(t.issue, "Dentist is at 11:30.");
    });
    const started = await call("POST", "/desk/calls", { callSid: "CA1", phone: "+14155550190" });
    expect(started.status).toBe(200);
    const id = started.json.call.id as string;
    expect(started.json.pending).toBe(0);
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/turns`, { role: "caller", text: "When's the dentist?" })).json).toMatchObject({ n: 1, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const filed = await call("POST", `/desk/calls/${encodeURIComponent(id)}/issues`, { request: "When's the dentist?" });
    expect(filed.json.issue).toMatchObject({ id: 1, status: "open" });
    const inbox = await call("GET", `/desk/calls/${encodeURIComponent(id)}/inbox?after=0&wait=2`);
    expect(inbox.json.items).toEqual([expect.objectContaining({ seq: 1, kind: "info", text: "Dentist is at 11:30." })]);
    expect((await call("POST", "/desk/issues/1/comments", { call: id, text: "thanks" })).json).toEqual({ ok: true });
    expect(desk.repo.call(id)!.deliveredSeq).toBe(0);
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/ack`, { seq: 1 })).json).toEqual({ ok: true });
    expect(desk.repo.call(id)!.deliveredSeq).toBe(1);
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/ack`, { seq: "x" })).status).toBe(400);
    expect((await call("GET", "/desk/issues")).json.issues).toEqual([]);
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/end`, {})).json).toEqual({ ok: true });
    expect(desk.repo.call(id)!.endedAt).toBeTruthy();
  });

  it("the inbox waits, then returns empty at the deadline", async () => {
    const { call } = await start();
    const id = (await call("POST", "/desk/calls", { callSid: "CA1", phone: "+1" })).json.call.id as string;
    const t0 = Date.now();
    expect((await call("GET", `/desk/calls/${encodeURIComponent(id)}/inbox?after=0&wait=0.2`)).json.items).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it("bad input is 400, unknown calls 404, a confirm with nothing waiting 409", async () => {
    const { call } = await start();
    expect((await call("POST", "/desk/calls", { phone: "+1" })).status).toBe(400);
    expect((await call("POST", "/desk/calls/nope/turns", { role: "caller", text: "x" })).status).toBe(404);
    const id = (await call("POST", "/desk/calls", { callSid: "CA1", phone: "+1" })).json.call.id as string;
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/turns`, { role: "robot", text: "x" })).status).toBe(400);
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/issues`, { request: "" })).status).toBe(400);
    expect((await call("POST", "/desk/issues/9/confirm", { call: id, draft: "abc" })).status).toBe(409);
    expect((await call("POST", "/desk/issues/9/confirm", { call: id })).status).toBe(400);
    expect((await call("POST", "/desk/calls/%E0%A4%A/turns", { role: "caller", text: "x" })).status).toBe(400);
    expect((await call("GET", "/desk/nothing")).status).toBe(404);
  });

  it("review leftovers (#20): an ended call takes no new turns or issues, and a huge body is 413", async () => {
    const { call } = await start();
    const id = (await call("POST", "/desk/calls", { callSid: "CA1", phone: "+1" })).json.call.id as string;
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/end`, {})).status).toBe(200);
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/turns`, { role: "caller", text: "x" })).status).toBe(409);
    expect((await call("POST", `/desk/calls/${encodeURIComponent(id)}/issues`, { request: "x" })).status).toBe(409);
    expect((await call("POST", "/desk/calls", { callSid: "CA2", phone: "+1", name: "x".repeat(3_000_000) })).status).toBe(413);
  });

  it("with no token configured, the desk is closed, not open", async () => {
    const open = await start(undefined, { token: null });
    expect((await open.call("GET", "/desk/issues", undefined, "")).status).toBe(401);
  });

  it("a call returns its brief, takes memory notes, and backfill files nothing without memory", async () => {
    const { call } = await start();
    const opened = await call("POST", "/desk/calls", { callSid: "CA7", phone: "+14155550190" });
    expect(opened.json).toMatchObject({ brief: expect.any(String) });
    const id = opened.json.call.id;
    expect((await call("POST", `/desk/calls/${id}/notes`, { text: "Maya is allergic to peanuts" })).status).toBe(200);
    expect((await call("POST", `/desk/calls/${id}/notes`, {})).status).toBe(400);
    expect((await call("POST", "/desk/memory/backfill", {})).json).toEqual({ filed: 0 });
  });

  it("without a desk the routes are 404", async () => {
    const app: HttpApp = { runtime: { handleInbound: async () => { throw new Error("unused"); }, stats: () => ({ conversations: 0, busy: 0 }) }, scheduler: { toMaritimeSchedules: () => [] }, config };
    const server = createHttpServer(app, { env: {}, chatToken: TOKEN });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    close = () => new Promise((r) => server.close(() => r()));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/desk/issues`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });
});

describe("family callers", () => {
  const contacts = { findByPhone: (p: string) => ({ "+14155550191": { name: "Cara", tier: "partner" }, "+14155550100": { name: "Sam", tier: "friend" } } as Record<string, any>)[p] };
  const callers = familyCallers({ name: "Evan", phones: ["+14155550190"] }, contacts as never);
  it("the owner by any spelling of his number, members at partner or family, never a friend or stranger", () => {
    expect(callers("(415) 555-0190")).toEqual({ allowed: true, name: "Evan", tier: "owner" });
    expect(callers("+14155550191")).toEqual({ allowed: true, name: "Cara", tier: "partner" });
    expect(callers("+14155550100")).toEqual({ allowed: false });
    expect(callers("+19995550000")).toEqual({ allowed: false });
    expect(callers("")).toEqual({ allowed: false });
  });
});
