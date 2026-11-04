/**
 * The owner says who's in the family and what they may do ("Add my wife Cara, she should be able
 * to do and see everything"); a structured decision model (decision-models skill; Flash until a Jev
 * key) maps the words to a tier and grants. Code keeps out what no member may hold, Kloru reads it
 * back, and the owner's yes saves it with the words, which every later decision reads.
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
  required: ["who", "name", "phone", "email", "tier", "capabilities", "read_back"],
  properties: {
    who: { type: "string", enum: ["person", "anyone"], description: "anyone: the owner means everyone who calls, not one person" },
    name: { type: "string" },
    phone: { type: "string", description: "their number as said, or from the family list; empty if not given" },
    email: { type: "string", description: "empty if not given" },
    tier: { type: "string", enum: [...TIERS] },
    capabilities: { type: "array", items: { type: "string", enum: DELEGABLE } },
    read_back: { type: "string" },
  },
};

export const MEMBER_PROMPT = `The family owner is telling Kloru, their family's assistant, about a person, or about anyone who calls, and what they may do through Kloru.
"Anyone who calls", "the public", "everyone else": who is anyone, with no name or number; turning it off means no capabilities.
Pick the tier closest to the relationship (partner: spouse; family: other relatives; friend; owner only for a co-owner, "the same as me"), then every capability the owner's words give them.
"Everything" means every capability listed. "See" means the ones that see or know; "do" means the rest. Leave out what the words don't give.
read_back: one sentence Kloru says to the owner about what they may do, without their name or number (Kloru says those first), e.g. "As your partner: she can see and do everything except change who's in the family. Okay?" or "Anyone who calls Kloru can see when you're free and book a meeting with you. Okay?"`;

interface Raw {
  who?: string;
  name: string;
  phone: string;
  email: string;
  tier: string;
  capabilities: string[];
  read_back: string;
}

/** A phone number as Kloru says it: "4 1 5, 5 5 5, 0 1 9 1". */
function spoken(phone: string): string {
  const d = phone.replace(/\D/g, "").slice(-10);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].map((g) => g.split("").join(" ")).join(", ");
}

/** Code's part: a real number, a member tier, and only what a member may hold. */
export function clampMember(raw: Raw, words: string): MemberPlan {
  if (raw.who === "anyone") {
    const asked = [...new Set(raw.capabilities)];
    const capabilities = asked.filter((c): c is Capability => (PUBLIC_OK as string[]).includes(c));
    const leftOut = asked.filter((c) => !(PUBLIC_OK as string[]).includes(c)) as Capability[];
    const not = leftOut.map((c) => PLAIN[c as Capability] ?? OWNER_ONLY_PLAIN[c] ?? c);
    const readBack = raw.read_back.trim() + (not.length ? ` (Not ${not.join(", ")}: only you can.)` : "");
    return { who: "anyone", name: "Anyone who calls", phone: "", tier: "friend", capabilities, leftOut, readBack, words };
  }
  const phone = normalizePhone(raw.phone);
  if (phone.replace(/\D/g, "").length < 11) throw new Error(`I didn't catch a full phone number for ${raw.name || "them"}.`);
  const named = (TIERS as readonly string[]).includes(raw.tier) ? (raw.tier as MemberPlan["tier"]) : "partner";
  const tier = named === "owner" && !CO_OWNER_WORDS.test(words) ? "partner" : named;
  if (tier === "owner") {
    const readBack = `${raw.name.trim()}, ${spoken(phone)}: as a co-owner, the same say as you, over everything. Okay?`;
    return { who: "person", name: raw.name.trim(), phone, ...(raw.email.trim() ? { email: raw.email.trim().toLowerCase() } : {}), tier, capabilities: [], leftOut: [], readBack, words };
  }
  const asked = [...new Set(raw.capabilities)];
  const capabilities = asked.filter((c): c is Capability => (DELEGABLE as string[]).includes(c));
  const leftOut = asked.filter((c) => !(DELEGABLE as string[]).includes(c)) as Capability[];
  const not = leftOut.map((c) => OWNER_ONLY_PLAIN[c] ?? c);
  // The name and number Evan hears come from what will be saved, never from the model's words.
  const said = raw.read_back.trim().replace(/\+?\d[\d\s,.()-]{5,}\d,?\s*/g, "").replace(new RegExp(`^${raw.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,:]?\s*`, "i"), "");
  const readBack = `${raw.name.trim()}, ${spoken(phone)}: ${said}` + (not.length ? ` (Not ${not.join(", ")}: only you can.)` : "");
  return { who: "person", name: raw.name.trim(), phone, ...(raw.email.trim() ? { email: raw.email.trim().toLowerCase() } : {}), tier, capabilities, leftOut, readBack, words };
}

export function memberPolicy(o: { apiKey: string; members: () => string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (words: string) => Promise<MemberPlan> {
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
    return clampMember({ who: raw.who ?? "person", name: raw.name ?? "", phone: raw.phone ?? "", email: raw.email ?? "", tier: raw.tier ?? "partner", capabilities: raw.capabilities, read_back: raw.read_back ?? "" }, words);
  };
}
