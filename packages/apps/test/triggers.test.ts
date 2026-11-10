import { describe, expect, it } from "vitest";
import type { StateDir } from "@kloru/core";
import { ComposioTriggers, WEBHOOK_STATE_FILE, type ComposioTriggersLike } from "../src/triggers.js";

function fakeState(initial: Record<string, unknown> = {}): StateDir & { files: Record<string, unknown> } {
  const files: Record<string, unknown> = { ...initial };
  return {
    files,
    readJson: <T>(name: string, fallback: T): T => (name in files ? (files[name] as T) : fallback),
    writeJson: (name: string, value: unknown) => {
      files[name] = JSON.parse(JSON.stringify(value));
    },
  } as unknown as StateDir & { files: Record<string, unknown> };
}

function setup(o: { existing?: { id: string; webhookUrl: string; secret?: string } } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const triggers: ComposioTriggersLike = {
    getType: async (slug) => ({ slug, name: "New Gmail Message Trigger", description: "", config: {} }),
    create: async (userId, slug, body) => (calls.push(["create", userId, slug, body]), { triggerId: "ti_1" }),
    delete: async (id) => void calls.push(["delete", id]),
    listTypes: async (q) => ({ items: q?.toolkits?.[0] === "gmail" ? [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail Message", description: "A new email.", config: {} }] : [] }),
    setWebhookSubscription: async (p) => (calls.push(["subscribe", p.webhookUrl]), { id: "whs_1", webhookUrl: p.webhookUrl, secret: "whsec_new" }),
    verifyWebhook: async (p) => {
      calls.push(["verify", p.id, p.secret, p.signature, p.timestamp]);
      if (p.signature !== "v1,good") throw new Error("signature mismatch");
      return { payload: { triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE", payload: { subject: "Dinner?" }, metadata: { id: "ti_1", connectedAccount: { id: "ca_1" } } } };
    },
  };
  const state = fakeState();
  const t = new ComposioTriggers({
    triggers,
    subscriptions: { list: async () => ({ items: o.existing ? [o.existing] : [] }) },
    userId: "ezra-kloru",
    state,
    accountId: (_slug, account) => (account === "ezra@example.com" ? "ca_1" : undefined),
  });
  return { t, calls, state };
}

describe("ComposioTriggers", () => {
  it("watches an event of a connected account by its address, with its settings, and names it", async () => {
    const { t, calls } = setup();
    expect(await t.watch("gmail_new_gmail_message", "ezra@example.com", { labelIds: "INBOX" })).toEqual({ instance: "ti_1", label: "New Gmail Message" });
    expect(calls).toContainEqual(["create", "ezra-kloru", "GMAIL_NEW_GMAIL_MESSAGE", { connectedAccountId: "ca_1", triggerConfig: { labelIds: "INBOX" } }]);
  });

  it("won't watch an account that isn't connected", async () => {
    await expect(setup().t.watch("GMAIL_NEW_GMAIL_MESSAGE", "someone@example.com")).rejects.toThrow(/no connected account/);
  });

  it("points the project's webhook here and keeps its secret; one already here isn't touched", async () => {
    const moved = setup({ existing: { id: "whs_1", webhookUrl: "https://old.example/webhooks/composio", secret: "whsec_old" } });
    await moved.t.subscribe("https://kloru.example/webhooks/composio");
    expect(moved.calls).toContainEqual(["subscribe", "https://kloru.example/webhooks/composio"]);
    expect(moved.state.files[WEBHOOK_STATE_FILE]).toEqual({ url: "https://kloru.example/webhooks/composio", secret: "whsec_new" });

    const same = setup({ existing: { id: "whs_1", webhookUrl: "https://kloru.example/webhooks/composio", secret: "whsec_same" } });
    await same.t.subscribe("https://kloru.example/webhooks/composio");
    expect(same.calls.filter((c) => c[0] === "subscribe")).toEqual([]);
    expect(same.state.files[WEBHOOK_STATE_FILE]).toMatchObject({ secret: "whsec_same" });
  });

  it("reads a delivery only when its signature checks out with the saved secret", async () => {
    const { t, state } = setup();
    const h = { "webhook-id": "msg_1", "webhook-timestamp": "1762600000", "webhook-signature": "v1,good" };
    await expect(t.verify("{}", h)).rejects.toThrow(/no webhook secret/);
    state.writeJson(WEBHOOK_STATE_FILE, { url: "x", secret: "whsec_new" });
    expect(await t.verify("{}", h)).toEqual({ id: "msg_1", instance: "ti_1", trigger: "GMAIL_NEW_GMAIL_MESSAGE", account: "ca_1", data: { subject: "Dinner?" } });
    await expect(t.verify("{}", { ...h, "webhook-signature": "v1,forged" })).rejects.toThrow(/signature/);
  });
});

describe("ComposioTriggers with the real SDK's signature check", () => {
  it("reads a V3 delivery signed with the project's secret: which trigger, which account, the event", async () => {
    const { Composio } = await import("@composio/core");
    const { createHmac } = await import("node:crypto");
    const sdk = new Composio({ apiKey: "test-key" });
    const state = fakeState({ [WEBHOOK_STATE_FILE]: { url: "x", secret: "whsec_test" } });
    const t = new ComposioTriggers({ triggers: sdk.triggers as unknown as ComposioTriggersLike, userId: "ezra-kloru", state, accountId: () => undefined });
    const body = JSON.stringify({
      id: "evt_1",
      timestamp: "2026-11-08T16:00:00Z",
      type: "composio.trigger.message",
      metadata: { log_id: "log_1", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", trigger_id: "ti_mail", connected_account_id: "ca_1", auth_config_id: "ac_1", user_id: "ezra-kloru" },
      data: { subject: "Dinner?", sender: "cleo@example.com" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", "whsec_test").update(`msg_1.${ts}.${body}`).digest("base64");
    const headers = { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` };
    expect(await t.verify(body, headers)).toEqual({ id: "msg_1", instance: "ti_mail", trigger: "GMAIL_NEW_GMAIL_MESSAGE", account: "ca_1", data: { subject: "Dinner?", sender: "cleo@example.com" } });
    await expect(t.verify(body.replace("Dinner", "Lunch"), headers)).rejects.toThrow();
  });
});
