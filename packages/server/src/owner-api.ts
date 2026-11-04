/**
 * Owner operations from the Kloru console. They arrive as signed `owner.api`
 * envelopes on /chat (see core/owner-envelope.ts) and never reach the model. Each
 * one touches the same stores the trust tools and approval replies use, and every
 * change is audited with `via: "console"`.
 *
 * A click on the console is the owner's own action, authenticated by their session,
 * so it may settle approvals the model's `approval_settle` tool may not (money,
 * phone calls), but only with an explicit `confirm: true`.
 */
import { ALL_CAPABILITIES, DEFAULT_TIER_TABLE, SPEND_CAPABILITIES, verifyOwnerEnvelope } from "@kloru/core";
import type { Approval, ApprovalStore, AuditLog, Capability, ContactStore, Permission, Policy, PolicyEngine, ScheduleEntry, Tier } from "@kloru/core";
import { describeWhen } from "@kloru/desk";

const TIERS: readonly Tier[] = ["owner", "staff", "partner", "family", "friend", "contact", "stranger"];
const PERMISSIONS: readonly Permission[] = ["yes", "ask", "limit", "no", "intro", "partial"];

/** The slice of ComposioApps the console needs. */
export interface OwnerApiApps {
  connectedToolkits(): Promise<Array<{ slug: string; connected: boolean }>>;
  accounts(): Promise<Array<{ id: string; toolkit: string; email?: string; status: "connected" | "expired" }>>;
  connectLink(toolkit: string, callbackUrl?: string, o?: { person?: string }): Promise<string | undefined>;
  disconnect(toolkit: string): Promise<number>;
  disconnectAccount(id: string): Promise<void>;
}

export interface OwnerApiDeps {
  /** OWNER_API_SECRET. Unset: every envelope is refused. */
  secret?: string;
  policy: PolicyEngine;
  approvals: ApprovalStore;
  contacts: ContactStore;
  audit: AuditLog;
  savePolicy(policy: Policy): void;
  /** Wake the conversation that was waiting (runtime.afterApproval). */
  afterApproval(approval: Approval, approved: boolean): Promise<void>;
  status(): Record<string, unknown>;
  apps?: OwnerApiApps;
  /** Whether texting works for this phone yet (the desk knows); unset: this agent doesn't text. */
  texting?: (phone: string) => Record<string, unknown>;
  /** The family's Stripe Link wallet, when payments are set up. */
  payments?: { wallet: { authorizeUrl(): { url: string }; isConnected(): boolean }; test?: boolean };
  /** The scheduler's automations (recurring jobs made on a call), and who each is for. */
  automations?: {
    list(): ScheduleEntry[];
    setEnabled(id: string, enabled: boolean): unknown;
    delete(id: string): boolean;
    nameOf?(phone: string): string | undefined;
  };
  /** Pages edited on the website: saved through the desk, as the person editing, as a new version. */
  artifacts?: { update(id: string, markdown: string, phone: string, by: string): { ok: true; value: { id: string; url: string; version: number } } | { ok: false; error: string } };
  /** Each person's own policy.md, read and replaced for that person only (the website passes the signed-in phone). */
  policies?: { get(phone: string): string; set(phone: string, body: string): { ok: true; value: string } | { ok: false; error: string } };
  /** The vault, by the signed-in person's phone: their own entries only; values are never returned. */
  vault?: {
    list(phone: string): Array<{ name: string; kind: string; meta: Record<string, unknown>; createdAt: string; usedAt?: string; createdBy?: string }>;
    /** The person's own entries with their values, for the download on kloru.com. */
    export(phone: string): Array<{ name: string; kind: string; meta: Record<string, unknown>; secret: Record<string, string>; createdBy: string }>;
    add(phone: string, e: { name: string; kind: string; meta: Record<string, unknown>; secret: Record<string, string> }): { ok: true } | { ok: false; error: string };
    remove(phone: string, name: string): boolean;
  };
  /** A person finishing a step in Kloru's browser by hand: only through their own takeover link. */
  takeover?: {
    frame(token: string, phone: string): Promise<{ image: string; width: number; height: number; url: string; title: string; reason: string } | undefined>;
    input(token: string, phone: string, e: { kind: "click"; x: number; y: number } | { kind: "type"; text: string } | { kind: "key"; key: string } | { kind: "scroll"; dy: number }): Promise<boolean>;
    done(token: string, phone: string): boolean;
  };
  /** Who a phone is in the family (an owner or a member), for website sign-in; undefined: nobody in it. */
  family?: (phone: string) => { role: "owner" | "member"; name: string; person?: string } | undefined;
  /** How many conversations (calls, text threads) this phone has had with Kloru, for the Get started page. */
  conversations?: (phone: string) => number;
  /** The admin metrics: cost a day, what got done, time saved, who uses it (metrics.ts). */
  metrics?: { report(days?: number): Promise<unknown> };
  now?: () => Date;
  log?: (message: string) => void;
}

