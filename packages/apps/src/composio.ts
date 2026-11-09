import type { RegisteredTool, StateDir } from "@kloru/core";
import { Composio } from "@composio/core";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { wrapMcpTools, type McpToolSource } from "./wrap.js";
import { toolkitOfSlug } from "./capabilities.js";
import { ComposioTriggers, type ComposioTriggersLike, type WebhookSubscriptionsLike } from "./triggers.js";

/** File under the StateDir that remembers the Composio session for this owner. */
export const APPS_STATE_FILE = "apps.json";
/** File under the StateDir that remembers each connected account's email address, by account id. */
export const ACCOUNTS_STATE_FILE = "app-accounts.json";
/** Which family member each connected account belongs to (by account id); absent: the owner's. */
export const ACCOUNT_PEOPLE_FILE = "app-account-people.json";
/** How many accounts of one app (Gmail, Calendar) a family can connect. */
const MAX_ACCOUNTS_PER_TOOLKIT = 5;

/**
 * The toolkit list that means "every toolkit Composio has". `COMPOSIO_TOOLKITS=all`
 * (or `*`) normalizes to `["*"]`. The session is then created without an allowlist,
 * so COMPOSIO_SEARCH_TOOLS and COMPOSIO_MANAGE_CONNECTIONS can reach any app the
 * owner names at runtime.
 */
export const ALL_TOOLKITS = "*";

/**
 * How the Tool Router exposes tools over MCP.
 * `direct` lists every allowed app tool (GMAIL_SEND_EMAIL, ...) so the policy
 * guard can tag each one. `router` lists only the meta tools (search, multi
 * execute, manage connections), which all map to `apps.use` + `trust.manage`.
 * The all-toolkits list always runs as `router`: Composio cannot list every tool
 * of every app directly.
 */
export type ComposioSessionMode = "direct" | "router";

/**
 * OpenAI-style chat completions APIs reject a request that carries more tools than
 * this ("Invalid 'tools': array too long"). The Maritime LLM proxy is one of them.
 */
export const OPENAI_COMPLETIONS_TOOL_LIMIT = 128;

/**
 * The session mode for this agent. `COMPOSIO_MODE=direct|router` wins. Unset, it is
 * `router` for a model served through an OpenAI-style chat completions API (the
 * Maritime LLM proxy among them), because direct Gmail plus Calendar alone lists
 * about a hundred tools and the agent's own tools push the request past
 * OPENAI_COMPLETIONS_TOOL_LIMIT, so every reply would fail. Any other model gets
 * `direct`, which lets the guard tag each app action.
 */
export function composioModeFor(
  env: { COMPOSIO_MODE?: string | undefined },
  modelApi: string | undefined,
): { mode: ComposioSessionMode; reason: string } {
  const raw = env.COMPOSIO_MODE?.trim().toLowerCase();
  if (raw === "direct" || raw === "router") return { mode: raw, reason: "COMPOSIO_MODE" };
  const ignored = raw ? `COMPOSIO_MODE=${env.COMPOSIO_MODE?.trim()} is not direct or router; ` : "";
  if (modelApi === "openai-completions") {
    return { mode: "router", reason: `${ignored}the model's chat completions API accepts at most ${OPENAI_COMPLETIONS_TOOL_LIMIT} tools` };
  }
  return { mode: "direct", reason: `${ignored}default` };
}

/**
 * Toolkits Composio refused because the project has no auth config for them. A
 * project without, say, a Google Contacts auth config answers session create with a
 * 400 ("... require auth configs but none exist") that names the toolkits. Only
 * names from `requested` count, matched as whole words. Empty for any other error.
 */
export function toolkitsWithoutAuthConfig(err: unknown, requested: string[]): string[] {
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== undefined && status !== 400) return [];
  const text = errorText(err).toLowerCase();
  if (!/auth[\s_-]*configs?\b/.test(text)) return [];
  return requested.filter((slug) => new RegExp(`(^|[^a-z0-9_])${escapeRegExp(slug)}($|[^a-z0-9_])`).test(text));
}

