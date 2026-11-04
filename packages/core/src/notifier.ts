/**
 * "Enforced twice": when the policy stops a request from someone who is not the owner,
 * the requester gets a polite refusal and the owner gets a heads-up, so a partner's
 * Kloru probing the calendar never happens in silence. One notice per conversation
 * per hour keeps a chatty peer from flooding the owner's phone.
 */
import type { AuditLog } from "./audit.js";
import type { StateDir } from "./state.js";

const FILE = "owner-notices.json";
export const NOTICE_WINDOW_MS = 60 * 60 * 1000;

export interface OwnerNoticeDeps {
  state: StateDir;
  audit: AuditLog;
  /** Deliver the text to the owner. Throws are swallowed and audited. */
  send: (text: string) => Promise<void>;
  now?: () => Date;
  windowMs?: number;
}

export interface OwnerNotice {
  conversationKey: string;
  principal: string;
  /** What was refused, in plain words: "see your calendar". */
  action: string;
  outcome: "declined" | "asked";
}

type Record_ = Record<string, string>;

export class OwnerNotifier {
  private readonly deps: OwnerNoticeDeps;
  private readonly now: () => Date;
  private readonly windowMs: number;

  constructor(deps: OwnerNoticeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.windowMs = deps.windowMs ?? NOTICE_WINDOW_MS;
  }

  /** The text the owner reads. */
  static text(notice: OwnerNotice, who: string): string {
    const verb = notice.outcome === "declined" ? "I declined" : "I am asking you first";
    return `${who} asked to ${notice.action}; ${verb}.`;
  }

  /**
   * Send the notice unless this conversation was already notified inside the window.
   * Returns true when a message went out.
   */
  async notify(notice: OwnerNotice, who: string): Promise<boolean> {
    const nowMs = this.now().getTime();
    const sent = this.deps.state.readJson<Record_>(FILE, {});
    const last = sent[notice.conversationKey];
    if (last && Date.parse(last) + this.windowMs > nowMs) return false;

    // Sweep old entries so the file stays small.
    for (const [key, at] of Object.entries(sent)) if (Date.parse(at) + this.windowMs <= nowMs) delete sent[key];
    sent[notice.conversationKey] = new Date(nowMs).toISOString();
    this.deps.state.writeJson(FILE, sent);

    const text = OwnerNotifier.text(notice, who);
    try {
      await this.deps.send(text);
      this.deps.audit.append({ kind: "policy", conversationKey: notice.conversationKey, principal: notice.principal, detail: { ownerNotified: true, action: notice.action, outcome: notice.outcome } });
      return true;
    } catch (error) {
      this.deps.audit.append({ kind: "error", conversationKey: notice.conversationKey, principal: notice.principal, detail: { message: `owner notice failed: ${error instanceof Error ? error.message : String(error)}` } });
      return false;
    }
  }
}