export interface OwnerApiResult {
  status: number;
  result: unknown;
}

export interface OwnerApi {
  handle(event: unknown): Promise<OwnerApiResult>;
}

class OwnerApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const bad = (message: string) => new OwnerApiError(400, message);
const ok = (result: unknown): OwnerApiResult => ({ status: 200, result });
const fail = (status: number, error: string): OwnerApiResult => ({ status, result: { error } });

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw bad(`${name} is required`);
  return v.trim();
}

function strList(v: unknown, name: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad(`${name} must be a list of strings`);
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

function tierOf(v: unknown): Tier {
  if (!TIERS.includes(v as Tier)) throw bad("unknown tier");
  return v as Tier;
}

function capOf(v: unknown): Capability {
  if (!ALL_CAPABILITIES.includes(v as Capability)) throw bad(`unknown capability ${String(v)}`);
  return v as Capability;
}

function permOf(v: unknown): Permission {
  if (!PERMISSIONS.includes(v as Permission)) throw bad("unknown permission");
  return v as Permission;
}

export function createOwnerApi(deps: OwnerApiDeps): OwnerApi {
  const now = deps.now ?? (() => new Date());
  const audit = (op: string, detail: Record<string, unknown>) =>
    deps.audit.append({ kind: "policy", principal: "owner", detail: { via: "console", op, ...detail } });
  const persist = () => deps.savePolicy(deps.policy.toJSON());
  const automations = (): NonNullable<OwnerApiDeps["automations"]> => {
    if (!deps.automations) throw new OwnerApiError(503, "automations are not set up on this agent");
    return deps.automations;
  };
  const apps = (): OwnerApiApps => {
    if (!deps.apps) throw new OwnerApiError(503, "apps are not configured on this agent");
    return deps.apps;
  };

  const ops: Record<string, (args: Record<string, unknown>) => Promise<OwnerApiResult> | OwnerApiResult> = {
    "status.get": () => ok(deps.status()),
    "metrics.get": async (a) => (deps.metrics ? ok(await deps.metrics.report(Math.min(Math.max(Number(a.days) || 30, 1), 90))) : fail(404, "metrics aren't kept here")),
    "family.lookup": (a) => ok(deps.family?.(String(a.phone ?? "")) ?? null),
    "vault.list": (a) => (deps.vault ? ok(deps.vault.list(String(a.phone ?? ""))) : fail(404, "the vault isn't set up here")),
    "vault.add": (a) => {
      if (!deps.vault) return fail(404, "the vault isn't set up here");
      const e = a.entry as { name?: unknown; kind?: unknown; meta?: unknown; secret?: unknown } | undefined;
      if (!e || typeof e.name !== "string" || typeof e.kind !== "string" || typeof e.secret !== "object" || !e.secret) return fail(400, "entry needs name, kind and secret");
      const r = deps.vault.add(String(a.phone ?? ""), { name: e.name, kind: e.kind, meta: (e.meta ?? {}) as Record<string, unknown>, secret: e.secret as Record<string, string> });
      if (r.ok) deps.audit.append({ kind: "policy", principal: "console", detail: { action: "vault_add", phone: String(a.phone ?? ""), name: e.name, kind: e.kind } });
      return r.ok ? ok({ saved: e.name }) : fail(400, r.error);
    },
    "takeover.frame": async (a) => {
      const f = deps.takeover ? await deps.takeover.frame(String(a.token ?? ""), String(a.phone ?? "")) : undefined;
      return f ? ok(f) : fail(404, "this link has ended");
    },
    "takeover.input": async (a) => {
      const done = deps.takeover ? await deps.takeover.input(String(a.token ?? ""), String(a.phone ?? ""), a.input as never) : false;
      return done ? ok({ ok: true }) : fail(404, "this link has ended");
    },
    "takeover.done": (a) => (deps.takeover?.done(String(a.token ?? ""), String(a.phone ?? "")) ? ok({ done: true }) : fail(404, "this link has ended")),
    "vault.export": (a) => {
      if (!deps.vault) return fail(404, "the vault isn't set up here");
      const all = deps.vault.export(String(a.phone ?? ""));
      deps.audit.append({ kind: "policy", principal: "console", detail: { action: "vault_export", phone: String(a.phone ?? ""), names: all.map((e) => e.name) } });
      return ok(all);
    },
    "vault.remove": (a) => {
      if (!deps.vault) return fail(404, "the vault isn't set up here");
      const removed = deps.vault.remove(String(a.phone ?? ""), String(a.name ?? ""));
      if (removed) deps.audit.append({ kind: "policy", principal: "console", detail: { action: "vault_remove", phone: String(a.phone ?? ""), name: String(a.name ?? "") } });
      return removed ? ok({ removed: true }) : fail(404, "no such entry of yours");
    },
    "mypolicy.get": (a) => (deps.policies ? ok({ text: deps.policies.get(String(a.phone ?? "")) }) : fail(404, "policies aren't kept here")),
    "mypolicy.set": (a) => {
      if (!deps.policies) return fail(404, "policies aren't kept here");
      if (typeof a.text !== "string" || a.text.length > 20_000) return fail(400, "text must be a string under 20,000 characters");
      const r = deps.policies.set(String(a.phone ?? ""), a.text);
      if (r.ok) deps.audit.append({ kind: "policy", principal: "console", detail: { action: "policy_md_set", phone: String(a.phone ?? ""), commit: r.value } });
      return r.ok ? ok({ commit: r.value }) : fail(400, r.error);
    },

    // Each app with every account connected to it (a personal and a work Gmail).
    "apps.list": async () => {
      const [status, accounts] = await Promise.all([apps().connectedToolkits(), apps().accounts()]);
      return ok(status.map((t) => ({ ...t, accounts: accounts.filter((a) => a.toolkit === t.slug).map(({ toolkit: _, ...a }) => a) })));
    },
    "apps.connect": async (a) => {
      const toolkit = str(a.toolkit, "toolkit");
      const callbackUrl = typeof a.callbackUrl === "string" && a.callbackUrl ? a.callbackUrl : undefined;
      // From a family member's link: the account this creates is hers.
      const person = typeof a.person === "string" && a.person ? a.person : undefined;
      const url = person ? await apps().connectLink(toolkit, callbackUrl, { person }) : await apps().connectLink(toolkit, callbackUrl);
      audit("apps.connect", { toolkit, ...(person ? { person } : {}) });
      return url ? ok({ url }) : fail(400, "this app needs no sign-in");
    },
    "apps.disconnect": async (a) => {
      const toolkit = str(a.toolkit, "toolkit");
      if (typeof a.account === "string" && a.account) {
        await apps().disconnectAccount(a.account);
        audit("apps.disconnect", { toolkit, account: a.account });
        return ok({ ok: true, removed: 1 });
      }
      const removed = await apps().disconnect(toolkit);
      audit("apps.disconnect", { toolkit, removed });
      return ok({ ok: true, removed });
    },

    // The connect pages: Kloru's texting number, and whether this person has texted with it yet.
    // The Get started page: what this person has set up so far. Each step is something they can see and do.
    "setup.status": async (a) => {
      const phone = str(a.phone, "phone");
      const connected = deps.apps ? await apps().connectedToolkits().then((t) => t.filter((x) => x.connected).map((x) => x.slug), () => [] as string[]) : [];
      return ok({
        apps: connected,
        family: deps.contacts.all().length,
        texting: deps.texting?.(phone) ?? {},
        vault: deps.vault ? deps.vault.list(phone).length : 0,
        policy: !!deps.policies?.get(phone).trim(),
        conversations: deps.conversations?.(phone) ?? 0,
      });
    },
    "texting.status": (a) => {
      const phone = typeof a.person === "string" && a.person ? deps.contacts.get(a.person)?.phones[0] : str(a.phone, "phone");
      if (!phone) return fail(404, "no such person");
      return ok(deps.texting?.(phone) ?? {});
    },

    // Recurring jobs made on a call (target "desk"); the agent's own jobs aren't the family's to change.
    "automations.list": () => {
      const list = automations().list().filter((e) => e.target === "desk");
      return ok(list.map((e) => ({
        id: e.id,
        name: e.name ?? "Untitled",
        when: describeWhen(e.cron, e.cron ? undefined : e.nextRunAt, e.tz),
        request: e.prompt,
        enabled: e.enabled,
        ...(e.nextRunAt ? { nextRunAt: e.nextRunAt } : {}),
        ...(e.lastRunAt ? { lastRunAt: e.lastRunAt } : {}),
        ...(e.phone ? { for: automations().nameOf?.(e.phone) ?? e.phone } : {}),
      })));
    },
    "automations.pause": (a) => {
      const id = str(a.id, "id");
      if (typeof a.enabled !== "boolean") throw bad("enabled must be true or false");
      if (!automations().list().some((e) => e.id === id && e.target === "desk")) return fail(404, "no such automation");
      automations().setEnabled(id, a.enabled);
      audit("automations.pause", { id, enabled: a.enabled });
      return ok({ ok: true });
    },
    "automations.delete": (a) => {
      const id = str(a.id, "id");
      if (!automations().list().some((e) => e.id === id && e.target === "desk")) return fail(404, "no such automation");
      automations().delete(id);
      audit("automations.delete", { id });
      return ok({ ok: true });
    },

    "artifacts.update": (a) => {
      if (!deps.artifacts) return fail(503, "pages aren't set up on this agent");
      const id = str(a.id, "id");
      const phone = str(a.phone, "phone");
      if (typeof a.markdown !== "string" || !a.markdown.trim()) throw bad("markdown is required");
      const by = typeof a.by === "string" && a.by.trim() ? a.by.trim().slice(0, 40) : phone;
      const r = deps.artifacts.update(id, a.markdown, phone, by);
      if (!r.ok) return fail(404, r.error);
      audit("artifacts.update", { id, version: r.value.version, by });
      return ok({ ok: true, version: r.value.version });
    },

    "payments.status": () => {
      const p = deps.payments;
      return ok(p ? { configured: true, connected: p.wallet.isConnected(), test: !!p.test } : { configured: false, connected: false });
    },
    "payments.connect": () => {
      if (!deps.payments) return fail(503, "payments are not set up on this agent");
      audit("payments.connect", {});
      return ok({ url: deps.payments.wallet.authorizeUrl().url });
    },

    "policy.get": () => {
      const policy = deps.policy.toJSON();
      const tiers = Object.fromEntries(TIERS.map((t) => [t, Object.fromEntries(ALL_CAPABILITIES.map((c) => [c, deps.policy.permissionFor(t, c)]))]));
      return ok({ capabilities: ALL_CAPABILITIES, tiers, defaults: DEFAULT_TIER_TABLE, overrides: policy.tiers, grants: deps.policy.listGrants(), spend: policy.spend });
    },
    "policy.setPermission": (a) => {
      const tier = tierOf(a.tier);
      const capability = capOf(a.capability);
      const permission = permOf(a.permission);
      deps.policy.setTierOverride(tier, capability, permission);
      persist();
      audit("policy.setPermission", { tier, capability, permission });
      return ok({ ok: true });
    },

    "grants.add": (a) => {
      const to = str(a.to, "to");
      const capabilities = strList(a.capabilities, "capabilities").map(capOf);
      if (capabilities.length === 0) throw bad("pick at least one capability");
      const from = typeof a.windowFrom === "string" && a.windowFrom.trim() ? a.windowFrom.trim() : undefined;
      const until = typeof a.windowTo === "string" && a.windowTo.trim() ? a.windowTo.trim() : undefined;
      if (Boolean(from) !== Boolean(until)) throw bad("give both a start and an end date, or neither");
      if ((from && !Number.isFinite(Date.parse(from))) || (until && !Number.isFinite(Date.parse(until)))) throw bad("dates must look like 2026-10-27");
      // Absent means no cap; null, "" or anything non-numeric is refused rather than read as "no cap".
      const maxUsd = a.maxUsd === undefined ? undefined : typeof a.maxUsd === "number" || (typeof a.maxUsd === "string" && a.maxUsd.trim() !== "") ? Number(a.maxUsd) : Number.NaN;
      if (maxUsd !== undefined && (!Number.isFinite(maxUsd) || maxUsd < 0)) throw bad("the dollar cap must be a positive number");
      const window = from && until ? { from, to: until } : undefined;
      const scope = { ...(window ? { window } : {}), ...(maxUsd !== undefined ? { maxUsd } : {}) };
      const grant = deps.policy.addGrant({
        to,
        capabilities,
        ...(Object.keys(scope).length > 0 ? { scope } : {}),
        ...(typeof a.expiresAt === "string" && a.expiresAt ? { expiresAt: a.expiresAt } : {}),
        ...(typeof a.note === "string" && a.note.trim() ? { note: a.note.trim() } : {}),
      });
      persist();
      audit("grants.add", { grant: grant.id, to, capabilities });
      return ok(grant);
    },
    "grants.revoke": (a) => {
      const id = str(a.id, "id");
      if (!deps.policy.revokeGrant(id)) return fail(404, "no such grant");
      persist();
      audit("grants.revoke", { grant: id });
      return ok({ ok: true });
    },

    "approvals.list": () =>
      ok(deps.approvals.pending().map((p) => ({ token: p.token, summary: p.summary, capability: p.capability, amountUsd: p.amountUsd, createdAt: p.createdAt, expiresAt: p.expiresAt }))),
    "approvals.settle": async (a) => {
      const token = str(a.token, "token").toUpperCase();
      const approved = a.approved === true;
      const target = deps.approvals.pending().find((p) => p.token === token);
      if (!target) return fail(409, "that approval is no longer pending");
      const sensitive = SPEND_CAPABILITIES.has(target.capability) || target.amountUsd !== undefined || target.capability === "phone.call";
      if (approved && sensitive && a.confirm !== true) throw bad("this approval needs confirmation");
      const resolved = deps.approvals.resolve(token, approved);
      if (!resolved) return fail(409, "that approval is no longer pending");
      deps.audit.append({ kind: "approval", conversationKey: resolved.conversationKey, principal: "owner", detail: { via: "console", token, status: resolved.status, summary: resolved.summary } });
      // The resumed conversation can run for minutes; the console only needs to know the verdict landed.
      void Promise.resolve()
        .then(() => deps.afterApproval(resolved, approved))
        .catch((err: unknown) => deps.log?.(`approval ${token}: resuming the conversation failed: ${(err as Error).message}`));
      return ok({ ok: true, summary: resolved.summary, status: resolved.status });
    },

    "contacts.list": () => ok(deps.contacts.all()),
    "contacts.upsert": (a) => {
      const tier = tierOf(a.tier ?? "contact");
      if (tier === "owner") throw bad("the owner tier cannot be given to a contact");
      const contact = deps.contacts.upsert({
        ...(typeof a.id === "string" && a.id ? { id: a.id } : {}),
        name: str(a.name, "name"),
        phones: strList(a.phones, "phones"),
        emails: strList(a.emails, "emails"),
        tier,
      });
      audit("contacts.upsert", { contact: contact.id, tier });
      return ok(contact);
    },
  };

  return {
    async handle(event) {
      const check = verifyOwnerEnvelope(deps.secret, event, now());
      if (!check.ok) return fail(401, check.error);
      const op = ops[check.env.op];
      if (!op) return fail(404, `unknown op ${check.env.op}`);
      try {
        return await op(check.env.args);
      } catch (err) {
        if (err instanceof OwnerApiError) return fail(err.status, err.message);
        // The contact store refuses staff without an agent handle; that is the caller's mistake.
        if ((err as Error).name === "StaffNeedsAgentError" || (err as Error).constructor?.name === "StaffNeedsAgentError") return fail(400, (err as Error).message);
        return fail(502, (err as Error).message);
      }
    },
  };
}
