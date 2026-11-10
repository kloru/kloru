/**
 * The owner says who's in the family and what they may do ("Add my wife Cleo, she should be able
 * to do and see everything"); a structured decision model (decision-models skill; Flash until a Jev
 * key) maps the words to a tier and grants. Code keeps out what no member may hold and writes the read-back (what they
 * are now, what they'd become, what they'd lose), and the owner's yes saves it with the words, which every later decision reads.
 */
import type { MemberPlan } from "@kloru/desk";
import { normalizePhone, type Capability } from "@kloru/core";
import { chatCompletion } from "./openrouter.js";

const MODEL = "google/gemini-3.5-flash";

/** What a member may be given, in the owner's terms. Shells, trust, memory, schedules, invites and calls stay the owner's. */
const PLAIN: Partial<Record<Capability, string>> = {
  "owner.profile.preferences": "know your preferences",
  "owner.location.exact": "know exactly where you are",
  "owner.location.approx": "know roughly where you are",
  "calendar.freebusy": "see when you're free",
  "calendar.read": "see your calendar",
  "calendar.write": "add meetings to your calendar, or move and remove events",
  "email.read": "read your email",
  "email.send": "send email as you",
  "contacts.read": "see your contacts",
  "plans.propose": "suggest plans",
  "plans.commit": "commit you to plans",
  purchase: "buy things on your accounts",
  "travel.book": "book travel for you",
  "web.read": "look things up on the web",
  "apps.use": "use your connected apps",
  "network.ask": "ask other people's assistants",
};
export const DELEGABLE = Object.keys(PLAIN) as Capability[];
const OWNER_ONLY_PLAIN: Partial<Record<string, string>> = {
  "computer.use": "use the computer",
  "files.read": "read files",
  "files.write": "change files",
  "trust.manage": "change who can do what",
  "memory.write": "change what Kloru remembers",
  "schedule.manage": "set up schedules",
  "network.invite": "invite people",
  "phone.call": "place phone calls",
};

const TIERS = ["owner", "partner", "family", "friend"] as const;
/** The owner's say goes only to someone his own words make a co-owner. */
const CO_OWNER_WORDS = /\bco-?owner\b|\bsame (?:permissions|access|say|rights) as (?:me|i have)\b/i;

/** All anyone who calls may ever be given: seeing when the owner is free and booking time. Never mail, contacts, location or money. */
export const PUBLIC_OK: readonly Capability[] = ["calendar.freebusy", "calendar.write", "plans.propose", "plans.commit", "web.read"];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["who", "name", "phone", "email", "tier", "capabilities"],
  properties: {
    who: { type: "string", enum: ["person", "anyone"], description: "anyone: the owner means everyone who calls, not one person" },
    name: { type: "string" },
    phone: { type: "string", description: "their number as said, or from the family list; empty if not given" },
    email: { type: "string", description: "empty if not given" },
    tier: { type: "string", enum: [...TIERS] },
    capabilities: { type: "array", items: { type: "string", enum: DELEGABLE } },
  },
};

export const MEMBER_PROMPT = `The family owner is telling Kloru, their family's assistant, about a person, or about anyone who calls, and what they may do through Kloru.
"Anyone who calls", "the public", "everyone else": who is anyone, with no name or number; turning it off means no capabilities.
Pick the tier closest to the relationship (partner: spouse; family: other relatives; friend; owner only for a co-owner, "the same as me"), then every capability the owner's words give them.
"Everything" means every capability listed. "See" means the ones that see or know; "do" means the rest. Leave out what the words don't give.`;

interface Raw {
  who?: string;
  name: string;
  phone: string;
  email: string;
  tier: string;
  capabilities: string[];
}

/** A phone number as Kloru says it: "4 1 5, 5 5 5, 0 1 9 1". */
function spoken(phone: string): string {
  const d = phone.replace(/\D/g, "").slice(-10);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].map((g) => g.split("").join(" ")).join(", ");
}

/** Where someone stands before the change: their tier (none: not in the family) and what they can do. */
export interface Standing {
  tier?: string;
  capabilities: readonly Capability[];
}

/** Transport capabilities: the specific capability on each tool does the gating, so words never take these away. */
export const PLUMBING: ReadonlySet<Capability> = new Set(["apps.use", "web.read"]);

const TIER_WORDS: Record<MemberPlan["tier"], string> = { owner: "a co-owner", partner: "your partner", family: "family", friend: "a friend" };
const RANK: Record<MemberPlan["tier"], number> = { friend: 0, family: 1, partner: 2, owner: 3 };
const plain = (caps: readonly Capability[]): string => caps.map((c) => PLAIN[c] ?? c).join("; ");

