/**
 * App events through Composio triggers: an automation watches one event of one connected account
 * (a new Gmail message on Evan's personal address), and Composio posts each one to the project's
 * single webhook, signed with the project's secret.
 */
import type { StateDir } from "@kloru/core";

/** File under the StateDir that remembers the webhook URL Composio posts to and its signing secret. */
export const WEBHOOK_STATE_FILE = "composio-webhook.json";

/** The parts of the Composio SDK's triggers and webhook subscriptions this file uses. */
export interface ComposioTriggersLike {
  create(userId: string, slug: string, body?: { connectedAccountId?: string; triggerConfig?: Record<string, unknown> }): Promise<{ triggerId: string }>;
  delete(triggerId: string): Promise<unknown>;
  getType(slug: string): Promise<TriggerTypeLike>;
  listTypes(query?: { toolkits?: string[] | null; limit?: number | null; cursor?: string }): Promise<{ items: TriggerTypeLike[]; nextCursor?: string | null }>;
  setWebhookSubscription(params: { webhookUrl: string }): Promise<{ id: string; webhookUrl: string; secret?: string }>;
  verifyWebhook(params: { id: string; payload: string; signature: string; timestamp: string; secret: string }): Promise<{ payload: { triggerSlug: string; payload?: Record<string, unknown>; metadata: { id: string; connectedAccount: { id: string } } } }>;
}

export interface WebhookSubscriptionsLike {
  list(query?: { limit?: number }): Promise<{ items: Array<{ id: string; webhookUrl: string; secret?: string }> }>;
}

export interface TriggerTypeLike {
  slug: string;
  name: string;
  description: string;
  instructions?: string;
  config: Record<string, unknown>;
}

/** One app event as it arrived, verified. */
export interface AppEvent {
  /** The delivery id (webhook-id): a redelivery has the same one. */
  id: string;
  /** The trigger it came from: the automation's `on.instance`. */
  instance: string;
  trigger: string;
  account: string;
  data: Record<string, unknown>;
}

const header = (h: Record<string, string | string[] | undefined>, name: string) => ((v) => (Array.isArray(v) ? v[0] : v))(h[name]);

export class ComposioTriggers {
  constructor(
    private readonly o: {
      triggers: ComposioTriggersLike;
      subscriptions?: WebhookSubscriptionsLike;
      userId: string;
      state: StateDir;
      /** A connected account's id from its address (or its id), for the app the event belongs to. */
      accountId(trigger: string, account: string): string | undefined;
      log?: (m: string) => void;
    },
  ) {}

  /** What an app can start an automation on: each event's slug, name, use and settings. */
  async types(toolkit: string): Promise<TriggerTypeLike[]> {
    const res = await this.o.triggers.listTypes({ toolkits: [toolkit.trim().toLowerCase()], limit: 50 });
    return res.items;
  }

  /** Watch one event of one connected account. Composio reuses an identical trigger rather than make a second. */
  async watch(trigger: string, account: string, config?: Record<string, unknown>): Promise<{ instance: string; label: string }> {
    const slug = trigger.trim().toUpperCase();
    const id = this.o.accountId(slug, account);
    if (!id) throw new Error(`no connected account ${account} for ${slug}`);
    const type = await this.o.triggers.getType(slug);
    const r = await this.o.triggers.create(this.o.userId, slug, { connectedAccountId: id, ...(config && Object.keys(config).length ? { triggerConfig: config } : {}) });
    return { instance: r.triggerId, label: type.name.replace(/\s+trigger$/i, "") };
  }

  async unwatch(instance: string): Promise<void> {
    await this.o.triggers.delete(instance);
  }

  /**
   * Point the project's one webhook at this Kloru, and learn its signing secret. A webhook that
   * points elsewhere is moved (and the old URL logged): only a deployed Kloru calls this.
   */
  async subscribe(url: string): Promise<void> {
    const current = (await this.o.subscriptions?.list({ limit: 1 }))?.items[0];
    if (current?.webhookUrl === url && current.secret) {
      this.o.state.writeJson(WEBHOOK_STATE_FILE, { url, secret: current.secret });
      return;
    }
    const sub = await this.o.triggers.setWebhookSubscription({ webhookUrl: url });
    if (!sub.secret) throw new Error("Composio didn't return the webhook's signing secret");
    this.o.state.writeJson(WEBHOOK_STATE_FILE, { url, secret: sub.secret });
    this.o.log?.(`composio: app events now post to ${url}${current ? ` (was ${current.webhookUrl})` : ""}`);
  }

  /** Check a delivery's signature and read it. Throws when it isn't Composio's. */
  async verify(body: string, headers: Record<string, string | string[] | undefined>): Promise<AppEvent> {
    const secret = this.o.state.readJson<{ secret?: string }>(WEBHOOK_STATE_FILE, {}).secret;
    if (!secret) throw new Error("no webhook secret yet");
    const id = header(headers, "webhook-id") ?? "";
    const r = await this.o.triggers.verifyWebhook({ id, payload: body, signature: header(headers, "webhook-signature") ?? "", timestamp: header(headers, "webhook-timestamp") ?? "", secret });
    const p = r.payload;
    return { id, instance: p.metadata.id, trigger: p.triggerSlug, account: p.metadata.connectedAccount.id, data: p.payload ?? {} };
  }
}
