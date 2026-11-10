/**
 * The life of one outbox item. Every message to a person is an item; it ends in exactly one of
 * sent, dropped, merged (another message carried it) or cancelled.
 */
import { err, ok, type Result } from "./result.js";

export type OutboxState = "new" | "queued" | "scheduled" | "sending" | "sent" | "dropped" | "merged" | "cancelled";

const TRANSITIONS: Record<OutboxState, readonly OutboxState[]> = {
  new: ["sending", "dropped", "queued"],
  queued: ["sending", "scheduled", "merged", "dropped", "cancelled"],
  scheduled: ["sending", "queued", "dropped", "cancelled"],
  // Back to queued when the channel failed, or when a restart cut the send off.
  sending: ["sent", "queued"],
  sent: [],
  dropped: [],
  merged: [],
  cancelled: [],
};

export const OUTBOX_FINAL: readonly OutboxState[] = ["sent", "dropped", "merged", "cancelled"];

export const isFinal = (s: OutboxState): boolean => OUTBOX_FINAL.includes(s);

export function canMove(from: OutboxState, to: OutboxState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function moveItem<T extends { id: string; state: OutboxState }>(item: T, to: OutboxState): Result<T> {
  if (!canMove(item.state, to)) return err(`outbox item ${item.id}: ${item.state} → ${to} is not allowed`);
  item.state = to;
  return ok(item);
}
