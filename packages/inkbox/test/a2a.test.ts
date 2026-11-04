import { describe, expect, it } from "vitest";
import { A2ARpcError, InkboxA2A, a2aParts, summarizeSendResult } from "../src/a2a.js";
import { fakeFetch, type Recorded } from "./fake-fetch.js";

const BASE = "https://inkbox.test";

function client(fake: ReturnType<typeof fakeFetch>) {
  return new InkboxA2A({ apiKey: "ik_identity", handle: "@maria-instinct", baseUrl: BASE, fetchImpl: fake.fetchImpl, sleep: async () => {} });
}

describe("InkboxA2A worker side", () => {
  it("replies to a task with text and data parts", async () => {
    const fake = fakeFetch({ "POST /api/v1/identities/maria-instinct/a2a/tasks/task_1/reply": { body: { id: "task_1", state: "working" } } });
    await client(fake).reply("task_1", "progress", "Checking with Maria.", { oip: "1", intent: "inform" });
    expect(fake.calls[0]?.body).toEqual({ intent: "progress", parts: [{ text: "Checking with Maria." }, { data: { oip: "1", intent: "inform" } }] });
    expect(fake.calls[0]?.headers["x-api-key"]).toBe("ik_identity");
  });

  it("lists the inbox with a state filter and unwraps items", async () => {
    const fake = fakeFetch({ "GET /api/v1/identities/maria-instinct/a2a/tasks": { body: { items: [{ id: "t1" }, { id: "t2" }], next_cursor: null } } });
    const tasks = await client(fake).listInbox("submitted");
    expect(tasks).toEqual([{ id: "t1" }, { id: "t2" }]);
    expect(fake.calls[0]?.query).toEqual({ state: "submitted" });
  });

  it("falls back to sent tasks when the inbox does not know the task", async () => {
    const fake = fakeFetch({
      "GET /api/v1/identities/maria-instinct/a2a/tasks/task_9": { status: 404 },
      "GET /api/v1/identities/maria-instinct/a2a/sent/tasks/task_9": { body: { id: "task_9", state: "completed" } },
    });
    expect(await client(fake).getTask("task_9")).toEqual({ id: "task_9", state: "completed" });
  });
});

describe("InkboxA2A caller side", () => {
  it("sends a JSON-RPC SendMessage to the peer with the right headers and parts", async () => {
    const fake = fakeFetch({
      "POST /a2a/sam-instinct": { body: { jsonrpc: "2.0", id: 1, result: { task: { id: "task_7", contextId: "ctx_7", status: { state: "TASK_STATE_SUBMITTED" } } } } },
    });
    const res = await client(fake).send("@sam-instinct", "Is Sam free Thursday?", { oip: "1", intent: "request_freebusy" }, { contextId: "ctx_7", messageId: "mid_1" });
    expect(res).toMatchObject({ taskId: "task_7", contextId: "ctx_7", state: "TASK_STATE_SUBMITTED" });
    const call = fake.calls[0] as Recorded;
    expect(call.url).toBe(`${BASE}/a2a/sam-instinct`);
    expect(call.headers["a2a-version"]).toBe("1.0");
    expect(call.headers["x-api-key"]).toBe("ik_identity");
    expect(call.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: { messageId: "mid_1", role: "ROLE_USER", parts: [{ text: "Is Sam free Thursday?" }, { data: { oip: "1", intent: "request_freebusy" } }], contextId: "ctx_7" },
        configuration: { returnImmediately: true },
      },
    });
  });

  it("generates a messageId and increments the rpc id", async () => {
    const fake = fakeFetch({ "POST /a2a/sam": { body: { result: { message: { messageId: "m", contextId: "c1", taskId: "t1" } } } } });
    const c = client(fake);
    const a = await c.send("sam", "one");
    const b = await c.send("sam", "two", undefined, { taskId: "t1" });
    expect(a).toMatchObject({ contextId: "c1", taskId: "t1" });
    expect(b.taskId).toBe("t1");
    const first = (fake.calls[0]?.body as { id: number; params: { message: { messageId: string } } });
    const second = (fake.calls[1]?.body as { id: number; params: { message: { taskId?: string } } });
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(first.params.message.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.params.message.taskId).toBe("t1");
  });

  it("throws A2ARpcError on a JSON-RPC error and InkboxHttpError on HTTP failure", async () => {
    const fake = fakeFetch({
      "POST /a2a/blocked": { body: { error: { code: -32003, message: "caller not allowed", data: { rule: "contact" } } } },
      "POST /a2a/down": { status: 503, body: { detail: "maintenance" } },
    });
    const c = client(fake);
    const err = await c.send("blocked", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(A2ARpcError);
    expect((err as A2ARpcError).code).toBe(-32003);
    expect((err as A2ARpcError).data).toEqual({ rule: "contact" });
    await expect(c.send("down", "hi")).rejects.toThrow(/503/);
    // A 503 is retried twice before it surfaces.
    expect(fake.calls.filter((r) => r.path === "/a2a/down")).toHaveLength(3);
  });

  it("fetches the peer card from the public route", async () => {
    const fake = fakeFetch({ "GET /a2a/sam-instinct/card": { body: { name: "Sam's Kloru", supportedInterfaces: [] } } });
    expect(await client(fake).fetchCard("sam-instinct")).toEqual({ name: "Sam's Kloru", supportedInterfaces: [] });
    expect(fake.calls[0]?.url).toBe(`${BASE}/a2a/sam-instinct/card`);
  });
});

describe("helpers", () => {
  it("a2aParts always yields at least one part", () => {
    expect(a2aParts("", undefined)).toEqual([{ text: "" }]);
    expect(a2aParts("", { a: 1 })).toEqual([{ data: { a: 1 } }]);
    expect(a2aParts("x")).toEqual([{ text: "x" }]);
  });

  it("summarizeSendResult handles task, message and bare task shapes", () => {
    expect(summarizeSendResult({ task: { id: "t", contextId: "c", status: { state: "TASK_STATE_WORKING" } } })).toMatchObject({ taskId: "t", contextId: "c", state: "TASK_STATE_WORKING" });
    expect(summarizeSendResult({ message: { contextId: "c2" } })).toMatchObject({ contextId: "c2" });
    expect(summarizeSendResult({ id: "t3", contextId: "c3", status: { state: "TASK_STATE_COMPLETED" } })).toMatchObject({ taskId: "t3", state: "TASK_STATE_COMPLETED" });
    expect(summarizeSendResult(undefined)).toEqual({ raw: undefined });
  });
});
