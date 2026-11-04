import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEvent, loadConfig, StateDir } from "@kloru/core";
import { expect, it } from "vitest";
import { closeInkboxInbox, createHttpServer, handleChat, type HttpApp } from "../src/http.js";

it("waits for admitted work before allowing the same app's inbox to reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-close-"));
  const state = new StateDir(dir);
  let release!: () => void;
  let began!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { began = resolve; });
  const app: HttpApp = {
    state,
    config: loadConfig(state, { INSTINCT_OWNER_NAME: "Test" }),
    startedAt: Date.now(),
    modelSpec: "test/model",
    scheduler: { toMaritimeSchedules: () => [] },
    runtime: {
      stats: () => ({ conversations: 0, busy: 0 }),
      handleInbound: async (message) => {
        began();
        await gate;
        return { acked: true, conversationKey: message.conversationKey, principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Test" } };
      },
    },
  };
  const server = createHttpServer(app, { env: {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await handleChat(app, { message: encodeEvent({
      id: "event", event_type: "imessage.received", timestamp: new Date().toISOString(),
      data: { message: { id: "message", conversation_id: "conversation", remote_number: "+12025550123", content: "Hello", media: [], participants: [], is_group: false } },
    }) });
    await started;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(() => createHttpServer(app, { env: {} })).toThrow("still closing");
    let closed = false;
    const closing = closeInkboxInbox(app).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    const saved = JSON.parse(readFileSync(state.path("inkbox-inbox.json"), "utf8"));
    expect(saved.receipts[0].status).toBe("done");
    expect(saved.receipts[0].payload).toBeUndefined();
    const reopened = createHttpServer(app, { env: {} });
    await new Promise<void>((resolve) => reopened.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => reopened.close(() => resolve()));
    await closeInkboxInbox(app);
  } finally {
    release();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeInkboxInbox(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
