import { describe, expect, it } from "vitest";
import { decodeEvent, verifyOwnerEnvelope } from "@kloru/core";
import { AgentError, DirectAgentClient, clientFor } from "../src/agent-client.js";

const reply = (result: unknown, status = 200) => new Response(JSON.stringify({ response: JSON.stringify(result), acked: true, status }));

describe("DirectAgentClient", () => {
  it("posts a signed envelope with the bearer token and returns the result", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return reply({ a: 1 });
    }) as unknown as typeof fetch;
    const c = new DirectAgentClient({ url: "http://127.0.0.1:8080/", token: "tok", secret: "s", fetchImpl });
    expect(await c.call("policy.get")).toEqual({ a: 1 });
    expect(seen!.url).toBe("http://127.0.0.1:8080/chat");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(String(seen!.init.body)) as { message: string; source: string };
    expect(body.source).toBe("console");
    const check = verifyOwnerEnvelope("s", decodeEvent(body.message));
    expect(check.ok && check.env.op).toBe("policy.get");
  });

  it("raises AgentError with the agent's status and error text", async () => {
    const fetchImpl = (async () => reply({ error: "unknown tier" }, 400)) as unknown as typeof fetch;
    await expect(new DirectAgentClient({ url: "http://x", secret: "s", fetchImpl }).call("policy.setPermission")).rejects.toMatchObject({ status: 400, message: "unknown tier" });
  });

  it("maps HTTP failures and unreachable agents", async () => {
    const http401 = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(new DirectAgentClient({ url: "http://x", secret: "s", fetchImpl: http401 }).call("status.get")).rejects.toMatchObject({ status: 401 });
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const err = await new DirectAgentClient({ url: "http://x", secret: "s", fetchImpl: down }).call("status.get").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).status).toBe(0);
    const garbage = (async () => new Response(JSON.stringify({ response: "not json", acked: true }))) as unknown as typeof fetch;
    await expect(new DirectAgentClient({ url: "http://x", secret: "s", fetchImpl: garbage }).call("status.get")).rejects.toMatchObject({ status: 502 });
  });
});

describe("clientFor", () => {
  const user = { id: "u1", phone: "+14155550100", createdAt: "x" };
  it("builds a direct client from env-var names", () => {
    expect(clientFor({ ...user, agent: { kind: "direct", url: "http://x", tokenEnv: "TOK", secretEnv: "SEC" } }, { SEC: "s", TOK: "t" })).toBeInstanceOf(DirectAgentClient);
  });
  it("returns undefined without an agent, without its secret, or for maritime (not yet)", () => {
    expect(clientFor(user, {})).toBeUndefined();
    expect(clientFor({ ...user, agent: { kind: "direct", url: "http://x", tokenEnv: "TOK", secretEnv: "SEC" } }, {})).toBeUndefined();
    expect(clientFor({ ...user, agent: { kind: "maritime", agentId: "ag" } }, { SEC: "s" })).toBeUndefined();
  });
});
