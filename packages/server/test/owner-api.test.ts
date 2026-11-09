import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApprovalStore, AuditLog, ContactStore, PolicyEngine, StateDir, loadPolicy, savePolicy, signOwnerEnvelope } from "@kloru/core";
import { createOwnerApi, type OwnerApiApps, type OwnerApiDeps } from "../src/owner-api.js";

const SECRET = "test-secret";

function setup(extra: Partial<OwnerApiDeps> = {}) {
  const state = new StateDir(mkdtempSync(join(tmpdir(), "owner-api-")));
  const policy = new PolicyEngine(loadPolicy(state));
  const approvals = new ApprovalStore(state);
  const contacts = new ContactStore(state);
  const audit = new AuditLog(state);
  const afterApproval = vi.fn(async () => {});
  const api = createOwnerApi({ secret: SECRET, policy, approvals, contacts, audit, savePolicy: (p) => savePolicy(state, p), afterApproval, status: () => ({ ok: true }), ...extra });
  const call = (op: string, args: Record<string, unknown> = {}) => api.handle(signOwnerEnvelope(SECRET, op, args));
  return { state, policy, approvals, contacts, afterApproval, api, call };
}

describe("owner API", () => {
  it("rejects bad signatures, a missing secret and unknown ops", async () => {
    const { api, call } = setup();
    expect((await api.handle({ type: "owner.api", op: "policy.get", args: {}, at: new Date().toISOString(), sig: "x" })).status).toBe(401);
    expect((await setup({ secret: undefined }).call("policy.get")).status).toBe(401);
    expect((await call("nope.op")).status).toBe(404);
  });

  it("returns status", async () => {
    expect((await setup().call("status.get")).result).toEqual({ ok: true });
  });

  it("sets a permission, saves policy.json and audits via console", async () => {
    const { call, policy, state } = setup();
    expect((await call("policy.setPermission", { tier: "owner", capability: "calendar.write", permission: "ask" })).status).toBe(200);
    expect(policy.permissionFor("owner", "calendar.write")).toBe("ask");
    expect(JSON.parse(readFileSync(state.path("policy.json"), "utf8")).tiers.owner["calendar.write"]).toBe("ask");
    expect(readFileSync(state.path("audit.jsonl"), "utf8")).toContain('"via":"console"');
  });

  it("refuses values outside the enums and saves nothing", async () => {
    const { call, policy } = setup();
    expect((await call("policy.setPermission", { tier: "owner", capability: "calendar.write", permission: "maybe" })).status).toBe(400);
    expect((await call("policy.setPermission", { tier: "root", capability: "calendar.write", permission: "no" })).status).toBe(400);
    expect((await call("policy.setPermission", { tier: "owner", capability: "rm.rf", permission: "no" })).status).toBe(400);
    expect(policy.permissionFor("owner", "calendar.write")).toBe("yes");
  });

  it("policy.get returns the effective table, capabilities and grants", async () => {
    const { call } = setup();
    await call("policy.setPermission", { tier: "owner", capability: "email.send", permission: "ask" });
    const r = (await call("policy.get")).result as { tiers: Record<string, Record<string, string>>; capabilities: string[]; grants: unknown[] };
    expect(r.tiers.owner!["email.send"]).toBe("ask");
    expect(r.tiers.owner!["email.read"]).toBe("yes");
    expect(r.capabilities).toContain("calendar.write");
    expect(r.grants).toEqual([]);
  });

  it("adds and revokes a grant, validating capabilities and amounts", async () => {
    const { call, policy } = setup();
    // A window around today: only a grant active now lists (this test was once dated Oct 27–Nov 1, 2026, and expired).
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const g = (await call("grants.add", { to: "contact:sam", capabilities: ["calendar.write"], maxUsd: 20, windowFrom: day(-1), windowTo: day(30), note: "lunch" })).result as { id: string; scope: unknown };
    expect(g.scope).toEqual({ window: { from: day(-1), to: day(30) }, maxUsd: 20 });
    expect(policy.listGrants("contact:sam")).toHaveLength(1);
    expect((await call("grants.add", { to: "contact:sam", capabilities: ["bogus"] })).status).toBe(400);
    expect((await call("grants.add", { to: "contact:sam", capabilities: [] })).status).toBe(400);
    expect((await call("grants.add", { to: "contact:sam", capabilities: ["purchase"], maxUsd: -5 })).status).toBe(400);
    expect((await call("grants.add", { to: "contact:sam", capabilities: ["calendar.read"], windowFrom: day(-1) })).status).toBe(400);
    expect((await call("grants.revoke", { id: g.id })).status).toBe(200);
    expect(policy.listGrants("contact:sam")).toHaveLength(0);
    expect((await call("grants.revoke", { id: g.id })).status).toBe(404);
  });

  it("upserts contacts with normalized phones and refuses bad tiers", async () => {
    const { call } = setup();
    const c = (await call("contacts.upsert", { name: "Sam Lee", phones: ["(415) 555-0190"], emails: ["Sam@X.com"], tier: "friend" })).result as { phones: string[]; emails: string[]; tier: string };
    expect(c.phones).toEqual(["+14155550190"]);
    expect(c.emails).toEqual(["sam@x.com"]);
    expect(c.tier).toBe("friend");
    expect(((await call("contacts.list")).result as unknown[]).length).toBe(1);
    expect((await call("contacts.upsert", { name: "X", tier: "overlord" })).status).toBe(400);
    expect((await call("contacts.upsert", { name: "X", tier: "owner" })).status).toBe(400);
    expect((await call("contacts.upsert", { name: "Bot", tier: "staff" })).status).toBe(400);
  });

  it("settles approvals, resumes the conversation, and a second settle is 409", async () => {
    const { call, approvals, afterApproval } = setup();
    const a = approvals.create({ conversationKey: "chat:x", requestedBy: "owner", summary: "Create event Lunch", capability: "calendar.write" });
    expect(((await call("approvals.list")).result as Array<{ token: string }>)[0]!.token).toBe(a.token);
    expect((await call("approvals.settle", { token: a.token.toLowerCase(), approved: true })).status).toBe(200);
    expect(afterApproval).toHaveBeenCalledWith(expect.objectContaining({ token: a.token, status: "approved" }), true);
    expect((await call("approvals.settle", { token: a.token, approved: true })).status).toBe(409);
  });

  it("settle returns before the resumed conversation finishes, and a resume failure doesn't fail it", async () => {
    let finish: () => void = () => {};
    const { call, approvals } = setup({ afterApproval: () => new Promise<void>((r) => { finish = r; }) });
    const a = approvals.create({ conversationKey: "chat:slow", requestedBy: "owner", summary: "Long task", capability: "calendar.write" });
    const out = await Promise.race([call("approvals.settle", { token: a.token, approved: true }), new Promise((r) => setTimeout(() => r("timeout"), 200))]);
    expect(out).toMatchObject({ status: 200 });
    finish();
    const b = setup({ afterApproval: async () => { throw new Error("model down"); } });
    const t = b.approvals.create({ conversationKey: "chat:boom", requestedBy: "owner", summary: "X", capability: "calendar.write" });
    expect((await b.call("approvals.settle", { token: t.token, approved: true })).status).toBe(200);
  });

  it("a null or non-numeric dollar cap is refused, not treated as no cap", async () => {
    const { call, policy } = setup();
    expect((await call("grants.add", { to: "contact:sam", capabilities: ["purchase"], maxUsd: null })).status).toBe(400);
    expect((await call("grants.add", { to: "contact:sam", capabilities: ["purchase"], maxUsd: "abc" })).status).toBe(400);
    expect(policy.listGrants("contact:sam")).toHaveLength(0);
  });

  it("money and phone calls need confirm to approve, but deny freely", async () => {
    const { call, approvals } = setup();
    const buy = approvals.create({ conversationKey: "chat:y", requestedBy: "owner", summary: "Buy tickets", capability: "purchase", amountUsd: 40 });
    expect((await call("approvals.settle", { token: buy.token, approved: true })).status).toBe(400);
    expect((await call("approvals.settle", { token: buy.token, approved: true, confirm: true })).status).toBe(200);
    const dial = approvals.create({ conversationKey: "chat:z", requestedBy: "owner", summary: "Call the dentist", capability: "phone.call" });
    expect((await call("approvals.settle", { token: dial.token, approved: false })).status).toBe(200);
  });

  it("apps ops go through the Composio adapter, and 503 without one", async () => {
    const apps: OwnerApiApps = {
      connectedToolkits: vi.fn(async () => [{ slug: "gmail", connected: true }, { slug: "googlecalendar", connected: false }]),
      accounts: vi.fn(async () => [
        { id: "ca_1", toolkit: "gmail", email: "evan@gmail.com", status: "connected" as const },
        { id: "ca_2", toolkit: "gmail", email: "evan@work.example.com", status: "connected" as const },
      ]),
      connectLink: vi.fn(async () => "https://composio/x"),
      disconnect: vi.fn(async () => 1),
      disconnectAccount: vi.fn(async () => undefined),
    };
    const { call } = setup({ apps });
    expect((await call("apps.list")).result).toEqual([
      { slug: "gmail", connected: true, accounts: [{ id: "ca_1", email: "evan@gmail.com", status: "connected" }, { id: "ca_2", email: "evan@work.example.com", status: "connected" }] },
      { slug: "googlecalendar", connected: false, accounts: [] },
    ]);
    expect((await call("apps.connect", { toolkit: "gmail", callbackUrl: "https://app/return" })).result).toEqual({ url: "https://composio/x" });
    expect(apps.connectLink).toHaveBeenCalledWith("gmail", "https://app/return");
    await call("apps.connect", { toolkit: "gmail", callbackUrl: "https://app/connect/t/done", person: "cara" });
    expect(apps.connectLink).toHaveBeenLastCalledWith("gmail", "https://app/connect/t/done", { person: "cara" });
    expect((await call("apps.disconnect", { toolkit: "gmail" })).result).toEqual({ ok: true, removed: 1 });
    expect((await call("apps.disconnect", { toolkit: "gmail", account: "ca_2" })).result).toEqual({ ok: true, removed: 1 });
    expect(apps.disconnectAccount).toHaveBeenCalledWith("ca_2");
    expect((await setup().call("apps.list")).status).toBe(503);
  });

  it("searches the apps that can be connected, best first, with how many matched", async () => {
    const base = { connectedToolkits: async () => [], accounts: async () => [], connectLink: async () => undefined, disconnect: async () => 0, disconnectAccount: async () => undefined };
    const catalog = [
      { slug: "gmail", name: "Gmail", description: "Email", category: "email" },
      { slug: "github", name: "GitHub", description: "Code hosting", category: "developer tools" },
      { slug: "gitlab", name: "GitLab", description: "DevOps", category: "developer tools" },
    ];
    const { call } = setup({ apps: { ...base, catalog: async () => catalog } });
    expect((await call("apps.catalog", { q: "git" })).result).toEqual({ apps: [catalog[1], catalog[2]], total: 2 });
    expect((await call("apps.catalog", { q: "git", limit: 1 })).result).toEqual({ apps: [catalog[1]], total: 2 });
    expect((await setup({ apps: base }).call("apps.catalog", { q: "git" })).status).toBe(503);
  });

  it("an adapter failure is a 502 with its message, not a throw", async () => {
    const apps: OwnerApiApps = { connectedToolkits: async () => { throw new Error("composio down"); }, accounts: async () => [], connectLink: async () => undefined, disconnect: async () => 0, disconnectAccount: async () => undefined };
    expect(await setup({ apps }).call("apps.list")).toEqual({ status: 502, result: { error: "composio down" } });
  });
});

