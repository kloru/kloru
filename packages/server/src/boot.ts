/**
 * Wire one agent process from env + state. This is the only place that decides
 * which optional pieces exist (Inkbox, computer, apps, network) based on what is
 * configured. Everything it builds is returned so main.ts, the smoke test and
 * embedders can drive it the same way.
 */
import { AccountsSyncer, Store, SyncRunner, dayView, storeTools, type StoreScope } from "@kloru/store";
import { storeFastPath } from "./fast-path.js";
import { comsDecider } from "./coms-decider.js";
import { eventGate } from "./event-gate.js";
import { Events } from "./events.js";
import { guidelineCheck } from "./guideline-check.js";
import { steerFilter } from "./steer-filter.js";
import { actionDecider } from "./action-decider.js";
import { gmailNotifier } from "./notify.js";
import { loadToolGuide } from "./tool-guide.js";
import { Desk, MediaStore, Memory, Vault, type DraftCheck, vaultTools, type VaultKind, type MemberPlan, type Notice, type NoticeMedia, artifactTools, automationTools, deleteAutomation, type AutomationEvents, groceryTools, mediaTools, workerTools, TechnicalPM, memoryTools } from "@kloru/desk";
import { mediaIngest } from "./media-ingest.js";
import { RuntimeWorkerHost } from "./desk-host.js";
import { langfuseFromEnv, prefsAllowContent } from "./telemetry.js";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  AgentRuntime,
  A2AStore,
  ApprovalStore,
  AuditLog,
  ContactStore,
  MemoryStore,
  PolicyEngine,
  Scheduler,
  StateDir,
  ToolRegistry,
  coreTools,
  ensurePersona,
  loadConfig,
  ownerClaimStatus,
  syncInstructions,
  loadPolicy,
  savePolicy,
  resolveDataDir,
  resolveModel,
  resolvePrincipal,
} from "@kloru/core";
import type { Capability, Contact, InboundMessage, InstinctConfig, Outbox, Policy, Principal, RegisteredTool, Tier } from "@kloru/core";
import type { Caller } from "./desk-routes.js";
import { DELEGABLE, memberPolicy, PLUMBING, type Standing } from "./member-policy.js";
import { accountScope, accountsLine } from "./account-scope.js";
import { notifyRouter } from "./notify-router.js";
import { resendClient, type ReceivedEmail } from "./resend.js";
import { TextDesk, type EmailThreading } from "./text-desk.js";
import { accessDecider } from "./access-decider.js";
import { browserTools, findChromium, type BrowserPool, type TakeoverInput } from "./browser-tools.js";
import { scriptTool } from "./script-tool.js";
import { Metrics } from "./metrics.js";
import { REDRAFT, draftChecker, feedbackDecider, shapeDecider } from "./message-shape.js";
import { textTalker } from "./text-talker.js";
import { CALL_ORIGINATIONS, InkboxA2A, InkboxChannel, InkboxInboundHydrator, InkboxProvisioner, messagingTools, sendFileTool, voiceInstructions } from "@kloru/inkbox";
import type { CallEndedEvent, CallOrigination } from "@kloru/inkbox";
import { computerGuidance, detectComputer } from "@kloru/computer";
import type { ComputerBackend } from "@kloru/computer";
import { ComposioApps, DEFAULT_TOOLKITS, OPENAI_COMPLETIONS_TOOL_LIMIT, appsGuidance, appsTools, composioModeFor } from "@kloru/apps";
import { ampleTools, type AmpleCredentials } from "@kloru/ample";
import { AtomicMailBackend, atomicMailGuidance } from "@kloru/atomicmail";
import { contextTools } from "@kloru/context";
import { networkTools } from "@kloru/network";
import { ChatAwareOutbox, ConsoleOutbox, type ChatReplyBuffer } from "./console-outbox.js";
import { createOwnerApi, type OwnerApi } from "./owner-api.js";
import { textingStatus } from "./texting-status.js";
import { fileTools, resolveInsideWorkspace } from "./file-tools.js";
import { describeDataPart, promptExtraFor } from "./hooks.js";
import { appsNotConfiguredTool, setupSummaryFor } from "./setup-summary.js";
import { createScheduleSync, type ScheduleSync } from "./maritime-schedules.js";
import { loadPaymentsModule, paymentsEnv, type LinkWalletLike, type PaymentsModule } from "./payments.js";
import { createSkillCatalog, formatSkillsIndex, loadSkillTool, ownerSkillsDir, resolveSkillsDir, skillsFor } from "./skills.js";

/** How often the skill folders are re-read; an owner-installed skill shows up within this. */
const SKILLS_REFRESH_MS = 30_000;

/** OpenRouter's images endpoint, and the model it draws with unless IMAGE_MODEL says otherwise. */
export const OPENROUTER_IMAGES = { baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-3.1-flash-image" };

/**
 * Where image_generate draws: a dedicated IMAGE_API_KEY, else an OpenAI key (either can point at any
 * OpenAI-compatible /images/generations), else the OpenRouter key Kloru already has.
 */
export function imagesFrom(env: NodeJS.ProcessEnv): { apiKey: string; baseUrl?: string; model?: string } | undefined {
  const key = env.IMAGE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  if (key) {
    const baseUrl = env.IMAGE_BASE_URL || env.OPENAI_BASE_URL;
    return { apiKey: key, ...(baseUrl ? { baseUrl } : {}), ...(env.IMAGE_MODEL ? { model: env.IMAGE_MODEL } : {}) };
  }
  const openrouter = env.OPENROUTER_API_KEY?.trim();
  if (!openrouter) return undefined;
  return { apiKey: openrouter, baseUrl: env.IMAGE_BASE_URL || OPENROUTER_IMAGES.baseUrl, model: env.IMAGE_MODEL || OPENROUTER_IMAGES.model };
}

export interface BootOptions {
  streamFn?: StreamFn;
  model?: Model<any>;
  outbox?: Outbox;
  logger?: (m: string) => void;
  skillsDir?: string;
  /** Override for tests. Default: real fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests: the payments module to wire instead of importing @kloru/payments. */
  payments?: PaymentsModule;
}

export interface BootResult {
  runtime: AgentRuntime;
  state: StateDir;
  config: InstinctConfig;
  scheduler: Scheduler;
  outbox: Outbox;
  close(): Promise<void>;
  computerKind?: string;
  apps?: ComposioApps;
  /** Toolkits Composio reports as connected at boot, for the status page. */
  appsConnected?: string[];
  startedAt: number;
  modelSpec: string;
  /** Finished chat replies waiting for the next /chat on their conversation. */
  chatBuffer: ChatReplyBuffer;
  /** Set when LINK_CLIENT_ID, LINK_CLIENT_SECRET and STRIPE_PUBLISHABLE_KEY are present and the package is installed. */
  wallet?: LinkWalletLike;
  /** Complete compact Inkbox events before handing them to the runtime. */
  hydrateInbound?: (message: InboundMessage) => Promise<InboundMessage>;
  /** Set with Inkbox: text the owner the outcome of a finished phone call. */
  onCallEnded?: (event: CallEndedEvent) => Promise<void>;
  /** Set when OWNER_API_SECRET is configured: answers the console's owner.api envelopes. */
  ownerApi?: OwnerApi;
  /** The conversation-as-codebase desk (/desk/*). Off with KLORU_DESK=off. */
  desk?: Desk;
  /** Event automations: app events and automations' own webhooks (set with the desk). */
  events?: Events;
  /** Point Composio's webhook at this Kloru (set when apps can make triggers). Only a deployed Kloru calls it. */
  subscribeAppEvents?: (url: string) => Promise<void>;
  /** Who may call the family's number: the owner and contacts at partner or family. */
  callers: (phone: string) => Caller;
  /** Texts and emails as desk conversations (set with the desk and Inkbox or Resend). */
  textDesk?: TextDesk;
  /** True while a new family's line waits for its owner to claim it by text. */
  ownerUnclaimed: () => boolean;
  /** Resend inbound: the webhook secret and the received-email reader. */
  resend?: { webhookSecret: string; received(id: string): Promise<ReceivedEmail>; attachmentUrl?(emailId: string, attachmentId: string): Promise<string> };
}

const MEMBER_TIERS: ReadonlySet<Tier> = new Set(["partner", "family"]);
const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);

/**
 * The Composio user that holds the family's connected apps: the family's own handle first. An Inkbox
 * identity added later (for texts) has its own handle; switching to it would orphan every connection.
 */
export function appsUserFor(config: Pick<InstinctConfig, "agent">, inkbox: { handle: string } | undefined): string | undefined {
  return config.agent.handle ?? inkbox?.handle;
}

