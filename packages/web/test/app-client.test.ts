/**
 * window.kloru inside an app's frame, where it reaches the app's own server: the frame has no
 * cookies, so each call carries a token the page around it hands over.
 *
 * 2026-11-12: apps got a server side of their own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const CLIENT = readFileSync(fileURLToPath(new URL("../static/app-client.js", import.meta.url)), "utf8");
const APP = "Qm9vZ2xlR29vZ2xlR29vZ2";

/** The frame, with a shell that answers "token" and a network that records what it is asked. */
function frame(statuses: number[] = []) {
  const calls: Array<{ url: string; method: string; auth: string | null; type: string | null; body: unknown }> = [];
  const sockets: string[] = [];
  let tokens = 0;
  let onMessage: (e: unknown) => void = () => {};
  const shell = {
    postMessage(m: { id: number; op: string }) {
      if (m.op === "token") queueMicrotask(() => onMessage({ source: shell, data: { kloru: 1, id: m.id, ok: true, value: `token-${++tokens}` } }));
    },
  };
  const window = {
    parent: shell,
    name: "{}",
    location: new URL(`https://kloru.test/a/${APP}/app?k=x`),
    addEventListener: (type: string, fn: (e: unknown) => void) => void (type === "message" && (onMessage = fn)),
    fetch: async (url: string, init: { method?: string; headers: Headers; body?: unknown }) => {
      calls.push({ url, method: init.method ?? "GET", auth: init.headers.get("authorization"), type: init.headers.get("content-type"), body: init.body ?? null });
      return { status: statuses.shift() ?? 200 };
    },
    WebSocket: class {
      constructor(url: string) {
        sockets.push(url);
      }
    },
    kloru: undefined as unknown as { fetch(path: string, init?: object): Promise<{ status: number }>; url(path: string): string; link(path: string): Promise<string>; socket(path: string): Promise<unknown> },
  };
  vm.runInNewContext(CLIENT, { window, location: window.location, fetch: window.fetch, WebSocket: window.WebSocket, Headers, URL, queueMicrotask });
  return { kloru: window.kloru, calls, sockets, tokens: () => tokens };
}

describe("an app's page reaches its own server (2026-11-12)", () => {
  it("kloru.fetch calls /a/<id>/api with the token its shell hands it, asked for once", async () => {
    const f = frame();
    await f.kloru.fetch("/routes?near=3");
    await f.kloru.fetch("routes", { method: "POST", body: { name: "Home" } });
    expect(f.calls).toEqual([
      { url: `https://kloru.test/a/${APP}/api/routes?near=3`, method: "GET", auth: "Bearer token-1", type: null, body: null },
      { url: `https://kloru.test/a/${APP}/api/routes`, method: "POST", auth: "Bearer token-1", type: "application/json", body: `{"name":"Home"}` },
    ]);
    expect(f.tokens()).toBe(1);
  });

  it("a refused token is replaced and the call made once more", async () => {
    const f = frame([401, 200]);
    expect((await f.kloru.fetch("/routes")).status).toBe(200);
    expect(f.calls.map((c) => c.auth)).toEqual(["Bearer token-1", "Bearer token-2"]);
    const g = frame([401, 401]);
    expect((await g.kloru.fetch("/routes")).status).toBe(401);
    expect(g.calls).toHaveLength(2);
  });

  it("an address for an image or a stream carries the token; a socket opens on wss", async () => {
    const f = frame();
    expect(f.kloru.url("/public/logo.svg")).toBe(`https://kloru.test/a/${APP}/api/public/logo.svg`);
    expect(await f.kloru.link("/tiles/3.png?z=2")).toBe(`https://kloru.test/a/${APP}/api/tiles/3.png?z=2&kloru_token=token-1`);
    await f.kloru.socket("/live");
    expect(f.sockets).toEqual([`wss://kloru.test/a/${APP}/api/live?kloru_token=token-1`]);
  });
});
