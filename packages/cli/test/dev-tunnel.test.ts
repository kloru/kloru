import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateDir, defaultConfig } from "@kloru/core";
import { createHttpServer, listenTunnelServer } from "@kloru/server";
import type { HttpApp } from "@kloru/server";
import { computeInkboxSignature } from "@kloru/inkbox";
import { runDev } from "../src/commands/dev.js";
import { makeContext } from "../src/context.js";
import { tmpDir } from "./helpers.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

describe("dev tunnel boundary", () => {
  it("forwards only signed webhook routes, not the owner's chat, status or schedules", async () => {
    const dir = tmpDir();
    const incoming = vi.fn(async (msg) => ({ acked: true, conversationKey: msg.conversationKey, principal: { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: "Owner" } }));
    const app: HttpApp = { state: new StateDir(dir), config: defaultConfig(), scheduler: { toMaritimeSchedules: () => [] }, runtime: { handleInbound: incoming, stats: () => ({ conversations: 0, busy: 0 }) } };
    let target = "";
    const context = makeContext({ INSTINCT_DATA_DIR: dir, INKBOX_API_KEY: "test", INKBOX_AGENT_HANDLE: "test", INKBOX_SIGNING_KEY: "whsec_test" }, {
      stdout: () => {}, stderr: () => {}, installSignalHandlers: false,
      importServer: async () => ({
        boot: async () => app as never,
        createHttpServer: (a, opts) => { const s = createHttpServer(a as unknown as HttpApp, opts); servers.push(s); return s; },
        listenTunnelServer: async (a, opts) => { const s = await listenTunnelServer(a as unknown as HttpApp, opts); servers.push(s); return s; },
      }),
      connectTunnel: async (opts) => { target = opts.forwardTo; return { publicUrl: "https://agent.example.com", close: async () => {} }; },
    });
    await runDev(context, ["--port", "0", "--tunnel"]);
    expect(target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${target}/health`)).status).toBe(200);
    for (const path of ["/status", "/schedules"]) expect((await fetch(target + path)).status).toBe(404);
    expect((await fetch(`${target}/chat`, { method: "POST", body: JSON.stringify({ message: "hello" }) })).status).toBe(404);
    expect((await fetch(`${target}/webhooks/inkbox`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(incoming).not.toHaveBeenCalled();
    const body = JSON.stringify({ id: "event", event_type: "imessage.received", data: { message: { id: "message", conversation_id: "conversation", remote_number: "+12025550123", content: "hello", is_group: false } } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${target}/webhooks/inkbox`, { method: "POST", body, headers: { "x-inkbox-request-id": "r", "x-inkbox-timestamp": timestamp, "x-inkbox-signature": computeInkboxSignature(body, "r", timestamp, "whsec_test") } });
    expect(response.status).toBe(204);
    await vi.waitFor(() => expect(incoming).toHaveBeenCalledOnce());
  });
});
