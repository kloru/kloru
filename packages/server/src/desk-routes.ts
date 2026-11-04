/**
 * /desk/* — the talking model's side of the desk (see @kloru/desk). Owner surface: the
 * chat token guards it like /chat. The inbox long-polls so a merge reaches the call within
 * moments without the voice service hammering the agent.
 */
import { DeskConflict, type Desk } from "@kloru/desk";
import type { Tier } from "@kloru/core";

export interface DeskReply {
  status: number;
  body: unknown;
}

const MAX_WAIT_S = 25;
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export interface DeskRouteOptions {
  /** Who may call this family's number, by the number calling. Unset: nobody but the owner, whom voice admits itself. */
  callers?: (phone: string) => Caller;
}

export interface Caller {
  allowed: boolean;
  name?: string;
  tier?: Tier;
}

export async function deskRoute(desk: Desk, method: string, path: string, url: URL, body: () => Promise<unknown>, o: DeskRouteOptions = {}): Promise<DeskReply> {
  const bad = (error: string): DeskReply => ({ status: 400, body: { error } });
  let parts: string[];
  try {
    parts = path.split("/").slice(2).map(decodeURIComponent); // ["calls", id, "turns"] ...
  } catch {
    return bad("malformed path");
  }
  try {
    if (method === "GET" && parts.length === 2 && parts[0] === "callers") {
      return { status: 200, body: o.callers ? o.callers(parts[1]!) : { allowed: false } };
    }
    if (method === "POST" && parts.length === 1 && parts[0] === "calls") {
      const b = (await body()) as Record<string, unknown> | undefined;
      const callSid = text(b?.callSid);
      const phone = text(b?.phone);
      if (!callSid || !phone) return bad("expected { callSid, phone, name? }");
      const name = text(b?.name);
      const out = desk.startCall({ callSid, phone, ...(name ? { name } : {}), channel: text(b?.channel) ?? "voice" });
      return { status: 200, body: out };
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "issues") {
      const call = url.searchParams.get("call");
      return { status: 200, body: { issues: call ? desk.openIssues(call) : desk.openIssues() } };
    }
    if (method === "POST" && parts.length === 2 && parts[0] === "memory" && parts[1] === "backfill") {
      const b = (await body()) as Record<string, unknown> | undefined;
      return { status: 200, body: { filed: desk.backfillMemory({ again: b?.again === true }) } };
    }

    if (parts[0] === "calls" && parts.length === 3) {
      const id = parts[1]!;
      if (!desk.repo.call(id)) return { status: 404, body: { error: "no such call" } };
      const action = parts[2];
      // An ended call is history: nothing new lands on it (#20).
      if (method === "POST" && (action === "turns" || action === "issues") && desk.repo.call(id)!.endedAt) return { status: 409, body: { error: "the call has ended" } };
      if (method === "POST" && action === "turns") {
        const b = (await body()) as Record<string, unknown> | undefined;
        const role = b?.role;
        const t = typeof b?.text === "string" ? b.text : undefined;
        if ((role !== "caller" && role !== "kloru") || t === undefined) return bad('expected { role: "caller" | "kloru", text, interrupted? }');
        return { status: 200, body: desk.addTurn(id, { role, text: t, ...(b?.interrupted === true ? { interrupted: true } : {}) }) };
      }
      if (method === "POST" && action === "issues") {
        const b = (await body()) as Record<string, unknown> | undefined;
        const request = text(b?.request);
        if (!request) return bad("expected { request }");
        return { status: 200, body: { issue: desk.fileIssue(id, request) } };
      }
      if (method === "GET" && action === "inbox") {
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? 0) || 0));
        return { status: 200, body: { items: await desk.waitInbox(id, after, wait * 1000), ended: !!desk.repo.call(id)?.endedAt } };
      }
      if (method === "POST" && action === "ack") {
        const b = (await body()) as Record<string, unknown> | undefined;
        if (!Number.isInteger(b?.seq)) return bad("expected { seq }");
        desk.ack(id, b!.seq as number);
        return { status: 200, body: { ok: true } };
      }
      if (method === "POST" && action === "notes") {
        const b = (await body()) as Record<string, unknown> | undefined;
        const t = text(b?.text);
        if (!t) return bad("expected { text }");
        // A guideline ("be more concise") is saved at once; anything else waits for the end-of-call memory.
        const kept = await desk.rememberNow(id, t);
        return { status: 200, body: { ok: true, kept } };
      }
      if (method === "POST" && action === "end") {
        desk.endCall(id);
        return { status: 200, body: { ok: true } };
      }
    }

    if (parts[0] === "issues" && parts.length === 3 && method === "POST") {
      const n = Number(parts[1]);
      if (!Number.isInteger(n)) return bad("issue must be a number");
      const b = (await body()) as Record<string, unknown> | undefined;
      const call = text(b?.call);
      if (!call) return bad("expected { call, ... }");
      if (parts[2] === "comments") {
        const t = text(b?.text);
        if (!t) return bad("expected { call, text }");
        desk.comment(n, call, t);
        return { status: 200, body: { ok: true } };
      }
      if (parts[2] === "confirm") {
        const draft = text(b?.draft);
        if (!draft) return bad("expected { call, draft }: the draft id from the <info> that asked for a yes");
        return { status: 200, body: { issue: desk.confirm(n, call, draft) } };
      }
    }
  } catch (error) {
    if (error instanceof DeskConflict) return { status: 409, body: { error: error.message } };
    throw error;
  }
  return { status: 404, body: { error: "not found" } };
}
