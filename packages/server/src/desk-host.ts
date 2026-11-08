/**
 * Desk workers run as AgentRuntime worker conversations, one per issue and role
 * (`desk:issue:<n>:<role>`), so a follow-up continues the same session, new input can be
 * steered in mid-run, and an issue reassigned from ops to work never keeps ops' tools.
 */
import type { WorkerHost } from "@kloru/desk";
import type { AgentRuntime, Principal, WorkerRole } from "@kloru/core";

const keyOf = (issue: number, role: WorkerRole) => `desk:issue:${issue}:${role.name}`;

export class RuntimeWorkerHost implements WorkerHost {
  /** Each issue's role, set by its first run; steer and stop never create a worker. */
  private readonly roles = new Map<number, WorkerRole>();
  /** Runs on one issue queue behind each other: a conversation runs one prompt at a time. */
  private readonly chains = new Map<number, Promise<unknown>>();

  /** A follow-up issue's conversation: the earlier issue whose worker it continues. */
  private readonly sessions = new Map<number, number>();
  /** Each issue's person, so steer and stop reach the same conversation. */
  private readonly principals = new Map<number, Principal | undefined>();

  /** `principalFor`: who a phone number is (undefined: the owner). */
  constructor(
    private readonly runtime: Pick<AgentRuntime, "worker" | "retire">,
    private readonly principalFor: (phone: string) => Principal | undefined = () => undefined,
  ) {}

  run(issue: number, role: WorkerRole, prompt: string, phone?: string, session?: number): Promise<string> {
    this.roles.set(issue, role);
    if (session !== undefined) this.sessions.set(issue, session);
    this.principals.set(issue, phone ? this.principalFor(phone) : undefined);
    const conv = this.worker(issue, role);
    const next = (this.chains.get(issue) ?? Promise.resolve()).catch(() => undefined).then(() => conv.run(prompt));
    this.chains.set(issue, next);
    return next;
  }

  private running(issue: number) {
    const role = this.roles.get(issue);
    if (!role) return undefined;
    const conv = this.worker(issue, role);
    return conv.busy ? conv : undefined;
  }

  private worker(issue: number, role: WorkerRole) {
    const principal = this.principals.get(issue);
    const key = keyOf(this.sessions.get(issue) ?? issue, role);
    return principal ? this.runtime.worker(key, role, principal) : this.runtime.worker(key, role);
  }

  steer(issue: number, text: string): boolean {
    const conv = this.running(issue);
    if (!conv) return false;
    conv.steer(text);
    return true;
  }

  /**
   * Abort the run, and let the next one start fresh: a tool that ignores the abort (a browser call
   * stuck on a Cloudflare check, #493) would otherwise hold every later run behind it forever.
   */
  stop(issue: number): void {
    const conv = this.running(issue);
    if (!conv) return;
    conv.agent.abort();
    this.runtime.retire(conv.key);
    this.chains.delete(issue);
  }
}