describe("texting.status", () => {
  it("for a phone, or for a family member by contact id", async () => {
    const asked: string[] = [];
    const { call, contacts } = setup({ texting: (phone) => (asked.push(phone), { number: "+16504849720", texted: phone === "+14155550191" ? "2026-10-31T09:00:00Z" : undefined }) as never });
    const cara = contacts.upsert({ name: "Cara", phones: ["+14155550191"], tier: "partner" } as never);
    expect((await call("texting.status", { phone: "+14155550190" })).result).toEqual({ number: "+16504849720" });
    expect((await call("texting.status", { person: cara.id })).result).toMatchObject({ texted: "2026-10-31T09:00:00Z" });
    expect(asked).toEqual(["+14155550190", "+14155550191"]);
    expect((await call("texting.status", { person: "nobody" })).status).toBe(404);
  });

  it("an agent without texting says so plainly", async () => {
    const { call } = setup();
    expect((await call("texting.status", { phone: "+14155550190" })).result).toEqual({});
  });
});

describe("payments from the console", () => {
  it("status and the Link sign-in link, when the wallet is set up", async () => {
    let connected = false;
    const wallet = { authorizeUrl: () => ({ url: "https://login.link.com/authorize?state=x", state: "x" }), handleCallback: async () => undefined, isConnected: () => connected, revoke: async () => undefined };
    const { call } = setup({ payments: { wallet, test: true } });
    expect((await call("payments.status")).result).toEqual({ configured: true, connected: false, test: true });
    expect((await call("payments.connect")).result).toEqual({ url: "https://login.link.com/authorize?state=x" });
    connected = true;
    expect((await call("payments.status")).result).toMatchObject({ connected: true });
  });

  it("not set up: says so, and gives no link", async () => {
    const { call } = setup();
    expect((await call("payments.status")).result).toEqual({ configured: false, connected: false });
    expect((await call("payments.connect")).status).toBe(503);
  });
});

