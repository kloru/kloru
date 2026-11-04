/**
 * The gateway relays Inkbox events through Maritime's plain `/chat` endpoint. To
 * tell an event apart from a human typing in the dashboard, the JSON is prefixed
 * with a marker no person would type.
 */
import { EVENT_ENVELOPE_PREFIX } from "./types.js";

export function encodeEvent(event: unknown): string {
  return EVENT_ENVELOPE_PREFIX + JSON.stringify(event);
}

/**
 * A task the operator's front door asks the agent to run as its owner, without
 * anyone having texted: research before the first contact, a one-off reminder.
 * `quiet` keeps the result out of the owner's messages (memory and schedules only).
 */
export const SYSTEM_TASK_EVENT = "system.task";

export interface SystemTaskEvent {
  type: typeof SYSTEM_TASK_EVENT;
  /** Stable id; the conversation key is `system:<id>` so a repeat continues the same thread. */
  id: string;
  name?: string;
  prompt: string;
  quiet?: boolean;
}

export function systemTaskOf(event: unknown): SystemTaskEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Record<string, unknown>;
  if (e.type !== SYSTEM_TASK_EVENT) return undefined;
  if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(e.id)) return undefined;
  if (typeof e.prompt !== "string" || !e.prompt.trim()) return undefined;
  const task: SystemTaskEvent = { type: SYSTEM_TASK_EVENT, id: e.id, prompt: e.prompt };
  if (typeof e.name === "string" && e.name) task.name = e.name;
  if (e.quiet === true) task.quiet = true;
  return task;
}

/** Returns the event, or undefined when the message is ordinary text or malformed. */
export function decodeEvent(message: string): unknown | undefined {
  if (typeof message !== "string") return undefined;
  const trimmed = message.trimStart();
  if (!trimmed.startsWith(EVENT_ENVELOPE_PREFIX)) return undefined;
  const body = trimmed.slice(EVENT_ENVELOPE_PREFIX.length).trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

export function isEnvelope(message: string): boolean {
  return typeof message === "string" && message.trimStart().startsWith(EVENT_ENVELOPE_PREFIX);
}