/** Toolkits Composio refused as unknown names (`Invalid toolkit slugs: strava`). Only names from `requested` count. */
export function invalidToolkits(err: unknown, requested: string[]): string[] {
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== undefined && status !== 400) return [];
  const text = errorText(err).toLowerCase();
  if (!/invalid[\s_-]*toolkit|invalidtoolkitslugs/.test(text)) return [];
  return requested.filter((slug) => new RegExp(`(^|[^a-z0-9_])${escapeRegExp(slug)}($|[^a-z0-9_])`).test(text));
}

export interface ComposioAppsOptions {
  apiKey: string;
  /** Composio user id. One per owner; the Maritime externalId or Inkbox handle works well. */
  userId: string;
  /** Toolkit slugs, or `["all"]` / `["*"]` for every toolkit. */
  toolkits: string[];
  state: StateDir;
  logger?: (m: string) => void;
  /** Default `direct`. Ignored (treated as `router`) when toolkits is the all list. */
  mode?: ComposioSessionMode;
  /** Test seams. Production code leaves this out. */
  adapters?: {
    createComposio?: (apiKey: string) => ComposioClientLike;
    connectMcp?: (mcp: McpEndpoint) => Promise<McpToolSource>;
  };
}

export interface McpEndpoint {
  url: string;
  headers?: Record<string, string>;
}

/** Shape of what we persist in apps.json. `toolkits` is `["*"]` in all mode. */
export interface AppsState {
  sessionId: string;
  userId: string;
  toolkits: string[];
  mode: ComposioSessionMode;
  /** The session allows several accounts per app. Older sessions without it are replaced. */
  multiAccount?: boolean;
  createdAt: string;
}

export interface ToolkitStatus {
  slug: string;
  connected: boolean;
}

/** One connected account of an app: the address it acts as, and whether it still works. */
export interface AppAccount {
  id: string;
  toolkit: string;
  email?: string;
  /** The family member it belongs to (their contact id); unset: the owner's. */
  person?: string;
  status: "connected" | "expired";
}

/** How to read each app's account address, so the owner sees which account is which. */
const WHO: Record<string, { slug: string; args: Record<string, unknown>; read: (d: any) => unknown }> = {
  gmail: { slug: "GMAIL_GET_PROFILE", args: {}, read: (d) => d?.emailAddress ?? d?.response_data?.emailAddress },
  googlecalendar: { slug: "GOOGLECALENDAR_GET_CALENDAR", args: { calendar_id: "primary" }, read: (d) => d?.calendar_data?.id ?? d?.id },
  outlook: { slug: "OUTLOOK_OUTLOOK_GET_PROFILE", args: {}, read: (d) => { const p = d?.response_data ?? d; return p?.mail ?? p?.userPrincipalName; } },
};

const APP_NAMES: Record<string, string> = { gmail: "Gmail", googlecalendar: "Calendar", outlook: "Outlook" };

/** The parts of a Composio Tool Router session this package uses. */
export interface ComposioSessionLike {
  sessionId: string;
  mcp: McpEndpoint;
  authorize(toolkit: string, options?: { callbackUrl?: string; alias?: string }): Promise<{ id?: string; redirectUrl?: string | null }>;
  toolkits(options?: { toolkits?: string[]; isConnected?: boolean; limit?: number; cursor?: string }): Promise<{
    items: Array<{ slug: string; isNoAuth?: boolean; connection?: { isActive: boolean } }>;
    nextCursor?: string | null;
  }>;
}

