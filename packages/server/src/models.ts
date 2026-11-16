/**
 * Which model does each job. An owner picks on the website (Admin → Models); the choice is kept in
 * models.json and read at the start of each run, so a change needs no deploy. A job nobody has
 * picked for runs on its default: the environment's where it sets one, else the one listed here.
 *
 * A choice is checked against OpenRouter's own list as it is made: the model has to be offered now,
 * by a provider that keeps no data, and able to do the job (answer the decisions API, call tools,
 * fill a schema, draw). The voice service reads the same file at each call (voice/voice/models.py).
 */
import type { StateDir } from "@kloru/core";

/** What a job needs of its model. */
export type ModelKind = "decision" | "tools" | "json" | "text" | "image";

export interface Role {
  label: string;
  /** What the job is, for the person choosing. */
  what: string;
  group: "Talking" | "The desk" | "Decisions" | "Other";
  kind: ModelKind;
  model: string;
}

const JEV = "typesafe/jev-1.14";

export const ROLES = {
  voice: { label: "Phone calls", what: "Talks on a call and files what's asked.", group: "Talking", kind: "tools", model: "openai/gpt-6-luna" },
  texting: { label: "Texting", what: "Answers in a text thread, files requests and writes the results.", group: "Talking", kind: "tools", model: "google/gemini-4-hydrogen" },
  "fast-path-plan": { label: "Fast path: plan", what: "Says whether a text can be answered at once from synced mail and calendar.", group: "Talking", kind: "json", model: "google/gemini-4-hydrogen" },
  "fast-path-writer": { label: "Fast path: answer", what: "Writes that answer.", group: "Talking", kind: "text", model: "openai/gpt-6-luna" },
  "fast-path-change": { label: "Fast path: change", what: "Works out one exact calendar change from a text.", group: "Talking", kind: "json", model: "google/gemini-4-hydrogen" },
  steer: { label: "Steering", what: "Says whether a new text changes a request already being worked on.", group: "Talking", kind: "json", model: "openai/gpt-6-luna" },

  pm: { label: "PM", what: "Triages each request, assigns it and reviews the result.", group: "The desk", kind: "tools", model: "openai/gpt-6-luna" },
  engineer: { label: "Engineers", what: "Do the work: read, research, act. Memory and the scout run on it too.", group: "The desk", kind: "tools", model: "openai/gpt-6-luna" },
  "app-engineer": { label: "App engineers", what: "Write and fix the apps Kloru makes.", group: "The desk", kind: "tools", model: "openai/gpt-6-luna" },
  qa: { label: "QA", what: "Tries a new or changed app in a browser.", group: "The desk", kind: "tools", model: "openai/gpt-6-luna" },
  organizer: { label: "Outbox organizer", what: "Decides what each person gets of what's waiting for them, and when.", group: "The desk", kind: "tools", model: "openai/gpt-6-luna" },

  access: { label: "Access review", what: "Weighs a family member's request against each owner's policy.", group: "Decisions", kind: "decision", model: JEV },
  "action-check": { label: "Action check", what: "Says whether a change a worker is about to make is clearly fine.", group: "Decisions", kind: "decision", model: JEV },
  "action-second-look": { label: "Action check: second look", what: "Weighs an action the first check wasn't sure of.", group: "Decisions", kind: "json", model: "google/gemini-4-hydrogen" },
  "message-check": { label: "Message check", what: "Send, hold or drop a message leaving a connected account.", group: "Decisions", kind: "decision", model: JEV },
  "outbox-pass": { label: "Outbox fast pass", what: "Send a message now, drop it, or leave it for the organizer.", group: "Decisions", kind: "decision", model: JEV },
  "message-shape": { label: "Message shape", what: "A reaction, one line or the whole answer.", group: "Decisions", kind: "decision", model: JEV },
  "draft-check": { label: "Draft check", what: "Whether a drafted text fits the person it's for.", group: "Decisions", kind: "decision", model: JEV },
  "message-feedback": { label: "Message feedback", what: "What a reply to a result says about how they want messages.", group: "Decisions", kind: "decision", model: JEV },
  "result-gate": { label: "Result gate", what: "Whether a changed app needs trying before the PM reviews it.", group: "Decisions", kind: "decision", model: JEV },
  "event-gate": { label: "Event gate", what: "Whether an app event is worth starting an automation for.", group: "Decisions", kind: "decision", model: JEV },
  guideline: { label: "Guideline check", what: "Whether something to remember is about how Kloru should work.", group: "Decisions", kind: "decision", model: JEV },
  "time-saved": { label: "Time saved", what: "Estimates how long a finished request would have taken by hand.", group: "Decisions", kind: "decision", model: JEV },

  "member-policy": { label: "Family member setup", what: "Turns what an owner says about a family member into their standing.", group: "Other", kind: "json", model: "openai/gpt-6-luna" },
  "call-judge": { label: "Call judge", what: "Scores each finished call for the health dashboard.", group: "Other", kind: "text", model: "openai/gpt-6.1-terra" },
  image: { label: "Images", what: "Draws the images Kloru makes.", group: "Other", kind: "image", model: "google/gemini-nano-banana-2.1" },
} as const satisfies Record<string, Role>;

