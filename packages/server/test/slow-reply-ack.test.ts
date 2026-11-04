/**
 * The "on it" text for a slow owner reply, driven the way a real carrier text arrives:
 * an Inkbox envelope on /chat, admitted to the durable inbox, handled with
 * waitForCompletion. No /chat budget branch is involved.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { encodeEvent } from "@kloru/core";
import type { OutboundMessage, Outbox } from "@kloru/core";
import { boot } from "../src/boot.js";
import { closeInkboxInbox, createHttpServer } from "../src/http.js";

const OWNER_PHONE = "+15550001111";
const ACK = "On it. I will text you when it is done.";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { open, promise };
}

async function serve(extraEnv: NodeJS.ProcessEnv) {
  const dataDir = mkdtempSync(join(tmpdir(), "instinct-ack-"));
  const env: NodeJS.ProcessEnv = {
    INSTINCT_DATA_DIR: dataDir,
    INSTINCT_OWNER_NAME: "Ack Owner",
    INSTINCT_OWNER_PHONE: OWNER_PHONE,
    INSTINCT_OWNER_TIMEZONE: "America/New_York",
    INSTINCT_AGENT_NAME: "Ack",
    INSTINCT_MODEL: "faux/faux-1",
    INSTINCT_COMPUTER: "none",
    INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"),
    INSTINCT_REPLY_BUDGET_MS: "40",
    ...extraEnv,
  };
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const inner = models.streamSimple.bind(models) as unknown as StreamFn;
  // Model call i waits for holds[i], so each turn is "still running" until the test releases it.
  const holds = [gate(), gate(), gate()];
  let calls = 0;
  const streamFn = (async (...args: Parameters<StreamFn>) => {
    await holds[calls++]?.promise;
    return inner(...args);
  }) as unknown as StreamFn;
  const sent: OutboundMessage[] = [];
  const outbox: Outbox = { send: async (msg) => { sent.push(msg); }, typing: async () => undefined };
  const app = await boot(env, { model: faux.getModel("faux-1"), streamFn, outbox, logger: () => {} });
  const server = createHttpServer(app, { env, logger: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    for (const h of holds) h.open();
    await new Promise<void>((r) => server.close(() => r()));
    await closeInkboxInbox(app);
  });
  const text = async (id: string, content: string, extra: Record<string, unknown> = {}) => {
    const event = {
      id: `evt_${id}`,
      event_type: "imessage.received",
      timestamp: new Date().toISOString(),
      data: {
        message: { id, conversation_id: "conv_owner", remote_number: OWNER_PHONE, content, is_group: false, participants: [OWNER_PHONE], media: [], ...extra },
        contacts: [],
        agent_identities: [],
      },
    };
    const res = await fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: encodeEvent(event), source: "front_door" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { response: string }).response).toBe("");
  };
  return { faux, sent, release: (i: number) => holds[i]!.open(), text };
}

describe("slow reply ack over the carrier path", () => {
  it("texts one 'on it' while the owner's turn runs past the budget, then the answer", async () => {
    const s = await serve({ INSTINCT_ACK_SLOW_REPLIES: "1" });
    s.faux.setResponses([fauxAssistantMessage("Found three flights under $400."), fauxAssistantMessage("Booked the 9am one.")]);
    await s.text("m1", "find me flights to SF");
    await vi.waitFor(() => expect(s.sent.map((m) => m.text)).toEqual([ACK]), { timeout: 3000 });
    expect(s.sent[0]).toMatchObject({ channel: "imessage", conversationKey: "imessage:conv_owner" });

    // A second text while the first is still running waits behind it. Its own turn is slow
    // too, and it still gets no ack of its own.
    await s.text("m2", "book the cheapest");
    await new Promise((r) => setTimeout(r, 150));
    expect(s.sent.map((m) => m.text)).toEqual([ACK]);
    s.release(0);
    await vi.waitFor(() => expect(s.sent).toHaveLength(2), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 150));
    expect(s.sent.map((m) => m.text)).toEqual([ACK, "Found three flights under $400."]);

    s.release(1);
    await vi.waitFor(() => expect(s.sent).toHaveLength(3), { timeout: 3000 });
    expect(s.sent.map((m) => m.text)).toEqual([ACK, "Found three flights under $400.", "Booked the 9am one."]);
  });

  it("stays quiet until the answer when INSTINCT_ACK_SLOW_REPLIES is not set", async () => {
    const s = await serve({});
    s.faux.setResponses([fauxAssistantMessage("Here you go.")]);
    await s.text("m1", "slow question");
    await new Promise((r) => setTimeout(r, 150));
    expect(s.sent).toHaveLength(0);
    s.release(0);
    await vi.waitFor(() => expect(s.sent.map((m) => m.text)).toEqual(["Here you go."]), { timeout: 3000 });
  });
});
