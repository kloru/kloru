/**
 * Phone calls through Inkbox Voice AI. The agent places a call with a task brief; Inkbox
 * drives the conversation and posts `call.ended` when it is over. This file turns that
 * event into the one text the owner reads, from the transcript and nothing else: the
 * model never writes the report, so it cannot say more than the call showed.
 */
import type { CallTurn } from "./channel.js";
import type { CallEndedEvent } from "./events.js";

/** Per-identity steering for Voice AI, set at boot. Short on purpose: Inkbox appends it to its own prompt. */
export function voiceInstructions(ownerName: string): string {
  return `You are ${ownerName}'s assistant calling on their behalf. Be brief and polite, confirm names and times before you end the call, and never share ${ownerName}'s card details or personal data.`;
}

const MAX_TURNS = 6;
const MAX_TURN_CHARS = 160;
const MAX_ITEM_CHARS = 200;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function duration(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return "";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** The first sentence of the report: what happened, in words the owner can act on. */
export function callOutcomeSentence(event: CallEndedEvent): string {
  const who = event.contactName ? `${event.contactName} (${event.remoteNumber})` : event.remoteNumber;
  const dur = duration(event.durationSeconds);
  if (event.hangupReason === "voicemail") return `My call to ${who} went to voicemail; I left a message.`;
  switch (event.outcome) {
    case "completed":
      return `My call to ${who} is done${dur ? ` (${dur})` : ""}.`;
    case "no_answer":
      return `My call to ${who} was not answered.`;
    case "declined":
      return `My call to ${who} was declined.`;
    case "failed":
      return `My call to ${who} did not connect.`;
    default:
      break;
  }
  if (event.status === "completed") return `My call to ${who} is done${dur ? ` (${dur})` : ""}.`;
  if (event.status === "failed" || event.status === "canceled") return `My call to ${who} did not connect.`;
  return `My call to ${who} ended (${event.status}).`;
}

/**
 * The owner's text: the outcome, the last few turns so they can see what was said, and
 * the action items Voice AI recorded. Plain lines; iMessage shows no markdown.
 */
export function callReportText(event: CallEndedEvent, transcript: CallTurn[]): string {
  const lines = [callOutcomeSentence(event)];
  const spoken = transcript.filter((t) => t.party === "local" || t.party === "remote");
  if (spoken.length > 0) {
    const tail = spoken.slice(-MAX_TURNS);
    if (tail.length < spoken.length) lines.push("Last part of the call:");
    else lines.push("What was said:");
    for (const t of tail) lines.push(`${t.party === "remote" ? "Them" : "Me"}: ${clip(t.text, MAX_TURN_CHARS)}`);
  }
  if (event.actionItems.length > 0) {
    lines.push("To do:");
    for (const item of event.actionItems) {
      const details = item.details ? ` (${clip(item.details, MAX_ITEM_CHARS)})` : "";
      lines.push(`- ${clip(item.action, MAX_ITEM_CHARS)}${details}`);
    }
  }
  return lines.join("\n");
}

export interface CallEndedDeps {
  /** The verbatim transcript from Inkbox, fetched only when the event carried none. */
  fetchTranscript?: (callId: string) => Promise<CallTurn[]>;
  /** Deliver one text to the owner. False when there is no way to reach them. */
  relayToOwner: (text: string) => Promise<boolean>;
  logger?: (m: string) => void;
}

/**
 * Report a finished call to the owner. The inline transcript on the event is used when
 * present; when the event says there is none (`transcript: null`) the verbatim one is
 * fetched, because the abridged inline copy is only ever a convenience. A transcript
 * fetch that fails still produces the outcome line: the owner must hear the call ended.
 */
export async function handleCallEnded(event: CallEndedEvent, deps: CallEndedDeps): Promise<{ delivered: boolean; text: string }> {
  const log = deps.logger ?? (() => {});
  let transcript = event.transcript ?? [];
  if (event.transcript === null && deps.fetchTranscript) {
    try {
      transcript = await deps.fetchTranscript(event.callId);
    } catch (err) {
      log(`call ${event.callId}: transcript unavailable: ${(err as Error).message}`);
      transcript = [];
    }
  }
  const text = callReportText(event, transcript);
  const delivered = await deps.relayToOwner(text);
  if (!delivered) log(`call ${event.callId}: no way to reach the owner with the call report`);
  return { delivered, text };
}