export type RoleId = keyof typeof ROLES;
export const isRole = (v: unknown): v is RoleId => typeof v === "string" && Object.hasOwn(ROLES, v);

/** A model OpenRouter offers now through a provider that keeps no data, and the jobs it can do. */
export interface CatalogModel {
  id: string;
  name: string;
  /** Dollars per million tokens in and out. */
  in: number;
  out: number;
  /** The day it was listed. */
  since: string;
  kinds: ModelKind[];
}

export interface RoleView extends Role {
  id: RoleId;
  /** What it runs on now. */
  model: string;
  default: string;
  /** Who picked it and when; unset: it's on its default. */
  by?: string;
  at?: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type Choices = Partial<Record<RoleId, { model: string; by: string; at: string }>>;

const FILE = "models.json";
const LIST = "https://openrouter.ai/api/v1/models?output_modalities=all";
const ZDR = "https://openrouter.ai/api/v1/endpoints/zdr";
const FRESH_MS = 10 * 60_000;

const NEEDS: Record<ModelKind, string> = {
  decision: "answers OpenRouter's decisions API",
  tools: "writes text and calls tools",
  json: "writes text to a schema",
  text: "writes text",
  image: "draws images",
};

interface Listed {
  id: string;
  name?: string;
  created?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { output_modalities?: string[] };
  supported_parameters?: string[];
  endpoints?: string[];
  expiration_date?: string | null;
}

/** The jobs a listed model can do, from what OpenRouter says it serves. */
export function kindsOf(m: Listed): ModelKind[] {
  const serves = (e: string) => m.endpoints?.includes(e) ?? false;
  const takes = (p: string) => m.supported_parameters?.includes(p) ?? false;
  const kinds: ModelKind[] = [];
  if (serves("/api/alpha/decisions")) kinds.push("decision");
  if (serves("/api/v1/chat/completions") && m.architecture?.output_modalities?.includes("text")) {
    kinds.push("text");
    if (takes("tools")) kinds.push("tools");
    if (takes("structured_outputs")) kinds.push("json");
  }
  if (serves("/api/v1/images")) kinds.push("image");
  return kinds;
}

/** OpenRouter prices a token in dollars, as text. */
const perMillion = (perToken: string | undefined) => Math.round((Number(perToken) || 0) * 1e10) / 1e4;

export interface ModelsOptions {
  /** What a job runs on when nobody has picked: the environment's choice, as an OpenRouter id. */
  defaults?: Partial<Record<RoleId, string>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class Models {
  private choices: Choices;
  private listed: { at: number; models: CatalogModel[] } | undefined;

  constructor(private readonly state: StateDir, private readonly o: ModelsOptions = {}) {
    const read = state.readJson<Record<string, unknown>>(FILE, {});
    this.choices = Object.fromEntries(Object.entries(read).filter(([role, c]) => isRole(role) && typeof (c as { model?: unknown })?.model === "string")) as Choices;
  }

  /** What someone picked for this job, if anyone has. */
  chosen(role: RoleId): string | undefined {
    return this.choices[role]?.model;
  }

  of(role: RoleId): string {
    return this.chosen(role) ?? this.defaultOf(role);
  }

  private defaultOf(role: RoleId): string {
    return this.o.defaults?.[role] ?? ROLES[role].model;
  }

  list(): RoleView[] {
    return (Object.keys(ROLES) as RoleId[]).map((id) => {
      const c = this.choices[id];
      return { ...ROLES[id], id, model: this.of(id), default: this.defaultOf(id), ...(c ? { by: c.by, at: c.at } : {}) };
    });
  }

  /** OpenRouter's list now (kept ten minutes); the last good one when it can't be reached. */
  async catalog(): Promise<Result<CatalogModel[]>> {
    const now = (this.o.now?.() ?? new Date()).getTime();
    if (this.listed && now - this.listed.at < FRESH_MS) return { ok: true, value: this.listed.models };
    try {
      const get = async <T>(url: string): Promise<T[]> => {
        const r = await (this.o.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
        const d = ((await r.json()) as { data?: T[] }).data;
        if (!d?.length) throw new Error("OpenRouter sent an empty list");
        return d;
      };
      const [all, zdr] = await Promise.all([get<Listed>(LIST), get<{ model_id?: string }>(ZDR)]);
      const keepsNothing = new Set(zdr.map((e) => e.model_id));
      const models = all
        .filter((m) => keepsNothing.has(m.id) && !(m.expiration_date && Date.parse(m.expiration_date) <= now))
        .map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          in: perMillion(m.pricing?.prompt),
          out: perMillion(m.pricing?.completion),
          since: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : "",
          kinds: kindsOf(m),
        }))
        .filter((m) => m.kinds.length > 0)
        .sort((a, b) => b.since.localeCompare(a.since));
      this.listed = { at: now, models };
      return { ok: true, value: models };
    } catch (e) {
      if (this.listed) return { ok: true, value: this.listed.models };
      return { ok: false, error: `OpenRouter's model list couldn't be read (${e instanceof Error ? e.message : String(e)})` };
    }
  }

