import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateDir, defaultConfig, encodeEvent } from "@kloru/core";
import { createHttpServer, type HttpApp } from "../src/http.js";

const servers: ReturnType<typeof createHttpServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });
function stub() {
  const state = new StateDir(mkdtempSync(join(tmpdir(), "agent-inbox-")));
  const handler = vi.fn(async (msg) => ({ acked: true, conversationKey: msg.conversationKey, principal: { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: "Owner" } }));
  const app: HttpApp = { state, config: defaultConfig(), scheduler: { toMaritimeSchedules: () => [] }, runtime: { handleInbound: handler, stats: () => ({ conversations: 0, busy: 0 }) } };
  return { state, handler, app };
}
async function serve(app: HttpApp) {
  const server = createHttpServer(app, { env: {} });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const event = { id: "event", event_type: "imessage.received", data: { message: { id: "msg", conversation_id: "conversation", remote_number: "+12025550123", content: "hello" } } };

describe("agent inbox admission", () => {
  it("persists relayed events and retries hydration before starting a model turn", async () => {
    const { state, app, handler } = stub();
    app.hydrateInbound = async () => { throw new Error("conversation temporarily unavailable"); };
    const base = await serve(app);
    const res = await fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: encodeEvent(event) }) });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(state.path("inkbox-inbox.json"), "utf8")).receipts[0].attempts).toBe(1));
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(state.path("inkbox-inbox.json"), "utf8")).receipts[0].status).toBe("queued");
  });

  it("recovers queued events and hydrates them before runtime admission", async () => {
    const { state, app, handler } = stub();
    const inbound = { id: "event", channel: "imessage", conversationKey: "imessage:conversation", from: "+12025550123", text: "hello", replyRef: {}, receivedAt: new Date().toISOString() };
    writeFileSync(state.path("inkbox-inbox.json"), JSON.stringify({ version: 1, receipts: [{ id: "event", status: "queued", payload: inbound, attempts: 0, nextAttemptAt: 0 }] }));
    app.hydrateInbound = async (msg) => ({ ...msg, meta: { isGroup: true, participants: ["+12025550123"] } });
    await serve(app);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(expect.objectContaining({ meta: { isGroup: true, participants: ["+12025550123"] } }), { waitForCompletion: true }));
  });
});
