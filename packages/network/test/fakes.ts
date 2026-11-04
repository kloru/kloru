import type {
  AuditEntry,
  AuditLog,
  Contact,
  ContactStore,
  Grant,
  InstinctConfig,
  Outbox,
  OutboundMessage,
  Policy,
  PolicyEngine,
  Principal,
  RegisteredTool,
  Tier,
  ToolContext,
} from "@kloru/core";
import type { A2aLike, ProvisionerLike } from "../src/tools.js";
import { phoneKey, slugify } from "../src/lookup.js";

/** In-memory ContactStore matching the core contract. Ids are name slugs, phones normalized. */
export function fakeContacts(initial: Array<Partial<Contact> & { name: string }> = []): ContactStore {
  const rows = new Map<string, Contact>();
  const now = () => "2026-10-03T12:00:00.000Z";
  const store = {
    all: () => [...rows.values()],
    get: (id: string) => rows.get(id),
    findByPhone: (phone: string) => [...rows.values()].find((c) => c.phones.includes(phoneKey(phone))),
    findByEmail: (email: string) => [...rows.values()].find((c) => c.emails.includes(email.toLowerCase())),
    findByHandle: (handle: string) => [...rows.values()].find((c) => c.agentHandle === handle.replace(/^@/, "").toLowerCase()),
    search: (q: string) => {
      const needle = q.toLowerCase();
      return [...rows.values()].filter((c) => c.name.toLowerCase().includes(needle) || c.emails.some((e) => e.includes(needle)) || c.phones.some((p) => p.includes(needle)));
    },
    upsert: (input: Partial<Contact> & { name: string }) => {
      const id = input.id ?? slugify(input.name);
      const prev = rows.get(id);
      const c: Contact = {
        id,
        name: input.name,
        tier: input.tier ?? prev?.tier ?? "stranger",
        phones: (input.phones ?? prev?.phones ?? []).map(phoneKey),
        emails: (input.emails ?? prev?.emails ?? []).map((e) => e.toLowerCase()),
        agentHandle: input.agentHandle ?? prev?.agentHandle,
        notes: input.notes ?? prev?.notes,
        createdAt: prev?.createdAt ?? now(),
        updatedAt: now(),
      };
      rows.set(id, c);
      return c;
    },
    setTier: (id: string, tier: Tier) => {
      const c = rows.get(id);
      if (!c) return undefined;
      c.tier = tier;
      return c;
    },
    remove: (id: string) => rows.delete(id),
  };
  for (const c of initial) store.upsert(c);
  return store as unknown as ContactStore;
}

export function fakePolicy(): PolicyEngine & { grants: Grant[] } {
  const grants: Grant[] = [];
  const tiers: Policy["tiers"] = {};
  let n = 0;
  const engine = {
    grants,
    evaluate: () => ({ outcome: "allow" as const, reason: "fake" }),
    canEver: () => true,
    addGrant: (g: Omit<Grant, "id" | "createdAt">) => {
      const grant: Grant = { ...g, id: `g${++n}`, createdAt: "2026-10-03T12:00:00.000Z" };
      grants.push(grant);
      return grant;
    },
    revokeGrant: (id: string) => {
      const i = grants.findIndex((g) => g.id === id);
      if (i < 0) return false;
      grants.splice(i, 1);
      return true;
    },
    listGrants: (to?: string) => grants.filter((g) => !to || g.to === to),
    setTierOverride: (tier: Tier, cap: string, perm: string) => {
      (tiers as Record<string, Record<string, string>>)[tier] = { ...(tiers as Record<string, Record<string, string>>)[tier], [cap]: perm };
    },
    toJSON: (): Policy => ({
      version: 1,
      tiers,
      grants: [...grants],
      spend: { perActionUsd: 100, perDayUsd: 300, askAbove: 50, neverWithoutAsk: [], allowedMerchants: [], blockedMerchants: [] },
      strangerLimits: { conversationsPerDay: 3, messagesPerConversation: 10 },
    }),
  };
  return engine as unknown as PolicyEngine & { grants: Grant[] };
}