  /** Pick a model for a job, or with "" put it back on its default. Refused unless OpenRouter lists a model that fits. */
  async set(role: RoleId, model: string, by: string): Promise<Result<RoleView>> {
    const id = model.trim();
    if (id) {
      const catalog = await this.catalog();
      if (!catalog.ok) return { ok: false, error: `${catalog.error}, so nothing was changed.` };
      const found = catalog.value.find((m) => m.id === id);
      if (!found) return { ok: false, error: `OpenRouter doesn't offer ${id} through a provider that keeps no data.` };
      const kind = ROLES[role].kind;
      if (!found.kinds.includes(kind)) return { ok: false, error: `${ROLES[role].label} needs a model that ${NEEDS[kind]}; ${id} doesn't.` };
    }
    const next = { ...this.choices };
    if (id) next[role] = { model: id, by, at: (this.o.now?.() ?? new Date()).toISOString() };
    else delete next[role];
    this.state.writeJson(FILE, next);
    this.choices = next;
    return { ok: true, value: this.list().find((r) => r.id === role)! };
  }
}

let current: Models | undefined;

/** The choices every job reads from now on (boot). */
export function useModels(models: Models | undefined): void {
  current = models;
}

/** A bench tries other models: TRY_MODELS="steer=openai/gpt-6-luna,texting=…" (the model-selection skill). */
const tried = (): Partial<Record<string, string>> => Object.fromEntries((process.env.TRY_MODELS ?? "").split(",").map((p) => p.trim().split("=")).filter((p) => p.length === 2));

/** The model a job runs on now. */
export function modelOf(role: RoleId): string {
  return current?.of(role) ?? tried()[role] ?? ROLES[role].model;
}