/** What the owner hears before a yes: who, what they are now, what they'd become, what they could do, what they'd lose. Said by code from what will be saved. */
function readBack(name: string, phone: string, tier: MemberPlan["tier"], capabilities: Capability[], now: Standing | undefined): string {
  const was = now?.tier && now.tier in RANK ? (now.tier as MemberPlan["tier"]) : undefined;
  const head = `${name}, ${spoken(phone)}: ${was ? `${TIER_WORDS[was]} now` : "not in the family yet"}.`;
  if (tier === "owner") return `${head} ${was === "owner" ? "Nothing would change." : `This would make ${name} a co-owner: the same say as you, over everything.`}`;
  const to = TIER_WORDS[tier];
  const move = !was ? `This would add ${name} as ${to}.` : RANK[tier] < RANK[was] ? `This would lower ${name} to ${to}.` : RANK[tier] > RANK[was] ? `This would raise ${name} to ${to}.` : `${name} would stay ${to}.`;
  const could = capabilities.length === DELEGABLE.length ? "everything a family member can" : plain(capabilities) || "nothing";
  const lost = (now?.capabilities ?? []).filter((c) => !capabilities.includes(c) && !PLUMBING.has(c));
  const loses = was === "owner" ? ` ${name} would no longer be a co-owner, and would lose everything else.` : lost.length ? ` ${name} would lose: ${plain(lost)}.` : "";
  return `${head} ${move} ${name} could: ${could}.${loses}`;
}

/** Code's part: a real number, a member tier, only what a member may hold, and the read-back. */
export function clampMember(raw: Raw, words: string, now?: Standing): MemberPlan {
  if (raw.who === "anyone") {
    const asked = [...new Set(raw.capabilities)];
    const capabilities = asked.filter((c): c is Capability => (PUBLIC_OK as string[]).includes(c));
    const leftOut = asked.filter((c) => !(PUBLIC_OK as string[]).includes(c)) as Capability[];
    const not = leftOut.map((c) => PLAIN[c as Capability] ?? OWNER_ONLY_PLAIN[c] ?? c);
    const said = `Anyone who calls can now: ${plain(now?.capabilities ?? []) || "nothing, Kloru is just for your family"}. This would change it to: ${plain(capabilities) || "nothing, Kloru would be just for your family"}.`;
    const readBack = said + (not.length ? ` (Not ${not.join(", ")}: only you can.)` : "") + " Okay?";
    return { who: "anyone", name: "Anyone who calls", phone: "", tier: "friend", capabilities, leftOut, readBack, words };
  }
  const phone = normalizePhone(raw.phone);
  if (phone.replace(/\D/g, "").length < 11) throw new Error(`I didn't catch a full phone number for ${raw.name || "them"}.`);
  const name = raw.name.trim();
  const named = (TIERS as readonly string[]).includes(raw.tier) ? (raw.tier as MemberPlan["tier"]) : "partner";
  const tier = named === "owner" && !CO_OWNER_WORDS.test(words) ? "partner" : named;
  const asked = tier === "owner" ? [] : [...new Set(raw.capabilities)];
  const capabilities = asked.filter((c): c is Capability => (DELEGABLE as string[]).includes(c));
  const leftOut = asked.filter((c) => !(DELEGABLE as string[]).includes(c)) as Capability[];
  const not = leftOut.map((c) => OWNER_ONLY_PLAIN[c] ?? c);
  // Every word Ezra hears comes from what will be saved, never from the model's sentence.
  const said = readBack(name, phone, tier, capabilities, now) + (not.length ? ` (Not ${not.join(", ")}: only you can.)` : "") + " Okay?";
  return { who: "person", name, phone, ...(raw.email.trim() ? { email: raw.email.trim().toLowerCase() } : {}), tier, capabilities, leftOut, readBack: said, words };
}

export function memberPolicy(o: { apiKey: string; members: () => string; /** Where a number stands now ("" for anyone who calls), for the read-back. */ standing?: (phone: string) => Standing | undefined; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (words: string) => Promise<MemberPlan> {
  return async (words) => {
    const user = [
      `The owner said: "${words}"`,
      `Capabilities:\n${Object.entries(PLAIN).map(([c, plain]) => `${c}: ${plain}`).join("\n")}`,
      `Already in the family:\n${o.members() || "nobody yet"}`,
    ].join("\n\n");
    const content = await chatCompletion({ apiKey: o.apiKey, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), timeoutMs: o.timeoutMs ?? 10_000 }, {
      model: o.model ?? MODEL,
      reasoning: { effort: "minimal" },
      messages: [
        { role: "system", content: MEMBER_PROMPT },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name: "set_member", strict: true, schema: SCHEMA } },
    });
    const raw = JSON.parse(content || "{}") as Partial<Raw>;
    if ((!raw.name && raw.who !== "anyone") || !Array.isArray(raw.capabilities)) throw new Error(`no membership in ${JSON.stringify(raw).slice(0, 200)}`);
    return clampMember({ who: raw.who ?? "person", name: raw.name ?? "", phone: raw.phone ?? "", email: raw.email ?? "", tier: raw.tier ?? "partner", capabilities: raw.capabilities }, words, o.standing?.(raw.who === "anyone" ? "" : normalizePhone(raw.phone ?? "")));
  };
}