export interface ComposioClientLike {
  sessions: {
    create(userId: string, config: SessionCreateConfig): Promise<ComposioSessionLike>;
    use(id: string, options: { mcp: true }): Promise<ComposioSessionLike>;
  };
  /** Run one action for a user, straight through the API: full results, no agent-facing preview. */
  tools?: {
    execute(slug: string, body: { userId: string; connectedAccountId?: string; arguments: Record<string, unknown>; dangerouslySkipVersionCheck?: boolean }): Promise<{ successful?: boolean; data?: unknown; error?: string | null }>;
  };
  /** Connected accounts across sessions: listed for the Connections page, deleted to disconnect. */
  connectedAccounts?: {
    list(query: { userIds: string[]; toolkitSlugs?: string[] }): Promise<{ items: Array<{ id: string; status?: string; toolkit?: { slug?: string }; createdAt?: string }> }>;
    delete(id: string): Promise<unknown>;
  };
  /** App events: watch one, and the project's webhook they're posted to. */
  triggers?: ComposioTriggersLike;
  webhooks?: { subscriptions: WebhookSubscriptionsLike };
}

/** Session create config. `toolkits` is left out in all mode: no allowlist means every toolkit. */
export interface SessionCreateConfig {
  toolkits?: string[];
  manageConnections: { enable: boolean };
  mcp: true;
  /** Several accounts per app (a personal and a work Gmail); agents pick one by account id. */
  multiAccount?: { enable: boolean; maxAccountsPerToolkit?: number };
  sessionPreset?: "direct_tools";
}

/** Pages of connected toolkits fetched in all mode before giving up. */
const MAX_CONNECTED_PAGES = 20;
/** Composio's connected-accounts endpoint rejects a limit above 50 with a 400. */
const CONNECTED_PAGE_SIZE = 50;

export class ComposioApps {
  private readonly opts: ComposioAppsOptions;
  private readonly composio: ComposioClientLike;
  private session?: ComposioSessionLike;
  private client?: McpToolSource;
  private connecting?: Promise<void>;
  private cachedTools?: RegisteredTool[];
  /** Toolkits dropped this run because the Composio project has no auth config for them. */
  private readonly unavailable = new Set<string>();
  /** The accounts as last listed: execute's default account and the agents' accounts line. */
  private knownAccounts: AppAccount[] = [];

  constructor(opts: ComposioAppsOptions) {
    if (!opts.apiKey) throw new Error("ComposioApps needs an apiKey (COMPOSIO_API_KEY)");
    if (!opts.userId) throw new Error("ComposioApps needs a userId");
    this.opts = opts;
    const create = opts.adapters?.createComposio ?? defaultCreateComposio;
    this.composio = create(opts.apiKey);
  }

  /** The mode the session really runs in: `router` whenever every toolkit is allowed. */
  get mode(): ComposioSessionMode {
    if (this.allToolkits) return "router";
    return this.opts.mode ?? "direct";
  }

  /** True when the toolkit list is `all` / `*`: no allowlist, any app by name. */
  get allToolkits(): boolean {
    return wantsAllToolkits(this.opts.toolkits);
  }

  /** Normalized toolkit slugs, or `["*"]` in all mode. Leaves out toolkits Composio refused for lack of an auth config. */
  get toolkitSlugs(): string[] {
    return normalizeToolkits(this.opts.toolkits).filter((t) => !this.unavailable.has(t));
  }