/** Grants that come from what the owner said about a family member; replaced each time he says it again. */
const MEMBER_GRANT = "member";
const MEMBER_DENY = "member (not given)";

/** Saves what the owner said yes to: the contact with his words, and one grant replacing what his earlier words gave. */
export function saveMember(plan: MemberPlan, contacts: Pick<ContactStore, "upsert">, policy: Pick<PolicyEngine, "listGrants" | "revokeGrant" | "addGrant" | "setPublic" | "permissionFor">): Contact | undefined {
  if (plan.who === "anyone") {
    policy.setPublic({ words: plan.words, capabilities: plan.capabilities });
    return undefined;
  }
  const c = contacts.upsert({ name: plan.name, tier: plan.tier, phones: [plan.phone], emails: plan.email ? [plan.email] : [], policy: plan.words });
  const to = `contact:${c.id}`;
  for (const g of policy.listGrants(to)) if (g.note === MEMBER_GRANT || g.note === MEMBER_DENY) policy.revokeGrant(g.id);
  // A co-owner holds the owner's tier: no grant adds to it or takes from it.
  if (plan.tier === "owner") return c;
  if (plan.capabilities.length) policy.addGrant({ to, capabilities: plan.capabilities, note: MEMBER_GRANT });
  // What his words leave out, they take away, even where the tier would give it (the plumbing to reach apps stays).
  const taken = DELEGABLE.filter((cap) => !plan.capabilities.includes(cap) && !PLUMBING.has(cap) && policy.permissionFor(plan.tier, cap) !== "no");
  if (taken.length) policy.addGrant({ to, capabilities: taken, deny: true, note: MEMBER_DENY });
  return c;
}

/** The family as the member model sees it: who's in it, their tier, and what the owner's words gave them. */
export function familyMembers(contacts: Pick<ContactStore, "all">, policy: Pick<PolicyEngine, "listGrants">): string {
  return contacts
    .all()
    .filter((c) => MEMBER_TIERS.has(c.tier) || c.tier === "friend" || isCoOwner(c))
    .map((c) => {
      const all = policy.listGrants(`contact:${c.id}`);
      const given = all.filter((g) => !g.deny).flatMap((g) => g.capabilities);
      const taken = all.filter((g) => g.deny).flatMap((g) => g.capabilities);
      return `${c.name} (${c.phones.join(", ")}), ${c.tier}${given.length ? `: ${given.join(", ")}` : ""}${taken.length ? ` (not ${taken.join(", ")})` : ""}${c.policy ? `. The owner said: "${c.policy}"` : ""}`;
    })
    .join("\n");
}

/** A co-owner: a contact an owner placed at tier owner. She has the owner's say, under her own name. */
/** Where a number stands before a change, for the read-back: their tier and what they can do now ("" is anyone who calls). */
export function standingOf(phone: string, contacts: Pick<ContactStore, "findByPhone">, policy: Pick<PolicyEngine, "listGrants" | "permissionFor" | "publicPolicy">): Standing | undefined {
  if (!phone) return { capabilities: policy.publicPolicy()?.capabilities ?? [] };
  const c = contacts.findByPhone(phone);
  if (!c) return undefined;
  if (isCoOwner(c)) return { tier: c.tier, capabilities: DELEGABLE };
  const all = policy.listGrants(`contact:${c.id}`);
  const has = (deny: boolean, cap: Capability) => all.some((g) => !!g.deny === deny && g.capabilities.includes(cap));
  return { tier: c.tier, capabilities: DELEGABLE.filter((cap) => !has(true, cap) && (has(false, cap) || policy.permissionFor(c.tier, cap) !== "no")) };
}

export const isCoOwner = (c: Pick<Contact, "tier"> | undefined): boolean => c?.tier === "owner";

/** The owner or a co-owner, or a contact an owner placed at partner or family; nobody else. */
export function familyCallers(owner: { name: string; phones: string[] }, contacts: Pick<ContactStore, "findByPhone">, policy?: Pick<PolicyEngine, "publicPolicy">): (phone: string) => Caller {
  return (phone) => {
    if (last10(phone).length === 10 && owner.phones.some((p) => last10(p) === last10(phone))) return { allowed: true, name: owner.name, tier: "owner" };
    const c = contacts.findByPhone(phone);
    if (c && isCoOwner(c)) return { allowed: true, name: c.name, tier: "owner" };
    if (c && MEMBER_TIERS.has(c.tier)) return { allowed: true, name: c.name, tier: c.tier };
    // Anyone else only when the owner opened something to the public (off by default).
    if (!policy?.publicPolicy() || last10(phone).length !== 10) return { allowed: false };
    return c ? { allowed: true, name: c.name, tier: c.tier } : { allowed: true, tier: "stranger" };
  };
}

export const DEFAULT_MARITIME_MCP_URL = "https://mcp.maritime.sh";

