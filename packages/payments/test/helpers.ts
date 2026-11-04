import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditEntry, AuditLog, InstinctConfig, Outbox, OutboundMessage, Principal, ToolContext, ToolResultLike } from "@kloru/core";
import type { LinkWalletOptions } from "../src/wallet.js";

/** A real directory with the StateDir methods this package uses. No runtime import from core. */
export interface TestState {
  root: string;
  path(...parts: string[]): string;
  readJson<T>(name: string, fallback: T): T;
  writeJson(name: string, value: unknown): void;
  exists(name: string): boolean;
}

export function tempState(): TestState {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instinct-payments-"));
  return {
    root,
    path: (...parts) => path.resolve(root, ...parts),
    readJson: <T>(name: string, fallback: T): T => {
      const file = path.join(root, name);
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    },
    writeJson: (name, value) => {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
    },
    exists: (name) => fs.existsSync(path.join(root, name)),
  };
}

export const NOW = new Date("2026-10-03T15:00:00Z");

export function testConfig(overrides: Partial<InstinctConfig["owner"]> = {}): InstinctConfig {
  return {
    version: 1,
    owner: { name: "Maria", phones: ["+16175550100"], emails: ["maria@example.com"], timezone: "America/New_York", ...overrides },
    agent: { name: "Kloru", handle: "maria-instinct" },
    model: { primary: "anthropic/claude-fable-5-1" },
    computer: { mode: "none" },
    apps: { enabled: false, toolkits: [] },
    features: { typingIndicators: false, tapbacks: false, journal: false },
  };
}

export const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
export const friend: Principal = { kind: "contact", id: "contact:alex-kim", tier: "friend", displayName: "Alex Kim", contactId: "alex-kim" };

export function ctxFor(principal: Principal, now: Date = NOW): ToolContext {
  return { principal, conversationKey: "imessage:t", channel: "imessage", now: () => now };
}

export function fakeOutbox(): { outbox: Outbox; sent: Array<{ msg: OutboundMessage; principal: Principal }> } {
  const sent: Array<{ msg: OutboundMessage; principal: Principal }> = [];
  return { sent, outbox: { send: async (msg, ctx) => void sent.push({ msg, principal: ctx.principal }) } };
}

export function fakeAudit(): { audit: Pick<AuditLog, "append">; entries: Array<Omit<AuditEntry, "at">> } {
  const entries: Array<Omit<AuditEntry, "at">> = [];
  return { entries, audit: { append: (e) => void entries.push(e) } };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: URLSearchParams;
}

export type FetchHandler = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch that records every call and answers through `handler`. */
export function fakeFetch(handler: FetchHandler): typeof fetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: RecordedCall = { url, method: init?.method ?? "GET", headers, form: new URLSearchParams(typeof init?.body === "string" ? init.body : "") };
    calls.push(call);
    return handler(call);
  }) as typeof fetch & { calls: RecordedCall[] };
  fn.calls = calls;
  return fn;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export const TOKEN_BODY = { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600, scope: "payment_methods.agentic userinfo:read", token_type: "Bearer" };

export function walletOpts(state: TestState, extra: Partial<LinkWalletOptions> = {}): LinkWalletOptions {
  return {
    state,
    clientId: "client_123",
    clientSecret: "secret_456",
    publishableKey: "pk_test_789",
    redirectUri: "https://agent.example/oauth/link/callback",
    now: () => NOW,
    ...extra,
  };
}

export function textOf(result: ToolResultLike): string {
  return typeof result === "string" ? result : result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

export function isError(result: ToolResultLike): boolean {
  return typeof result !== "string" && result.isError === true;
}

export function fileMode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}