describe("owner API: automations (recurring jobs)", () => {
  const entries = () => [
    { id: "s_1", name: "Morning debrief", prompt: "Text me my day", cron: "0 7 * * 1-5", tz: "America/Los_Angeles", enabled: true, target: "desk", phone: "+14155550190", nextRunAt: "2026-11-02T15:00:00.000Z", createdAt: "x" },
    { id: "s_2", prompt: "agent heartbeat", cron: "*/5 * * * *", tz: "UTC", enabled: true, createdAt: "x" },
  ];
  function withAutomations() {
    const list = entries();
    const automations = {
      list: () => list.map((e) => ({ ...e })),
      setEnabled: (id: string, enabled: boolean) => {
        const e = list.find((x) => x.id === id);
        if (e) e.enabled = enabled;
        return e;
      },
      delete: (id: string) => {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list.splice(i, 1);
        return i >= 0;
      },
      nameOf: (phone: string) => (phone === "+14155550190" ? "Evan" : undefined),
    };
    return { list, ...setup({ automations }) };
  }

  it("lists the desk's automations in words, with who each is for; never the agent's own jobs", async () => {
    const { call } = withAutomations();
    expect((await call("automations.list")).result).toEqual([
      { id: "s_1", name: "Morning debrief", when: "weekdays at 7:00 AM", request: "Text me my day", enabled: true, nextRunAt: "2026-11-02T15:00:00.000Z", for: "Evan" },
    ]);
  });

  it("pauses, resumes and deletes one; an unknown or non-desk id is a 404", async () => {
    const { call, list } = withAutomations();
    expect((await call("automations.pause", { id: "s_1", enabled: false })).status).toBe(200);
    expect(list[0]!.enabled).toBe(false);
    await call("automations.pause", { id: "s_1", enabled: true });
    expect(list[0]!.enabled).toBe(true);
    expect((await call("automations.pause", { id: "s_2", enabled: false })).status).toBe(404);
    expect((await call("automations.delete", { id: "s_1" })).status).toBe(200);
    expect(list.map((e) => e.id)).toEqual(["s_2"]);
    expect((await call("automations.delete", { id: "s_1" })).status).toBe(404);
  });

  it("not set up: a 503", async () => {
    const { call } = setup();
    expect((await call("automations.list")).status).toBe(503);
  });
});

