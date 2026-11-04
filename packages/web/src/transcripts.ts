/**
 * Call transcripts written by the voice service (voice/transcript.py):
 * <dir>/<YYYY-MM-DD>/<CallSid>.jsonl, one event per line.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TranscriptEvent {
  at: string;
  kind: "call_started" | "caller" | "kloru" | "task_started" | "task_finished" | "call_ended";
  text?: string;
  interrupted?: boolean;
  task?: number;
  request?: string;
  size?: string;
  status?: string;
  result?: string;
  after_call?: boolean;
  from?: string;
}

const KINDS = new Set(["call_started", "caller", "kloru", "task_started", "task_finished", "call_ended"]);
/** Twilio call ids only, so a URL can never name another file. */
export const CALL_SID = /^CA[0-9a-f]{32}$/;

export function readTranscript(dir: string, callSid: string): TranscriptEvent[] | undefined {
  if (!CALL_SID.test(callSid)) return undefined;
  let days: string[];
  try {
    days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch {
    return undefined;
  }
  const day = days.find((d) => existsSync(join(dir, d, `${callSid}.jsonl`)));
  if (!day) return undefined;
  const events: TranscriptEvent[] = [];
  for (const line of readFileSync(join(dir, day, `${callSid}.jsonl`), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TranscriptEvent;
      if (typeof e.at === "string" && KINDS.has(e.kind)) events.push(e);
    } catch {
      continue;
    }
  }
  return events;
}