  /** Configured toolkits left out of the session because the Composio project has no auth config for them. */
  get unavailableToolkits(): string[] {
    return [...this.unavailable].sort();
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /** Reuse the stored session when it still matches; otherwise create one and save it. Then open MCP. */
  async connect(): Promise<void> {
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async doConnect(): Promise<void> {
    const session = await this.openSession();
    this.session = session;
    const connectMcp = this.opts.adapters?.connectMcp ?? defaultConnectMcp;
    this.client = await connectMcp(session.mcp);
    this.cachedTools = undefined;
    this.log(`composio: MCP connected for session ${session.sessionId}`);
  }

  private async openSession(): Promise<ComposioSessionLike> {
    const saved = this.opts.state.readJson<AppsState | undefined>(APPS_STATE_FILE, undefined);
    if (saved && sessionMatches(saved, this.opts.userId, this.toolkitSlugs, this.mode)) {
      try {
        const session = await this.composio.sessions.use(saved.sessionId, { mcp: true });
        this.log(`composio: reusing session ${saved.sessionId}`);
        return session;
      } catch (err) {
        this.log(`composio: stored session unusable (${messageOf(err)}); creating a new one`);
      }
    } else if (saved) {
      this.log("composio: stored session config differs; creating a new one");
    }
    const config: SessionCreateConfig = {
      manageConnections: { enable: true },
      mcp: true,
      multiAccount: { enable: true, maxAccountsPerToolkit: MAX_ACCOUNTS_PER_TOOLKIT },
    };
    if (this.allToolkits) {
      // No allowlist: the meta tools can search, run and connect any toolkit. The
      // direct preset needs a toolkit filter, so all mode is always router mode.
      if (this.opts.mode === "direct") this.log("composio: all toolkits requested; using router mode");
    } else {
      config.toolkits = this.toolkitSlugs;
      // direct_tools lists each app tool so the guard sees GMAIL_SEND_EMAIL, not a generic executor.
      if (this.mode === "direct") config.sessionPreset = "direct_tools";
    }
    const session = await this.createSession(config);
    const state: AppsState = {
      sessionId: session.sessionId,
      userId: this.opts.userId,
      toolkits: this.toolkitSlugs,
      mode: this.mode,
      multiAccount: true,
      createdAt: new Date().toISOString(),
    };
    this.opts.state.writeJson(APPS_STATE_FILE, state);
    this.log(`composio: created session ${session.sessionId}${this.allToolkits ? " (all toolkits)" : ""}`);
    return session;
  }

  /**
   * Create the session. When Composio refuses some toolkits, drop those and retry, so one bad
   * app doesn't switch off every app: once for names it doesn't know (Strava, for the tool
   * router), once for toolkits without an auth config (Google Contacts in a new project,
   * typically). Any other error, or a refusal that names every toolkit, is thrown as before.
   */
  private async createSession(config: SessionCreateConfig): Promise<ComposioSessionLike> {
    let current = config;
    const retried = { names: false, auth: false };
    for (;;) {
      try {
        return await this.composio.sessions.create(this.opts.userId, current);
      } catch (err) {
        const requested = current.toolkits ?? [];
        const invalid = retried.names ? [] : invalidToolkits(err, requested);
        const noAuth = invalid.length > 0 || retried.auth ? [] : toolkitsWithoutAuthConfig(err, requested);
        const missing = invalid.length > 0 ? invalid : noAuth;
        const rest = requested.filter((t) => !missing.includes(t));
        if (missing.length === 0 || rest.length === 0) throw err;
        if (invalid.length > 0) retried.names = true;
        else retried.auth = true;
        for (const t of missing) this.unavailable.add(t);
        this.log(
          invalid.length > 0
            ? `composio: Composio doesn't accept ${missing.join(", ")} as a toolkit; starting without ${missing.length === 1 ? "it" : "them"}. Fix the name in COMPOSIO_TOOLKITS.`
            : `composio: this Composio project has no auth config for ${missing.join(", ")}; starting with ${rest.join(", ")} only. ` +
                "Create the missing auth config in the Composio dashboard and restart the agent to add it.",
        );
        current = { ...current, toolkits: rest };
      }
    }
  }

  /** Every MCP tool wrapped as a RegisteredTool. Cached after the first call. */
  async tools(opts: { refresh?: boolean } = {}): Promise<RegisteredTool[]> {
    await this.connect();
    if (!this.cachedTools || opts.refresh) {
      this.cachedTools = await wrapMcpTools(this.requireClient());
      this.log(`composio: ${this.cachedTools.length} app tools`);
    }
    return this.cachedTools;
  }

  /**
   * OAuth link the owner opens to connect a toolkit. Undefined when the toolkit needs no auth.
   * With `callbackUrl`, Composio sends the browser there once the account is connected.
   */
  async connectLink(toolkit: string, callbackUrl?: string, o: { person?: string } = {}): Promise<string | undefined> {
    await this.connect();
    const slug = toolkit.trim().toLowerCase();
    const session = this.requireSession();
    const req = callbackUrl ? await session.authorize(slug, { callbackUrl }) : await session.authorize(slug);
    // The account this link creates is the member's: remembered by the id Composio gives it now.
    if (o.person && req.id) this.opts.state.writeJson(ACCOUNT_PEOPLE_FILE, { ...this.opts.state.readJson<Record<string, string>>(ACCOUNT_PEOPLE_FILE, {}), [req.id]: o.person });
    return req.redirectUrl ?? undefined;
  }

  /** Remove every connected account this agent's user holds for one toolkit. Returns how many. */
  async disconnect(toolkit: string): Promise<number> {
    const accounts = this.composio.connectedAccounts;
    if (!accounts) throw new Error("this Composio client cannot list connected accounts");
    const res = await accounts.list({ userIds: [this.opts.userId], toolkitSlugs: [toolkit.trim().toLowerCase()] });
    for (const item of res.items) await accounts.delete(item.id);
    return res.items.length;
  }

  /**
   * Every account this family connected, by the address it acts as: per app, the working ones oldest first.
   * An expired account shows (it needs reconnecting) unless the same address is connected again;
   * a sign-in that never finished doesn't. Addresses are looked up once and remembered.
   */
  async accounts(): Promise<AppAccount[]> {
    const api = this.composio.connectedAccounts;
    if (!api) throw new Error("this Composio client cannot list connected accounts");
    const res = await api.list({ userIds: [this.opts.userId], ...(this.allToolkits ? {} : { toolkitSlugs: this.toolkitSlugs }) });
    const emails = this.opts.state.readJson<Record<string, string>>(ACCOUNTS_STATE_FILE, {});
    const people = this.opts.state.readJson<Record<string, string>>(ACCOUNT_PEOPLE_FILE, {});
    let learned = false;
    const rows = res.items
      .filter((a) => a.status === "ACTIVE" || a.status === "EXPIRED")
      .map((a) => ({ id: a.id, toolkit: (a.toolkit?.slug ?? "").toLowerCase(), active: a.status === "ACTIVE", at: a.createdAt ?? "" }))
      .sort((a, b) => a.toolkit.localeCompare(b.toolkit) || Number(b.active) - Number(a.active) || a.at.localeCompare(b.at));
    for (const r of rows) {
      if (emails[r.id] || !r.active) continue;
      const email = await this.lookUpEmail(r.toolkit, r.id);
      if (email) {
        emails[r.id] = email;
        learned = true;
      }
    }
    if (learned) this.opts.state.writeJson(ACCOUNTS_STATE_FILE, emails);
    const live = new Set(rows.filter((r) => r.active && emails[r.id]).map((r) => `${r.toolkit} ${emails[r.id]}`));
    const accounts: AppAccount[] = rows
      .filter((r) => r.active || !emails[r.id] || !live.has(`${r.toolkit} ${emails[r.id]}`))
      .map((r) => ({ id: r.id, toolkit: r.toolkit, ...(emails[r.id] ? { email: emails[r.id] } : {}), ...(people[r.id] ? { person: people[r.id] } : {}), status: r.active ? "connected" : "expired" }));
    this.knownAccounts = accounts;
    return accounts;
  }

  /** App events for automations; undefined when this client can't make triggers. */
  eventTriggers(): ComposioTriggers | undefined {
    const triggers = this.composio.triggers;
    if (!triggers) return undefined;
    return new ComposioTriggers({
      triggers,
      ...(this.composio.webhooks ? { subscriptions: this.composio.webhooks.subscriptions } : {}),
      userId: this.opts.userId,
      state: this.opts.state,
      accountId: (slug, account) => (account.includes("@") ? this.accountByEmail(slug, account) : this.knownAccounts.find((a) => a.id === account && a.status === "connected")?.id),
      ...(this.opts.logger ? { log: this.opts.logger } : {}),
    });
  }

  /** The accounts as last listed (accounts()), without a network call. */
  connected(): AppAccount[] {
    return this.knownAccounts.filter((a) => a.status === "connected");
  }

  private async lookUpEmail(toolkit: string, account: string): Promise<string | undefined> {
    const who = WHO[toolkit];
    if (!who) return undefined;
    const r = await this.execute(who.slug, who.args, { account }).catch(() => undefined);
    const email = r?.ok ? who.read(r.data) : undefined;
    return typeof email === "string" && email.includes("@") ? email.toLowerCase() : undefined;
  }

  /** Remove one connected account, if it's one of this family's. */
  async disconnectAccount(id: string): Promise<void> {
    const api = this.composio.connectedAccounts;
    if (!api) throw new Error("this Composio client cannot list connected accounts");
    const res = await api.list({ userIds: [this.opts.userId] });
    if (!res.items.some((a) => a.id === id)) throw new Error(`${id} is not one of this family's accounts`);
    await api.delete(id);
    this.knownAccounts = this.knownAccounts.filter((a) => a.id !== id);
  }

  /**
   * For agents, when an app has more than one account: which accounts there are and how to pick.
   * Empty while every app has one account (there's nothing to choose).
   */
  accountsLine(): string {
    const byApp = new Map<string, AppAccount[]>();
    for (const a of this.knownAccounts) if (a.status === "connected" && a.email) byApp.set(a.toolkit, [...(byApp.get(a.toolkit) ?? []), a]);
    if (![...byApp.values()].some((l) => l.length > 1)) return "";
    const lines = [...byApp].map(([t, l]) => `${APP_NAMES[t] ?? t}: ${l.map((a) => `${a.email} (account ${a.id})`).join(", ")}`);
    return `Connected accounts. ${lines.join(". ")}. Pass account: <id> with each app action, the account the request belongs to; when it doesn't say, the first.`;
  }

  /** The account an action runs as when none is named: the app's first connected one. */
  private defaultAccount(slug: string): string | undefined {
    const toolkit = toolkitOf(slug);
    return this.knownAccounts.find((a) => a.toolkit === toolkit && a.status === "connected")?.id;
  }

  /** The connected account of this action's app that acts as this address. */
  private accountByEmail(slug: string, email: string): string | undefined {
    const toolkit = toolkitOf(slug);
    return this.knownAccounts.find((a) => a.toolkit === toolkit && a.status === "connected" && a.email === email.toLowerCase())?.id;
  }

  /**
   * Connection state of each configured toolkit. Toolkits missing from the response
   * count as not connected. In all mode there is no configured list, so this returns
   * the toolkits that hold an active connection, each marked connected.
   */
  async connectedToolkits(): Promise<ToolkitStatus[]> {
    await this.connect();
    if (this.allToolkits) return this.activeConnections();
    const wanted = this.toolkitSlugs;
    const res = await this.requireSession().toolkits({ toolkits: wanted, limit: Math.max(wanted.length, 1) });
    const found = new Map<string, boolean>();
    for (const item of res.items) {
      found.set(item.slug.toLowerCase(), item.isNoAuth === true || item.connection?.isActive === true);
    }
    return wanted.map((slug) => ({ slug, connected: found.get(slug) ?? false }));
  }

  private async activeConnections(): Promise<ToolkitStatus[]> {
    const session = this.requireSession();
    const slugs = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CONNECTED_PAGES; page += 1) {
      const res = await session.toolkits({ isConnected: true, limit: CONNECTED_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      for (const item of res.items) {
        if (item.connection?.isActive === true) slugs.add(item.slug.toLowerCase());
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return [...slugs].sort().map((slug) => ({ slug, connected: true }));
  }

  /**
   * Run one app action by its Composio slug from code, with no model involved (the desk's
   * after-call email). Router sessions only list meta tools, so it goes through multi-execute.
   */
  async execute(slug: string, args: Record<string, unknown>, o: { account?: string } = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const account = o.account?.includes("@") ? this.accountByEmail(slug, o.account) : (o.account ?? this.defaultAccount(slug));
    if (o.account?.includes("@") && !account) return { ok: false, error: `no connected ${APP_NAMES[toolkitOf(slug) ?? ""] ?? "app"} account for ${o.account}` };
    // Straight through the SDK when it can: the agent-facing multi-execute previews long results
    // (3 messages of 100), which a sync can't use.
    if (this.composio.tools) {
      const r = await this.composio.tools.execute(slug, { userId: this.opts.userId, ...(account ? { connectedAccountId: account } : {}), arguments: args, dangerouslySkipVersionCheck: true });
      return r.successful === false ? { ok: false, error: String(r.error ?? "the action failed") } : { ok: true, data: r.data };
    }
    await this.connect();
    const client = this.requireClient();
    const router = this.mode === "router";
    const res = router
      ? await client.callTool("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: slug, arguments: args, ...(account ? { account } : {}) }], sync_response_to_workbench: false, thought: `Kloru runs ${slug}` })
      : await client.callTool(slug, args);
    const body = (res.structuredContent ?? parseText(res)) as Record<string, any> | undefined;
    const inner = router ? (body?.data ?? body?.data_preview)?.results?.[0]?.response : body;
    const ok = res.isError !== true && body?.successful !== false && inner?.successful !== false;
    return ok ? { ok, data: inner?.data ?? inner?.data_preview ?? inner } : { ok, error: String(inner?.error ?? body?.error ?? "the action failed") };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.cachedTools = undefined;
    if (client) await client.close();
  }

  private requireClient(): McpToolSource {
    if (!this.client) throw new Error("ComposioApps is not connected");
    return this.client;
  }

  private requireSession(): ComposioSessionLike {
    if (!this.session) throw new Error("ComposioApps is not connected");
    return this.session;
  }

  private log(m: string): void {
    this.opts.logger?.(m);
  }
}

/** True when the list names every toolkit: any entry is `all` or `*`. */
export function wantsAllToolkits(toolkits: string[]): boolean {
  return toolkits.some((t) => {
    const v = t.trim().toLowerCase();
    return v === "all" || v === ALL_TOOLKITS;
  });
}

/** Lowercase, trim, dedupe and sort. `all` or `*` anywhere in the list collapses it to `["*"]`. */
export function normalizeToolkits(toolkits: string[]): string[] {
  if (wantsAllToolkits(toolkits)) return [ALL_TOOLKITS];
  return [...new Set(toolkits.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
}

function sessionMatches(saved: AppsState, userId: string, toolkits: string[], mode: ComposioSessionMode): boolean {
  if (!saved.sessionId || saved.userId !== userId || saved.multiAccount !== true) return false;
  if ((saved.mode ?? "router") !== mode) return false;
  const a = normalizeToolkits(saved.toolkits ?? []);
  return a.length === toolkits.length && a.every((t, i) => t === toolkits[i]);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The error message plus any response body the SDK attached (`APIError.error`). */
function errorText(err: unknown): string {
  const parts = [messageOf(err)];
  const body = (err as { error?: unknown } | null)?.error;
  if (body !== undefined) {
    try {
      parts.push(typeof body === "string" ? body : JSON.stringify(body));
    } catch {
      // An unserializable body adds nothing.
    }
  }
  return parts.join(" ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultCreateComposio(apiKey: string): ComposioClientLike {
  // The SDK's Session type is wider than ComposioSessionLike; the structural subset is all we call.
  return new Composio({ apiKey });
}

async function defaultConnectMcp(mcp: McpEndpoint): Promise<McpToolSource> {
  const client = new McpClient({ name: "kloru-apps", version: "0.1.0" });
  await client.connect(new StreamableHttpTransport({ url: mcp.url, headers: mcp.headers ?? {} }));
  return client;
}

function parseText(res: { content?: unknown }): unknown {
  const first = Array.isArray(res.content) ? (res.content as Array<{ type?: string; text?: string }>).find((c) => c.type === "text") : undefined;
  try {
    return first?.text ? JSON.parse(first.text) : undefined;
  } catch {
    return undefined;
  }
}

function toolkitOf(slug: string): string | undefined {
  return slug.trim() ? toolkitOfSlug(slug) : undefined;
}