describe("owner API: editing a page from the website", () => {
  it("saves the page through the desk as the signed-in person, so it's a new version", async () => {
    const seen: unknown[] = [];
    const { call } = setup({ artifacts: { update: (id, markdown, phone, by) => (seen.push({ id, markdown, phone, by }), { ok: true, value: { id, url: `https://kloru.com/a/${id}`, version: 3 } }) } });
    const r = await call("artifacts.update", { id: "Qm9vZ2xlR29vZ2xlR29vZ2", markdown: "# Flights", phone: "+14155550190", by: "link" });
    expect(r).toMatchObject({ status: 200, result: { ok: true, version: 3 } });
    expect(seen).toEqual([{ id: "Qm9vZ2xlR29vZ2xlR29vZ2", markdown: "# Flights", phone: "+14155550190", by: "link" }]);
  });

  it("a page the person may not edit is a 404; no desk is a 503", async () => {
    const { call } = setup({ artifacts: { update: () => ({ ok: false, error: "no page x for this caller" }) } });
    expect((await call("artifacts.update", { id: "x", markdown: "y", phone: "+1" })).status).toBe(404);
    expect((await setup().call("artifacts.update", { id: "x", markdown: "y", phone: "+1" })).status).toBe(503);
  });
});

describe("owner API: who's in the family", () => {
  it("family.lookup says owner, member or nobody, for website sign-in", async () => {
    const { call } = setup({ family: (phone) => (phone === "+14155550191" ? { role: "owner", name: "Cara" } : phone === "+14155550123" ? { role: "member", name: "Dad", person: "dad" } : undefined) });
    expect((await call("family.lookup", { phone: "+14155550191" })).result).toEqual({ role: "owner", name: "Cara" });
    expect((await call("family.lookup", { phone: "+14155550123" })).result).toEqual({ role: "member", name: "Dad", person: "dad" });
    expect((await call("family.lookup", { phone: "+14155550199" })).result).toBeNull();
  });
});