export function fakeAudit(): AuditLog & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  const log = {
    entries,
    append: (e: Omit<AuditEntry, "at">) => {
      entries.push({ ...e, at: "2026-10-03T12:00:00.000Z" });
    },
    read: () => entries,
    spentTodayUsd: () => 0,
  };
  return log as unknown as AuditLog & { entries: AuditEntry[] };
}

export interface A2aCall {
  kind: "send" | "reply";
  args: unknown[];
}

export function fakeA2a(): A2aLike & { calls: A2aCall[] } {
  const calls: A2aCall[] = [];
  return {
    calls,
    async send(...args: unknown[]) {
      calls.push({ kind: "send", args });
      return { taskId: "task-1", contextId: "ctx-1", state: "TASK_STATE_WORKING", raw: {} };
    },
    async reply(...args: unknown[]) {
      calls.push({ kind: "reply", args });
    },
  } as unknown as A2aLike & { calls: A2aCall[] };
}

export function fakeOutbox(): Outbox & { sent: Array<{ msg: OutboundMessage; principal: Principal; conversationKey: string }> } {
  const sent: Array<{ msg: OutboundMessage; principal: Principal; conversationKey: string }> = [];
  return {
    sent,
    async send(msg, ctx) {
      sent.push({ msg, principal: ctx.principal, conversationKey: ctx.conversationKey });
    },
  };
}

export function fakeProvisioner(): ProvisionerLike & { invitations: unknown[]; rules: unknown[] } {
  const invitations: unknown[] = [];
  const rules: unknown[] = [];
  return {
    invitations,
    rules,
    async createInvitation(input) {
      invitations.push(input);
      return { id: "inv-1", invitationUrl: "https://inkbox.ai/invite/abc", invitationToken: "abc", agentHandoffPrompt: "Accept invitation abc on Inkbox." };
    },
    async addContactRule(handle, peer, direction) {
      rules.push({ handle, peer, direction });
    },
  };
}

export function config(overrides: Partial<InstinctConfig> = {}): InstinctConfig {
  return {
    version: 1,
    owner: { name: "Maria", phones: ["+16175550100"], emails: ["maria@example.com"], timezone: "America/New_York" },
    agent: { name: "Maria's Kloru", handle: "maria-instinct" },
    model: { primary: "anthropic/claude-fable-5-1" },
    computer: { mode: "none" },
    apps: { enabled: false, toolkits: [] },
    features: { typingIndicators: true, tapbacks: true, journal: true },
    ...overrides,
  };
}

export const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria", phone: "+16175550100" };

export function contactPrincipal(c: Contact): Principal {
  return { kind: "contact", id: `contact:${c.id}`, tier: c.tier, displayName: c.name, contactId: c.id, phone: c.phones[0] };
}

export function agentPrincipal(c: Contact): Principal {
  return { kind: "agent", id: `agent:${c.agentHandle}`, tier: c.tier, displayName: `${c.name}'s Kloru`, agentHandle: c.agentHandle, contactId: c.id, onBehalfOf: { displayName: c.name, contactId: c.id } };
}

export const stranger: Principal = { kind: "stranger", id: "stranger:imessage:+15555550199", tier: "stranger", displayName: "+15555550199", phone: "+15555550199" };

export function ctx(principal: Principal, overrides: Partial<ToolContext> = {}): ToolContext {
  return { principal, conversationKey: "imessage:conv-1", channel: "imessage", now: () => new Date("2026-10-03T12:00:00Z"), ...overrides };
}

export function tool(tools: RegisteredTool[], name: string): RegisteredTool {
  const t = tools.find((x) => x.spec.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/** Run a tool and return its text and error flag regardless of result shape. */
export async function run(tools: RegisteredTool[], name: string, args: Record<string, unknown>, c: ToolContext): Promise<{ text: string; isError: boolean; details?: unknown }> {
  const r = await tool(tools, name).spec.execute(args, c);
  if (typeof r === "string") return { text: r, isError: false };
  const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { text, isError: !!r.isError, details: r.details };
}
