/**
 * The voice service's call log (one JSON line per call to a Kloru number; see voice/calllog.py),
 * summarized for the Admin page.
 */
import { readFileSync } from "node:fs";

export const OUTCOMES = ["connected", "hung_up_attestation", "refused_unknown", "bad_signature"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface CallEntry {
  at: string;
  callSid: string;
  from: string;
  verstat: string;
  outcome: Outcome;
  ip?: string;
}

export interface CallSummary {
  /** Counts over the last 7 days. */
  week: Record<Outcome, number>;
  /** Newest first, at most 50. */
  recent: CallEntry[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT = 50;

export function readCalls(path: string, now = new Date()): CallSummary {
  const week = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { week, recent: [] };
  }
  const entries: CallEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const outcome = raw.outcome as Outcome;
    if (typeof raw.at !== "string" || !OUTCOMES.includes(outcome)) continue;
    entries.push({ at: raw.at, callSid: String(raw.call_sid ?? ""), from: String(raw.from ?? ""), verstat: String(raw.verstat ?? ""), outcome, ...(raw.ip ? { ip: String(raw.ip) } : {}) });
  }
  const since = now.getTime() - WEEK_MS;
  for (const e of entries) if (Date.parse(e.at) >= since) week[e.outcome]++;
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { week, recent: entries.slice(0, RECENT) };
}