export async function boot(env: NodeJS.ProcessEnv, opts: BootOptions = {}): Promise<BootResult> {
  const log = opts.logger ?? ((m: string) => console.log(`[instinct] ${m}`));
  const startedAt = Date.now();

  const state = new StateDir(resolveDataDir(env));
  state.ensure();
  const config = loadConfig(state, env);
  if (config.owner.claimOnFirstContact && config.owner.phones.length === 0) {
    const claim = ownerClaimStatus(config);
    log(claim.enabled
      ? `owner claim open: the first 1:1 iMessage/SMS carrying the one-time code becomes the owner${config.owner.claimExpiresAt ? ` (until ${config.owner.claimExpiresAt})` : ""}`
      : `WARNING: owner claim is disabled: ${claim.reason}. Nobody can claim this agent until a valid code is set`);
  }
  // PERSONA.md is the owner's file; INSTINCT_PERSONA seeds it on first boot only.
  if (ensurePersona(state, env.INSTINCT_PERSONA)) log(`wrote ${state.path("PERSONA.md")}${env.INSTINCT_PERSONA?.trim() ? " from INSTINCT_PERSONA" : " (default persona)"}`);
  // AGENTS.md is the owner's standing-instructions file. INSTINCT_INSTRUCTIONS seeds it, and a changed seed
  // replaces it as long as the owner never edited the file; an edited file is theirs.
  const instructions = syncInstructions(state, env.INSTINCT_INSTRUCTIONS);
  if (instructions === "created" || instructions === "updated") log(`${instructions} ${state.path("AGENTS.md")} from INSTINCT_INSTRUCTIONS`);

  const audit = new AuditLog(state);
  const policy = new PolicyEngine(loadPolicy(state), {
    spentTodayUsd: () => audit.spentTodayUsd(config.owner.timezone),
  });
  const approvals = new ApprovalStore(state);
  // Tier overrides and grants live in policy.json; every change (chat trust tools, console) is written through.
  const persistPolicy = (p: Policy) => savePolicy(state, p);
  const scheduler = new Scheduler(state);
  const contacts = new ContactStore(state, { warn: log });
  const memory = new MemoryStore(state);
  const a2aStore = new A2AStore(state);

  const model = opts.model ?? resolveModel(config.model.primary, env);
  const modelSpec = `${model.provider}/${model.id}`;

  const inkbox = inkboxSettings(env, config);
  const a2a = inkbox ? new InkboxA2A({
    apiKey: inkbox.apiKey,
    handle: inkbox.handle,
    ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }) : undefined;
  const externalUserId = inkbox?.handle ?? config.agent.handle ?? "owner";

  // Outbox: Inkbox when configured, else console. A caller-supplied outbox wins (tests).
  // Whatever the transport, `chat` replies are buffered for the HTTP layer: that channel
  // is the dashboard or CLI waiting on a response, not a wire Inkbox can deliver on.
  let channel: InkboxChannel | undefined;
  let outbox: Outbox;
  let chatBuffer: ChatReplyBuffer;
  if (opts.outbox) {
    if (opts.outbox instanceof InkboxChannel) channel = opts.outbox;
    const wrapped = new ChatAwareOutbox(opts.outbox);
    outbox = wrapped;
    chatBuffer = wrapped.chat;
  } else if (inkbox) {
    channel = new InkboxChannel({
      apiKey: inkbox.apiKey,
      handle: inkbox.handle,
      identityId: inkbox.identityId,
      agentName: config.agent.name,
      ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const wrapped = new ChatAwareOutbox(channel);
    outbox = wrapped;
    chatBuffer = wrapped.chat;
  } else {
    const console_ = new ConsoleOutbox({ logger: log });
    outbox = console_;
    chatBuffer = console_.chat;
    log("Inkbox not configured: replies go to the console outbox");
  }

  const registry = new ToolRegistry();
  const promptSections: string[] = [];

  registry.registerMany(
    coreTools({
      memory,
      scheduler,
      approvals,
      audit,
      config,
      outbox,
      workspaceDir: state.path("workspace"),
      onApprovalSettled: (approval, approved) => runtime.afterApproval(approval, approved),
      // The shell never sees the image key.
      ...(() => {
        const images = imagesFrom(env);
        return images ? { images } : {};
      })(),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(env.BRAVE_SEARCH_API_KEY ? { searchApiKey: env.BRAVE_SEARCH_API_KEY } : {}),
    }),
  );

  if (env.CONTEXT_DEV_API_KEY) {
    registry.registerMany(
      contextTools({
        apiKey: env.CONTEXT_DEV_API_KEY,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
  }

  // Messaging needs Inkbox. send_file does not: without a wire it still hands files
  // to the dashboard chat, which is how `instinct chat` and the smoke test get them.
  const callOrigination = callOriginationFrom(env);
  if (channel) registry.registerMany(messagingTools({ channel, contacts, config, dataDir: state.root, ...(callOrigination ? { callOrigination } : {}) }));
  else registry.register(sendFileTool({ contacts, config, dataDir: state.root }));
  // Voice AI speaks as the owner's assistant. Only a chosen voice (INKBOX_VOICE or config.json agent.voice)
  // triggers the write: the config is a full replace on Inkbox, and an unset voice keeps the org default.
  const voice = env.INKBOX_VOICE?.trim() || config.agent.voice?.trim();
  if (channel && voice) {
    const ch = channel;
    const set = await safely(log, "phone voice", async () => {
      await ch.setVoiceConfig({ voice, instructions: voiceInstructions(config.owner.name) });
      return true;
    });
    if (set) log(`phone voice: ${voice}`);
  }
  const hydrator = channel ? new InkboxInboundHydrator({
    channel,
    mediaDir: state.path("workspace", "inbound"),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }) : undefined;

  registry.registerMany(fileTools(state.path("workspace"), { env }));

  // Household memory (the desk's): a git repo of short files, written once per call by a memory ops issue.
  let householdMemory: Memory | undefined;
  if (env.KLORU_DESK?.trim().toLowerCase() !== "off") {
    try {
      householdMemory = new Memory(join(state.path("repo"), "memory"), { owner: { name: config.owner.name, phones: config.owner.phones, timezone: config.owner.timezone } });
      householdMemory.init();
      // Every family member already saved has their own folder.
      for (const c of contacts.all()) if ((MEMBER_TIERS.has(c.tier) || isCoOwner(c)) && c.phones.length) householdMemory.ensureOperator(c.name, c.phones);
      // Another person's private/ folder is never read for a request: a desk worker's is its caller's, anything else the owner's.
      registry.registerMany(
        memoryTools(householdMemory, (key) => {
          const n = Number(/^desk:issue:(\d+):/.exec(key)?.[1] ?? NaN);
          return Number.isFinite(n) ? desk?.repo.issue(n)?.filedBy.phone : config.owner.phones[0];
        }),
      );
      // Once: what the owner said when adding people becomes the start of his own policy.md (2026-11-02).
      const ownerOp = config.owner.phones[0] ? householdMemory.operatorFor(config.owner.phones[0]) : undefined;
      if (ownerOp && !householdMemory.open(`${ownerOp}/policy.md`)) {
        const lines = contacts.all().filter((c) => (MEMBER_TIERS.has(c.tier) || isCoOwner(c)) && c.policy?.trim()).map((c) => `- ${c.name.split(" ")[0]}: ${c.policy!.trim()}`);
        if (lines.length) householdMemory.setPolicy(config.owner.phones[0]!, lines.join("\n"), "Policy started from what the owner said when adding people");
      }
    } catch (error) {
      householdMemory = undefined;
      log(`memory: unavailable (${error instanceof Error ? error.message : String(error)}); calls run without it`);
    }
  }

  // Web app deploys through Ample: with the deployer's credential, or with an
  // account this agent signs up for itself on the first deploy (AMPLE_SIGNUP=1),
  // which is how every person behind a shared gateway gets an account of their own.
  const ample = ampleCredentials(env);
  const ampleSignup = !ample && env.AMPLE_SIGNUP === "1";
  if (ample || ampleSignup) {
    const workspace = state.path("workspace");
    const ownerEmail = config.owner.emails[0];
    registry.registerMany(
      ampleTools({
        ...(ample
          ? { credentials: ample }
          : {
              signup: {
                file: state.path("secrets", "ample.json"),
                name: `kloru-${config.agent.handle ?? "agent"}`,
                ...(ownerEmail ? { ownerEmail } : {}),
              },
            }),
        workspaceDir: workspace,
        resolvePath: (requested) => resolveInsideWorkspace(workspace, requested),
        env,
        ...(env.AMPLE_API_URL ? { apiUrl: env.AMPLE_API_URL } : {}),
        ...(env.AMPLE_BIN ? { bin: env.AMPLE_BIN } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    );
    log(`ample: web app deploys on (${ample ? "shared credential" : "own account on first deploy"})`);
  }

  // Computer: in-VM desktopd, hosted Maritime Computers MCP, or nothing.
  const computer = await safely(log, "computer", () =>
    detectComputer({
      mode: config.computer.mode,
      desktopdUrl: config.computer.desktopdUrl,
      maritimeMcpUrl: config.computer.maritimeMcpUrl ?? env.MARITIME_COMPUTERS_MCP_URL ?? DEFAULT_MARITIME_MCP_URL,
      maritimeApiKey: env.MARITIME_API_KEY,
      externalUserId,
      // Maritime starts the desktop stack in the background; desktopd may still be coming up.
      expectDesktopd: env.MARITIME_DESKTOP === "1",
      ...(env.MARITIME_AGENT_ID ? { agentId: env.MARITIME_AGENT_ID } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    }),
  );
  if (computer) {
    const tools = await safely(log, "computer tools", () => computer.tools());
    if (tools && tools.length > 0) {
      registry.registerMany(tools);
      promptSections.push(computerGuidance());
      log(`computer: ${computer.describe()}`);
    }
  }

  // Apps through Composio, when the deployer gave us a key. The key is the switch:
  // config.apps.enabled only records that a toolkit list was seeded. A list of
  // `all` (or `*`) drops the allowlist so any app can be connected by name.
  let apps: ComposioApps | undefined;
  let appsConnected: string[] | undefined;
  // Each deployment's app connections belong to its own Composio user (the agent handle; a
  // Kloru family's is <family>-kloru). Without one, apps stay off rather than share "owner".
  const appsUser = appsUserFor(config, inkbox);
  if (env.COMPOSIO_API_KEY && !appsUser) log("apps: off: no agent handle (set KLORU_FAMILY or INKBOX_AGENT_HANDLE), so no Composio user of its own");
  if (env.COMPOSIO_API_KEY && appsUser) {
    const toolkits = config.apps.toolkits.length > 0 ? config.apps.toolkits : DEFAULT_TOOLKITS;
    // Direct mode lists one tool per app action; router mode lists Composio's meta tools only.
    // OpenAI-style chat completions (the Maritime LLM proxy) cap a request at 128 tools.
    const { mode, reason } = composioModeFor(env, model.api);
    const composio = new ComposioApps({ apiKey: env.COMPOSIO_API_KEY, userId: appsUser, toolkits, mode, state, logger: log });
    log(`apps: composio ${composio.mode} mode (${composio.allToolkits ? "all toolkits always use router" : reason})`);
    const connected = await safely(log, "apps", async () => {
      await composio.connect();
      const tools = await composio.tools();
      const status = await composio.connectedToolkits();
      // Learn the accounts now: actions without a named account run as each app's first one.
      await composio.accounts().catch((e) => log(`apps: can't list accounts: ${e instanceof Error ? e.message : String(e)}`));
      return { tools, status };
    });
    if (connected) {
      apps = composio;
      registry.registerMany(connected.tools);
      registry.registerMany(appsTools({ apps: composio }));
      const on = connected.status.filter((s: ToolkitStatus) => s.connected).map((s: ToolkitStatus) => s.slug);
      const missing = connected.status.filter((s: ToolkitStatus) => !s.connected).map((s: ToolkitStatus) => s.slug);
      appsConnected = on;
      promptSections.push(appsGuidance(on, missing, { anyApp: composio.allToolkits, unavailable: composio.unavailableToolkits }));
      log(`apps: ${connected.tools.length} tools${composio.allToolkits ? " (any app by name)" : ""}, connected: ${on.join(", ") || "none"}`);
    }
  }
  // Event automations: an app event (Composio triggers) or a call to an automation's own URL starts a run.
  const triggers = apps?.eventTriggers();
  const publicSite = env.KLORU_PUBLIC_URL?.trim().replace(/\/+$/, "");
  const automationEvents: AutomationEvents | undefined = triggers
    ? {
        types: async (app) =>
          (await triggers.types(app))
            .map((t) => {
              const props = Object.entries(((t.config as { properties?: Record<string, { description?: string }> }).properties ?? {})).map(([k, v]) => `${k}${v.description ? ` (${v.description})` : ""}`);
              return `${t.slug}: ${t.name}. ${t.description}${props.length ? ` Settings: ${props.join("; ")}.` : ""}`;
            })
            .join("\n"),
        // Only an account's own person may watch it: an event automation reads everything that arrives there.
        watch: async ({ trigger, account, config: settings, phone }) => {
          const a = apps!.connected().find((x) => x.email?.toLowerCase() === account.trim().toLowerCase() || x.id === account.trim());
          if (!a) throw new Error(`no connected account ${account}`);
          const whose = a.person ? contacts.all().find((c) => c.id === a.person)?.phones[0] : config.owner.phones[0];
          if (!whose || whose.replace(/\D/g, "").slice(-10) !== phone.replace(/\D/g, "").slice(-10)) throw new Error(`${account} isn't the caller's account; only its own person can set up an automation on it`);
          return triggers.watch(trigger, a.id, settings);
        },
        unwatch: (instance) => triggers.unwatch(instance),
        hookUrl: (token) => (publicSite ? `${publicSite}/webhooks/hook/${token}` : undefined),
      }
    : undefined;

  // Atomic Mail: an inbox of the agent's own, when the deployer gave us a key. The key is
  // the switch. With it unset nothing here runs and nothing else changes.
  let mailbox: AtomicMailBackend | undefined;
  if (env.ATOMIC_MAIL_API_KEY) {
    const backend = new AtomicMailBackend({
      apiKey: env.ATOMIC_MAIL_API_KEY,
      ...(env.ATOMIC_MAIL_MCP_URL ? { url: env.ATOMIC_MAIL_MCP_URL } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    });
    const connected = await safely(log, "atomicmail", async () => ({ tools: await backend.tools(), address: await backend.address() }));
    if (connected && connected.tools.length > 0) {
      mailbox = backend;
      registry.registerMany(connected.tools);
      promptSections.push(atomicMailGuidance(connected.address));
      log(`atomicmail: ${connected.tools.length} tools${connected.address ? ` (${connected.address})` : ""}`);
    }
  }
  // No Composio key: the model still gets an apps_connect tool, so "connect my Gmail"
  // produces one precise sentence about what to set up instead of an invented screen.
  if (!apps) registry.register(appsNotConfiguredTool());

  // Trusted network: contacts, tiers, grants, A2A.
  registry.registerMany(
    networkTools({
      contacts,
      policy,
      onPolicyChange: persistPolicy,
      config,
      audit,
      outbox,
      a2aStore,
      ...(a2a ? { a2a } : {}),
      ...(env.INKBOX_ADMIN_API_KEY
        ? {
            provisioner: new InkboxProvisioner({
              adminApiKey: env.INKBOX_ADMIN_API_KEY,
              ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
              ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            }),
          }
        : {}),
    }),
  );

  // Payments: a Stripe Link agent wallet, when the Link OAuth client and Stripe key are set.
  let wallet: LinkWalletLike | undefined;
  const payments = paymentsEnv(env);
  if (payments) {
    const mod = opts.payments ?? (await loadPaymentsModule());
    if (!mod) {
      log("payments: LINK_* set but @kloru/payments is not installed; skipping");
    } else {
      const built = await safely(log, "payments", () => {
        const w = new mod.LinkWallet({
          state,
          clientId: payments.clientId,
          clientSecret: payments.clientSecret,
          publishableKey: payments.publishableKey,
          redirectUri: payments.redirectUri,
          ...(config.agent.handle ? { statePrefix: config.agent.handle } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        return { wallet: w, tools: mod.paymentsTools({ wallet: w, outbox, config, audit, state, test: payments.test }) };
      });
      if (built) {
        wallet = built.wallet;
        registry.registerMany(built.tools);
        log(`payments: Link wallet ${wallet.isConnected() ? "connected" : "not connected yet"}${payments.test ? " (test mode)" : ""}, callback ${payments.redirectUri}`);
      }
    }
  }

  const skillsDir = resolveSkillsDir({ explicit: opts.skillsDir, env, packageUrl: import.meta.url });
  // The image's skills/ first, then the owner's <data>/skills. Skills are re-read every 30 s, so one
  // installed there after boot (a git clone, a SKILL.md the agent wrote) is in the index and loadable
  // by name on the next message. Built-ins win a name clash, and an owner skill is private (only the
  // owner sees or loads it) unless its frontmatter says `visibility: public`.
  const ownerDir = ownerSkillsDir(state.root);
  const skillCatalog = createSkillCatalog({
    builtinDirs: skillsDir && resolve(skillsDir) !== resolve(ownerDir) ? skillsDir : undefined,
    ownerDir,
    log,
    refreshMs: SKILLS_REFRESH_MS,
  });
  skillCatalog.list();
  // Registered even with no skill yet, and even when every skill is hidden: those load by name.
  registry.register(loadSkillTool(skillCatalog.list));
  const staticSections = promptSections.join("\n\n");
  // Set once the desk is up; the setup summary reads them on every prompt.
  const vaultUrl = `${env.KLORU_PUBLIC_URL?.trim().replace(/\/+$/, "") || "https://kloru.com"}/vault`;
  let vault: Vault | undefined;
  let browserPool: BrowserPool | undefined;
  let metrics: Metrics | undefined;
  let metricsTimer: ReturnType<typeof setInterval> | undefined;
  // What is set up right now: in every worker's prompt, and the PM's.
  const setupSummary = () =>
    setupSummaryFor({
      inkbox: inkbox ? { handle: inkbox.handle } : undefined,
      computerKind: computer?.kind,
      apps: apps ? { connected: appsConnected ?? [], anyApp: apps.allToolkits, toolkits: apps.toolkitSlugs } : undefined,
      wallet: wallet ? { connected: wallet.isConnected() } : undefined,
      browser: !!browserPool,
      vault: vault ? { cards: vault.list().filter((e) => e.kind === "card").length, url: vaultUrl } : undefined,
    });
  // Built per conversation, so each principal's index lists only the skills they may load.
  const skillsPrompt = (principal: Principal) => {
    const parts = [staticSections, formatSkillsIndex(skillsFor(skillCatalog.list(), principal))].filter((p): p is string => Boolean(p && p.trim()));
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  };

  // eslint-disable-next-line prefer-const
  let runtime: AgentRuntime;
  runtime = new AgentRuntime({
    state,
    config,
    policy,
    approvals,
    audit,
    scheduler,
    contacts,
    memory,
    registry,
    model,
    outbox,
    a2aStore,
    ...(a2a ? { loadA2ATask: (taskId: string) => a2a.getTask(taskId) } : {}),
    skillsPrompt,
    streamFn: opts.streamFn ?? (streamSimple as StreamFn),
    getApiKey: (provider: string) => apiKeyFor(provider, env),
    // Core cannot import the network package; the server bridges OIP and the network guidance.
    describeData: describeDataPart,
    promptExtra: promptExtraFor,
    setupSummary,
    ...(env.INSTINCT_REPLY_BUDGET_MS ? { replyBudgetMs: Number(env.INSTINCT_REPLY_BUDGET_MS) } : {}),
  });

  // Automations made on calls run as desk issues; everything else is an owner prompt as before.
  const stopScheduler = scheduler.start(async (entry) => {
    if (entry.target === "desk") {
      if (desk) desk.runAutomation(entry);
      else log(`schedule: ${entry.id} is a desk automation but the desk is off; skipped`);
      return;
    }
    await runtime.runScheduled(entry);
  });

  let sync: ScheduleSync | undefined;
  if (env.MARITIME_BACKEND_URL && env.MARITIME_INTERNAL_TOKEN && env.MARITIME_AGENT_ID) {
    sync = createScheduleSync({
      backendUrl: env.MARITIME_BACKEND_URL,
      token: env.MARITIME_INTERNAL_TOKEN,
      agentId: env.MARITIME_AGENT_ID,
      read: () => scheduler.toMaritimeSchedules(),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      logger: log,
    });
    await sync.push(true);
    sync.start();
  }

  const toolCount = registry.all().length;
  if (model.api === "openai-completions" && toolCount > OPENAI_COMPLETIONS_TOOL_LIMIT) {
    log(
      `warning: ${toolCount} tools registered, but ${modelSpec} accepts at most ${OPENAI_COMPLETIONS_TOOL_LIMIT} per request, ` +
        "so owner replies will fail. Set COMPOSIO_MODE=router or shorten COMPOSIO_TOOLKITS.",
    );
  }
  log(`agent "${config.agent.name}" ready: model ${modelSpec}, ${toolCount} tools, data ${state.root}`);

  const ownerApiSecret = env.OWNER_API_SECRET?.trim();
  const ownerApi = ownerApiSecret
    ? createOwnerApi({
        secret: ownerApiSecret,
        policy,
        approvals,
        contacts,
        audit,
        savePolicy: persistPolicy,
        afterApproval: (approval, approved) => runtime.afterApproval(approval, approved),
        status: () => ({ agent: config.agent.name, owner: config.owner.name, model: modelSpec, apps: appsConnected ?? [], computer: computer?.kind ?? "none" }),
        ...(apps ? { apps } : {}),
        ...(wallet ? { payments: { wallet, test: payments?.test } } : {}),
        artifacts: { update: (id: string, markdown: string, phone: string, by: string) => (desk ? desk.updateArtifact(id, { markdown }, { phone, by: by === "link" ? "website (by link)" : `website (${by})` }) : { ok: false as const, error: "the desk is off" }) },
        automations: {
          list: () => scheduler.list(),
          setEnabled: (id: string, enabled: boolean) => scheduler.setEnabled(id, enabled),
          // Deleted at once; an app event nothing else watches stops being watched after.
          delete: (id: string) => {
            const had = scheduler.list().some((e) => e.id === id);
            void deleteAutomation(scheduler, id, automationEvents).catch((e: Error) => log(`automations: ${id} deleted, but its app event is still watched: ${e.message}`));
            return had;
          },
          nameOf: (phone: string) => (config.owner.phones.some((p) => p.replace(/\D/g, "").slice(-10) === phone.replace(/\D/g, "").slice(-10)) ? config.owner.name : contacts.findByPhone(phone)?.name),
        },
        ...(householdMemory ? { policies: ((m: Memory) => ({ get: (phone: string) => m.policy(phone), set: (phone: string, body: string) => m.setPolicy(phone, body) }))(householdMemory) } : {}),
        vault: {
          list: (phone: string) =>
            (vault ? vault.list().filter((e) => e.owner.replace(/\D/g, "").slice(-10) === phone.replace(/\D/g, "").slice(-10)) : []).map((e) => ({ name: e.name, kind: e.kind, meta: { ...e.meta } as Record<string, unknown>, createdAt: e.createdAt, createdBy: e.createdBy, ...(e.usedAt ? { usedAt: e.usedAt } : {}) })),
          export: (phone: string) =>
            (vault ? vault.list().filter((e) => e.owner.replace(/\D/g, "").slice(-10) === phone.replace(/\D/g, "").slice(-10)) : []).map((e) => ({ name: e.name, kind: e.kind, meta: { ...e.meta } as Record<string, unknown>, secret: vault!.secretOf(e.name) ?? {}, createdBy: e.createdBy })),
          add: (phone: string, e: { name: string; kind: string; meta: Record<string, unknown>; secret: Record<string, string> }) => {
            if (!vault) return { ok: false as const, error: "the vault isn't set up here" };
            const existing = vault.get(e.name);
            if (existing && existing.owner.replace(/\D/g, "").slice(-10) !== phone.replace(/\D/g, "").slice(-10)) return { ok: false as const, error: "that name is someone else's; pick another" };
            const r = vault.put({ name: e.name, owner: phone, kind: e.kind as VaultKind, meta: e.meta, secret: e.secret, createdBy: phone });
            return r.ok ? { ok: true as const } : r;
          },
          remove: (phone: string, name: string) => {
            const e = vault?.get(name);
            return !!e && e.owner.replace(/\D/g, "").slice(-10) === phone.replace(/\D/g, "").slice(-10) && vault!.remove(name);
          },
        },
        takeover: {
          frame: (token: string, phone: string) => browserPool?.takeoverFrame(token, phone) ?? Promise.resolve(undefined),
          input: (token: string, phone: string, e: TakeoverInput) => browserPool?.takeoverInput(token, phone, e) ?? Promise.resolve(false),
          done: (token: string, phone: string) => browserPool?.finishTakeover(token, phone) ?? false,
        },
        conversations: (phone: string) => desk?.repo.callsFor(phone).length ?? 0,
        metrics: { report: (days?: number) => (metrics ? metrics.report(days) : Promise.reject(new Error("metrics aren't running yet"))) },
        family: (phone: string) => {
          const who = familyCallers(config.owner, contacts)(phone);
          if (!who.allowed) return undefined;
          if (who.tier === "owner") return { role: "owner" as const, name: who.name ?? config.owner.name };
          return who.tier && MEMBER_TIERS.has(who.tier) ? { role: "member" as const, name: who.name ?? "", ...(contacts.findByPhone(phone) ? { person: contacts.findByPhone(phone)!.id } : {}) } : undefined;
        },
        texting: (phone) => ({ ...textingStatus({ number: env.KLORU_TEXT_NUMBER?.trim() || undefined, handle: inkbox?.handle, repo: desk?.repo }, phone) }),
        log,
      })
    : undefined;
  if (ownerApi) log("owner API: console operations enabled");

  // The desk: talking models file issues; the PM (its own model if KLORU_PM_MODEL is set) triages and merges.
  let desk: Desk | undefined;
  let events: Events | undefined;
  let textDesk: TextDesk | undefined;
  let resendIn: BootResult["resend"];
  let storeRunner: SyncRunner | undefined;
  const langfuse = langfuseFromEnv(env);
  if (env.KLORU_DESK?.trim().toLowerCase() !== "off") {
    const pmSpec = env.KLORU_PM_MODEL?.trim();
    const pmModel = pmSpec ? resolveModel(pmSpec, env) : model;
    const engineerSpec = env.KLORU_ENGINEER_MODEL?.trim();
    const engineerModel = engineerSpec ? resolveModel(engineerSpec, env) : undefined;
    // The store (#27): a synced copy of Gmail and Calendar that workers search in milliseconds,
    // and the fast path that answers reads from it before the PM starts.
    let store: Store | undefined;
    // Which accounts each caller may act through and read mail from (Phase 1 families).
    const scopeFor = apps
      ? accountScope({
          accounts: ((a: ComposioApps) => () => a.connected())(apps),
          isOwner: (phone) => familyCallers(config.owner, contacts, policy)(phone).tier === "owner",
          selfOf: (phone) => ((c) => (isCoOwner(c) ? c!.id : undefined))(contacts.findByPhone(phone)),
          ownerPerson: (id) => isCoOwner(contacts.all().find((c) => c.id === id)),
          // Anyone the caller list admits who isn't the owner: a member by her contact id, the public with none.
          personOf: (phone) => {
            const who = familyCallers(config.owner, contacts, policy)(phone);
            if (!who.allowed || who.tier === "owner") return undefined;
            const principal = resolvePrincipal({ channel: "sms", from: phone } as InboundMessage, config, contacts);
            const c = MEMBER_TIERS.has(who.tier!) ? contacts.findByPhone(phone) : undefined;
            return { id: c?.id ?? "", may: (cap) => policy.evaluate(principal, { capabilities: [cap], group: "apps" }, {}).outcome === "allow" };
          },
        })
      : undefined;
    // A member's after-call email: her address (contact, else her own Gmail), sent from her own Gmail when connected.
    const memberMail = (phone: string): { email?: string; account?: string } | undefined => {
      const c = contacts.findByPhone(phone);
      if (!c || !MEMBER_TIERS.has(c.tier)) return undefined;
      const own = apps?.connected().find((a) => a.toolkit === "gmail" && a.person === c.id)?.email;
      const email = c.emails[0] ?? own;
      return email ? { email, ...(own ? { account: own } : {}) } : undefined;
    };
    // A desk worker's store reads are its caller's; everything else (the PM, the owner's own chats) reads all.
    const storeScopeFor = (conversationKey: string): StoreScope | undefined => {
      const n = Number(/^desk:issue:(\d+):/.exec(conversationKey)?.[1] ?? NaN);
      const issue = Number.isFinite(n) ? desk?.repo.issue(n) : undefined;
      if (!issue || !scopeFor || issue.purpose === "memory") return undefined;
      const s = scopeFor(issue.filedBy.phone);
      // Each account answers to its person's policy: theirs, a silent policy, or a reviewed allow.
      const whose = (email: string) => {
        const a = apps?.connected().find((x) => x.email?.toLowerCase() === email.toLowerCase());
        return a?.person ? contacts.all().find((c) => c.id === a.person)?.phones[0] : config.owner.phones[0];
      };
      // An account whose person Kloru can't find is nobody's to read.
      const reach = (email: string, p: "read_mail" | "read_calendar") => ((phone) => !!phone && (!desk || desk.mayReach(n, phone, p)))(whose(email));
      return { mail: s.mail.filter((e) => reach(e, "read_mail")), events: s.calendar.filter((e) => reach(e, "read_calendar")), busy: s.busy };
    };
    if (apps && appsConnected?.some((t) => t === "gmail" || t === "googlecalendar")) {
      const a = apps;
      store = new Store(join(state.path("store"), "store.db"));
      // Each connected Google account syncs as itself, under its own address (a personal and a work one).
      storeRunner = new SyncRunner(new AccountsSyncer({ store, accounts: () => a.accounts(), execute: (slug, args, account) => a.execute(slug, args, { account }), log }), log);
      registry.registerMany(storeTools(store, config.owner.timezone ?? "America/Los_Angeles", undefined, storeScopeFor));
      storeRunner.start();
      log("store: syncing Gmail and Calendar every 2 minutes");
    }
    const fastKey = env.OPENROUTER_API_KEY?.trim();
    // Kloru's own channels: iMessage through Inkbox, email through Resend from mail.kloru.com.
    const resend = env.RESEND_API_KEY?.trim() ? resendClient({ apiKey: env.RESEND_API_KEY.trim() }) : undefined;
    const mailFrom = env.KLORU_MAIL_FROM?.trim();
    const inkboxOut = channel;
    // Photos go up to Inkbox first; the message carries their links.
    const sendImessage = inkboxOut
      ? async (to: string, text: string, media: NoticeMedia[] = []) => {
          const ctx = { principal: runtime.ownerPrincipal(), conversationKey: `imessage:${to}` };
          const identity = media.length ? await inkboxOut.identity() : undefined;
          const mediaUrls: string[] = [];
          for (const m of media) mediaUrls.push((await identity!.uploadIMessageMedia({ content: new Uint8Array(readFileSync(m.path)), filename: m.name, contentType: m.mime })).mediaUrl);
          // An iMessage carries one photo: the words with the first, each other photo on its own.
          await inkboxOut.send({ channel: "imessage", to, text, ...(mediaUrls[0] ? { mediaUrls: [mediaUrls[0]] } : {}) }, ctx);
          for (const url of mediaUrls.slice(1)) await inkboxOut.send({ channel: "imessage", to, text: "", mediaUrls: [url] }, ctx);
          return true;
        }
      : undefined;
    const sendEmail = resend && mailFrom
      ? async (to: string, subject: string, text: string, threading: EmailThreading = {}, media: NoticeMedia[] = []) =>
          (
            await resend.send({
              from: `Kloru <${mailFrom}>`,
              to,
              subject,
              text,
              ...(threading.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
              ...(threading.references ? { references: threading.references } : {}),
              ...(media.length ? { attachments: media.map((m) => ({ filename: m.name, content: readFileSync(m.path).toString("base64") })) } : {}),
            })
          ).ok
      : undefined;
    const ownerEmail = (): string | undefined => config.owner.emails[0] ?? apps?.connected().find((a) => a.toolkit === "gmail" && !a.person)?.email;
    const reach = (phone: string): { phone?: string; email?: string } | undefined => {
      const who = familyCallers(config.owner, contacts, policy)(phone);
      if (!who.allowed) return undefined;
      const c = contacts.findByPhone(phone);
      // A co-owner is reached on her own phone and address, never the primary owner's.
      if (who.tier === "owner" && !isCoOwner(c)) return { phone: config.owner.phones[0] ?? phone, ...(ownerEmail() ? { email: ownerEmail()! } : {}) };
      const email = memberMail(phone)?.email ?? c?.emails[0] ?? (isCoOwner(c) ? apps?.connected().find((a) => a.toolkit === "gmail" && a.person === c!.id)?.email : undefined);
      return { phone, ...(email ? { email } : {}) };
    };
    const router = sendImessage || sendEmail ? notifyRouter({ ...(sendImessage ? { imessage: sendImessage } : {}), ...(sendEmail ? { email: (to: string, subject: string, text: string, media?: NoticeMedia[]) => sendEmail(to, subject, text, {}, media) } : {}), people: reach, log }) : undefined;
    if (router) log(`notify: ${[sendImessage ? "iMessage (Inkbox)" : "", sendEmail ? `email (Resend, ${mailFrom})` : ""].filter(Boolean).join(" and ")}`);
    // For what has no review (the day view, the fast path): only accounts that are theirs, or whose person's policy is silent.
    const openTo = (phone: string, emails: string[]) =>
      emails.filter((email) => {
        const a = apps?.connected().find((x) => x.email?.toLowerCase() === email.toLowerCase());
        const owner = a?.person ? contacts.all().find((c) => c.id === a.person)?.phones[0] : config.owner.phones[0];
        if (!owner) return false;
        if (owner.replace(/\D/g, "").slice(-10) === phone.replace(/\D/g, "").slice(-10)) return true;
        return !!householdMemory && !householdMemory.policy(owner);
      });
    const media = new MediaStore(join(state.path("repo"), "media"));
    desk = new Desk({
      media,
      ...(fastKey ? { steerFilter: steerFilter({ apiKey: fastKey }) } : {}),
      // Every change is weighed before it happens: do, ask the caller, or revise (decision-models skill).
      ...(fastKey && env.KLORU_DECIDE?.trim() !== "off" ? { decideAction: actionDecider({ apiKey: fastKey }) } : {}),
      ...(fastKey ? { setMember: memberPolicy({ apiKey: fastKey, members: () => familyMembers(contacts, policy), standing: (phone) => standingOf(phone, contacts, policy) }) } : {}),
      applyMember: (plan: MemberPlan) => {
        const c = saveMember(plan, contacts, policy);
        persistPolicy(policy.toJSON());
        if (c) householdMemory?.ensureOperator(c.name, c.phones);
        audit.append({ kind: "policy", principal: "owner", detail: { action: plan.who === "anyone" ? "set_public" : "set_member", ...(c ? { contactId: c.id, tier: plan.tier } : {}), capabilities: plan.capabilities } });
        log(c ? `desk: ${c.name} (${plan.phone}) is ${plan.tier} with ${plan.capabilities.length} grants` : `desk: anyone who calls may now: ${plan.capabilities.join(", ") || "nothing (off)"}`);
      },
      // How each caller wants Kloru to work (their memory guidelines.md): every agent gets it, and it wins.
      ...(householdMemory ? { guidelines: (phone: string) => householdMemory!.guidelines(phone) } : {}),
      // "Be more concise": saved to their guidelines the moment it's said (a yes/no on Jev).
      ...(fastKey ? { isGuideline: guidelineCheck({ apiKey: fastKey }) } : {}),
      ...(config.owner.phones[0] ? { ownerPhone: config.owner.phones[0] } : {}),
      // The CISO: one Jev review of each member request's needs, enforced on every call (owners skip it).
      ...(fastKey && env.KLORU_ACCESS?.trim() !== "off" ? { decideAccess: accessDecider({ apiKey: fastKey, ownerName: config.owner.name }) } : {}),
      // Co-owners have every owner permission (Cara, 2026-11-02).
      coOwner: (phone: string) => isCoOwner(contacts.findByPhone(phone)),
      // Whose things a need names, by the name the family uses, and whose a connected account is.
      // One person or nobody: a full name first, then a first name only when exactly one person has it.
      phoneOf: (name: string) => {
        const n = name.trim().toLowerCase();
        const people = [...(config.owner.phones[0] ? [{ name: config.owner.name, phone: config.owner.phones[0] }] : []), ...contacts.all().filter((c) => c.phones[0]).map((c) => ({ name: c.name, phone: c.phones[0]! }))];
        const full = people.filter((p) => p.name.toLowerCase() === n);
        if (full.length === 1) return full[0]!.phone;
        const first = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === n);
        return first.length === 1 ? first[0]!.phone : undefined;
      },
      phoneOfPerson: (id: string) => contacts.all().find((c) => c.id === id)?.phones[0],
      // What Evan said about this caller: his words about her, or about anyone who calls.
      isMember: (phone: string) => { const t = contacts.findByPhone(phone)?.tier; return !!t && MEMBER_TIERS.has(t); },
      ownerWords: (phone: string) => {
        const c = contacts.findByPhone(phone);
        return c && MEMBER_TIERS.has(c.tier) ? c.policy : policy.publicPolicy() ? `About anyone who calls: ${policy.publicPolicy()!.words}` : undefined;
      },
      nameOf: (phone: string) => (familyCallers(config.owner, contacts, policy)(phone).name?.split(" ")[0]),
      // The owner's own addresses (configured, and the Gmail account the store syncs), so agents know who "me" is.
      ...(scopeFor ? { appScope: scopeFor, accounts: (phone: string) => accountsLine(scopeFor(phone)) } : {}),
      ownEmails: (phone: string) => {
        const digits = phone.replace(/\D/g, "").slice(-10);
        const c = contacts.findByPhone(phone);
        if (isCoOwner(c)) return [...c!.emails, ...(apps?.connected().filter((a) => a.toolkit === "gmail" && a.person === c!.id).map((a) => a.email ?? "").filter(Boolean) ?? [])];
        if (!config.owner.phones.some((p) => p.replace(/\D/g, "").slice(-10) === digits)) return [];
        return [...config.owner.emails, ...(store ? store.syncStates().filter((st) => st.source === "gmail").map((st) => st.account) : [])];
      },
      // The owner's day, from the store, in the brief before the first word. Only the owner: it's their accounts.
      ...(store ? { dayView: ((st: Store, tz: string, owners: Set<string>) => (phone: string) => (owners.has(phone.replace(/\D/g, "").slice(-10)) ? dayView(st, tz, new Date(), scopeFor ? { mail: openTo(phone, scopeFor(phone).mail), events: openTo(phone, scopeFor(phone).calendar) } : undefined) : ""))(store, config.owner.timezone ?? "America/Los_Angeles", new Set([...config.owner.phones, ...contacts.all().filter(isCoOwner).flatMap((c) => c.phones)].map((p) => p.replace(/\D/g, "").slice(-10)))) } : {}),
      ...(store && fastKey && env.KLORU_FAST_PATH?.trim() !== "off" ? { fastPath: storeFastPath({ store, apiKey: fastKey, timezone: config.owner.timezone ?? "America/Los_Angeles", log, tasks: (phone: string) => desk?.recentTasks(phone, { days: 30, limit: 15 }) ?? [], ...(scopeFor ? { mailAccounts: (phone: string) => openTo(phone, scopeFor(phone).mail), calendarAccounts: (phone: string) => openTo(phone, scopeFor(phone).calendar) } : {}) }) } : {}),
      // Simple changes from the fast path run straight through, as the account the item came from.
      ...(apps ? { execute: ((a: ComposioApps) => (slug: string, args: Record<string, unknown>, account?: string) => a.execute(slug, args, account ? { account } : {}))(apps) } : {}),
      root: state.path("repo"),
      host: new RuntimeWorkerHost(runtime, (phone) => {
        // Who a desk caller is, by their number, exactly as a text from it would resolve.
        const p = resolvePrincipal({ channel: "sms", from: phone } as InboundMessage, config, contacts);
        return p.kind === "owner" ? undefined : p;
      }),
      planner: new TechnicalPM({
        model: pmModel,
        streamFn: opts.streamFn ?? (streamSimple as StreamFn),
        getApiKey: (provider: string) => apiKeyFor(provider, env),
        log,
        // The PM's replies go where the metrics read session costs, as desk:pm.
        onReply: (r) => {
          try {
            mkdirSync(state.path("sessions"), { recursive: true });
            appendFileSync(join(state.path("sessions"), `${encodeURIComponent("desk:pm")}.jsonl`), `${JSON.stringify({ role: "assistant", ...r })}\n`);
          } catch (e) {
            log(`metrics: PM cost not recorded: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      }),
      log,
      ...(langfuse ? { telemetry: langfuse.telemetry } : {}),
      contentAllowed: prefsAllowContent(env.KLORU_VOICE_PREFS?.trim()),
      ...(engineerModel ? { engineerModel } : {}),
      ...(householdMemory ? { memory: householdMemory, legacyMemory: () => memory.readDurable() } : {}),
      // What finishes after the owner hangs up is emailed to them (texts once A2P is approved).
      ...(artifactBase(env) ? { artifactBaseUrl: artifactBase(env)! } : {}),
      scheduler,
      ...(config.owner.timezone ? { timezone: config.owner.timezone } : {}),
      onWrite: (slug: string) => void storeRunner?.kick(slug).catch(() => undefined),
      // A model writes that email with only what wasn't heard on the call, or decides none is needed (#37).
      // Coms: every message passes one check (Jev) and lands in the ledger; the agent that drafted it sends it.
      ...(fastKey && env.KLORU_COMS?.trim() !== "off" ? { decideMessage: comsDecider({ apiKey: fastKey, timezone: config.owner.timezone ?? "America/Los_Angeles" }) } : {}),
      // A worker's or the PM's draft is weighed against how they like messages, and redrafted once on a clear miss.
      ...(fastKey && env.KLORU_MESSAGE_SHAPE?.trim() !== "off" ? { checkDraft: ((check) => async (d: DraftCheck) => { const v = await check(d); return v.verdict === "fits" ? { fits: true as const } : { fits: false as const, why: REDRAFT[v.verdict] }; })(draftChecker({ apiKey: fastKey })) } : {}),
      ...(router ? { notify: (n: Notice) => router.notify(n), channelsFor: (phone: string) => router.channelsFor(phone) } : apps && appsConnected?.includes("gmail") ? { notify: gmailNotifier({ apps, ownerPhones: config.owner.phones, ...(config.owner.emails[0] ? { ownerEmail: config.owner.emails[0] } : {}), people: (phone: string) => memberMail(phone), log }) } : {}),
    });
    // Photos and files people text or email Kloru, kept beside the desk's repo (the website serves them at /m/).
    registry.registerMany([...artifactTools(desk), ...automationTools(desk, automationEvents), ...workerTools(desk), ...groceryTools(desk), ...mediaTools(desk, media, { workspaceDir: state.path("workspace") })]);
    {
      const d = desk;
      events = new Events({
        state,
        automations: () => scheduler.list(),
        run: (entry, event) => void d.runAutomation(entry, event),
        // The quick check: only events that meet an automation's condition get a full run.
        ...(fastKey ? { gate: eventGate({ apiKey: fastKey }) } : {}),
        ...(householdMemory ? { guidelines: (phone: string) => householdMemory!.guidelines(phone) } : {}),
        ...(triggers ? { verify: (body: string, headers: Record<string, string | string[] | undefined>) => triggers.verify(body, headers) } : {}),
        record: (detail) => audit.append({ kind: "schedule", principal: "system", detail: { action: "event", ...detail } }),
        log,
      });
      events.start();
    }
    // The vault (KLORU_VAULT_KEY): cards, logins and API keys used by reference, never in a conversation.
    if (env.KLORU_VAULT_KEY?.trim()) {
      try {
        vault = new Vault(state.path("secrets", "vault.json"), env.KLORU_VAULT_KEY.trim());
        const nameOfPhone = (phone: string) => familyCallers(config.owner, contacts, policy)(phone).name?.split(" ")[0] ?? phone;
        registry.registerMany([...vaultTools(desk, vault, nameOfPhone, vaultUrl), scriptTool({ desk, vault, workspaceDir: state.path("workspace") })]);
        desk.useVault(vault, nameOfPhone, vaultUrl);
        log(`vault: ${vault.list().length} secret(s)`);
      } catch (error) {
        vault = undefined;
        log(`vault: off (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    // The browser: headless Chromium on this machine, one profile per person.
    const chromiumPath = findChromium(env);
    const steelApiKey = env.STEEL_API_KEY?.trim();
    if ((chromiumPath || steelApiKey) && env.KLORU_BROWSER?.trim() !== "off") {
      const b = browserTools({ desk, ...(vault ? { vault } : {}), vaultUrl, publicUrl: env.KLORU_PUBLIC_URL?.trim() || "https://kloru.com", ...(steelApiKey ? { steelApiKey } : {}), profilesDir: state.path("browser"), executablePath: chromiumPath ?? "", log });
      browserPool = b.pool;
      registry.registerMany(b.tools);
      log(`browser: ${steelApiKey ? "Steel (steel.dev)" : chromiumPath}`);
    }

    desk.setSetup(setupSummary);
    // Workers call the actions they use most directly instead of discovering them (#17).
    if (apps && env.COMPOSIO_API_KEY) {
      const d = desk;
      void loadToolGuide(state, env.COMPOSIO_API_KEY, log).then((g) => g && d.setToolGuide(g)).catch((e) => log(`apps: tool guide failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    desk.recover();
    // Every minute: stuck issues go back to the PM, which moves them along or closes them.
    desk.startSweeper();
    // The admin metrics: OpenRouter usage recorded hourly (it keeps no daily history), and time-saved estimates for finished requests.
    {
      const d = desk;
      metrics = new Metrics({
        dataDir: state.path(),
        issues: () => d.repo.issues(),
        ledger: () => d.repo.ledger(),
        nameOf: (phone: string) => familyCallers(config.owner, contacts, policy)(phone).name?.split(" ")[0],
        timezone: config.owner.timezone ?? "America/Los_Angeles",
        openrouterKeys: Object.fromEntries([["main", env.OPENROUTER_API_KEY?.trim()], ["voice", env.VOICE_OPENROUTER_API_KEY?.trim()]].filter((x): x is [string, string] => !!x[1])),
        ...(fastKey ? { decisionKey: fastKey } : {}),
        ...(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? { twilio: { sid: env.TWILIO_ACCOUNT_SID.trim(), token: env.TWILIO_AUTH_TOKEN.trim() } } : {}),
        ...(env.STEEL_API_KEY?.trim() ? { steelKey: env.STEEL_API_KEY.trim() } : {}),
        ...(env.KLORU_HOSTING_USD_DAY ? { hostingUsdPerDay: Number(env.KLORU_HOSTING_USD_DAY) } : {}),
        log,
      });
      const m = metrics;
      const tick = () => void m.snapshot().then(() => m.ingest()).then(() => m.estimate()).catch((e: Error) => log(`metrics: ${e.message}`));
      setTimeout(tick, 60_000).unref?.();
      metricsTimer = setInterval(tick, 3_600_000);
      metricsTimer.unref?.();
    }
    // Texting or emailing Kloru is a desk conversation, like a call.
    if (fastKey && (sendImessage || sendEmail)) {
      const ownerPhone = config.owner.phones[0];
      textDesk = new TextDesk({
        desk,
        // How each written message should look for this person, and what their replies teach about it.
        ...(fastKey && env.KLORU_MESSAGE_SHAPE?.trim() !== "off" ? { shape: shapeDecider({ apiKey: fastKey }), feedback: feedbackDecider({ apiKey: fastKey }), checkDraft: draftChecker({ apiKey: fastKey }) } : {}),
        callers: familyCallers(config.owner, contacts, policy),
        emailPerson: (address) => {
          const a = address.toLowerCase();
          const owners = [...config.owner.emails, ...(apps?.connected().filter((x) => x.toolkit === "gmail" && !x.person).map((x) => x.email ?? "") ?? [])].map((e) => e.toLowerCase());
          if (ownerPhone && owners.includes(a)) return ownerPhone;
          const tagged = apps?.connected().find((x) => x.toolkit === "gmail" && x.person && x.email?.toLowerCase() === a)?.person;
          const c = contacts.findByEmail(a) ?? (tagged ? contacts.all().find((x) => x.id === tagged) : undefined);
          return c?.phones[0];
        },
        talker: textTalker({ apiKey: fastKey }),
        ingest: mediaIngest({ store: media }),
        seenFile: state.path("text-seen.jsonl"),
        send: {
          ...(sendImessage ? { imessage: sendImessage } : {}),
          ...(sendEmail ? { email: sendEmail } : {}),
          ...(inkboxOut ? { react: async (conversation: string, message: string, reaction: string) => (await inkboxOut.react(conversation, message, reaction), true) } : {}),
        },
        timezone: config.owner.timezone ?? "America/Los_Angeles",
        log,
      });
      if (resend && env.RESEND_WEBHOOK_SECRET?.trim()) resendIn = { webhookSecret: env.RESEND_WEBHOOK_SECRET.trim(), received: (id) => resend.received(id), attachmentUrl: (e, a) => resend.attachmentUrl(e, a) };
      log(`text: texts${resendIn ? " and emails" : ""} start desk conversations`);
    }
    log(`desk: ready, PM model ${pmModel.provider}/${pmModel.id}${engineerModel ? `, engineers on ${engineerModel.provider}/${engineerModel.id}` : ""}${householdMemory ? `, memory for ${householdMemory.operators().join(", ")}` : ""}${langfuse ? ", tracing to Langfuse" : ""}`);
  }

  return {
    callers: familyCallers(config.owner, contacts, policy),
    ownerUnclaimed: () => !!config.owner.claimOnFirstContact && config.owner.phones.length === 0,
    ...(textDesk ? { textDesk } : {}),
    ...(resendIn ? { resend: resendIn } : {}),
    ...(ownerApi ? { ownerApi } : {}),
    ...(desk ? { desk } : {}),
    ...(events ? { events } : {}),
    ...(triggers ? { subscribeAppEvents: (url: string) => triggers.subscribe(url) } : {}),
    runtime,
    state,
    config,
    scheduler,
    outbox,
    computerKind: computer?.kind,
    apps,
    appsConnected,
    startedAt,
    modelSpec,
    chatBuffer,
    ...(wallet ? { wallet } : {}),
    ...(hydrator ? { hydrateInbound: (message: InboundMessage) => hydrator.hydrate(message) } : {}),
    async close() {
      stopScheduler();
      await safely(log, "langfuse flush", () => langfuse?.shutdown());
      sync?.stop();
      desk?.stopSweeper();
      await events?.close();
      textDesk?.close();
      clearInterval(metricsTimer);
      await safely(log, "browser close", () => browserPool?.closeAll());
      storeRunner?.stop();
      await safely(log, "computer close", () => computer?.close());
      await safely(log, "apps close", () => apps?.close());
      await safely(log, "atomicmail close", () => mailbox?.close());
    },
  };
}

interface ToolkitStatus {
  slug: string;
  connected: boolean;
}

/** Env variable per Pi provider id. Anything not listed falls back to <PROVIDER>_API_KEY. */
export const PROVIDER_KEY_ENV: Record<string, string[]> = {
  "anthropic": ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  "openai": ["OPENAI_API_KEY"],
  "openai-compatible": ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  "google": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-gemini-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "groq": ["GROQ_API_KEY"],
  "mistral": ["MISTRAL_API_KEY"],
  "xai": ["XAI_API_KEY"],
  "openrouter": ["OPENROUTER_API_KEY"],
  "deepseek": ["DEEPSEEK_API_KEY"],
  "cerebras": ["CEREBRAS_API_KEY"],
  "zai": ["ZAI_API_KEY"],
  "minimax": ["MINIMAX_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK"],
};

/**
 * Provider key from the env the server was handed (not process.env, so tests and
 * embedders control it). Pi would read process.env itself; passing the key keeps
 * the lookup in one place and lets `instinct dev` and embedders inject keys.
 */
/** Where this deployment's pages are served: KLORU_ARTIFACT_BASE, else its own site's /a/. */
export function artifactBase(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.KLORU_ARTIFACT_BASE?.trim();
  if (explicit) return explicit;
  const site = env.KLORU_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return site ? `${site}/a/` : undefined;
}

export function apiKeyFor(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const names = PROVIDER_KEY_ENV[provider] ?? [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** INKBOX_CALL_ORIGINATION, when it names a line Inkbox knows. Anything else is logged by the tool at boot. */
export function callOriginationFrom(env: NodeJS.ProcessEnv): CallOrigination | undefined {
  const raw = env.INKBOX_CALL_ORIGINATION?.trim().toLowerCase();
  if (!raw) return undefined;
  if ((CALL_ORIGINATIONS as readonly string[]).includes(raw)) return raw as CallOrigination;
  throw new Error(`INKBOX_CALL_ORIGINATION must be one of ${CALL_ORIGINATIONS.join(", ")}, not "${raw}"`);
}

interface InkboxSettings {
  apiKey: string;
  handle: string;
  identityId?: string;
}

function inkboxSettings(env: NodeJS.ProcessEnv, config: InstinctConfig): InkboxSettings | undefined {
  const apiKey = env.INKBOX_API_KEY;
  const handle = env.INKBOX_AGENT_HANDLE ?? config.agent.handle;
  if (!apiKey || !handle) return undefined;
  return { apiKey, handle, identityId: env.INKBOX_IDENTITY_ID };
}

/** An Ample agent credential (preferred: it never expires) or a plain token. */
export function ampleCredentials(env: NodeJS.ProcessEnv): AmpleCredentials | undefined {
  const clientId = env.AMPLE_CLIENT_ID?.trim();
  const clientSecret = env.AMPLE_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  const token = env.AMPLE_TOKEN?.trim();
  return token ? { token } : undefined;
}

/** Optional pieces must never stop the agent from booting. Log and go on. */
async function safely<T>(log: (m: string) => void, what: string, fn: () => Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    log(`${what} unavailable: ${(err as Error).message}`);
    return undefined;
  }
}

export type { RegisteredTool, ComputerBackend };
