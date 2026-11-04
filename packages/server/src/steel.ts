/**
 * Steel (steel.dev): a person's browser runs as a Steel cloud session instead of Chromium on this
 * machine, so sites that refuse datacenter traffic (SFO parking's checkout, 2026-11-03) see a
 * residential proxy. Each person keeps a Steel profile, so their sign-ins carry over between
 * sessions. CAPTCHA solving stays off: a challenge is the person's to do (browser_takeover).
 *
 * Worker scripts attach through a relay on 127.0.0.1 that adds the API key on the way out, so the
 * key never reaches code a model wrote.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { chromium, type Browser, type BrowserContext } from "playwright-core";

const API = "https://api.steel.dev/v1";
const CONNECT_HOST = "connect.steel.dev";
/** Steel's Launch plan ends a session at 15 minutes; a new one picks up the profile. */
export const STEEL_SESSION_MS = 15 * 60_000;

export interface SteelBrowser {
  ctx: BrowserContext;
  /** A local ws:// address a script can attach to (no API key in it). */
  cdp: string;
  sessionId: string;
  close(): Promise<void>;
}

type Fetch = typeof fetch;

async function api(key: string, path: string, body?: unknown, f: Fetch = fetch): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await f(`${API}${path}`, { method: "POST", headers: { "steel-api-key": key, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/**
 * A Steel session for one person, with their profile (dir/steel.json keeps its id). A profile still
 * saving from the last session answers 409 for a few seconds; without a proxy deposit, it runs
 * without the residential proxy and says so.
 */
export async function openSteel(o: { apiKey: string; dir: string; log: (m: string) => void; fetchImpl?: Fetch }): Promise<SteelBrowser> {
  const file = join(o.dir, "steel.json");
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { profileId?: string }) : {};
  const base = { timeout: STEEL_SESSION_MS, solveCaptcha: false, persistProfile: true, dimensions: { width: 1280, height: 900 }, blockAds: true };
  let created: { status: number; json: Record<string, unknown> } | undefined;
  for (const withProxy of [true, false]) {
    for (let i = 0; i < 6; i++) {
      created = await api(o.apiKey, "/sessions", { ...base, ...(withProxy ? { useProxy: true } : {}), ...(saved.profileId ? { profileId: saved.profileId } : {}) }, o.fetchImpl);
      if (created.status !== 409) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (created!.status < 300) {
      if (!withProxy) o.log("browser: Steel session without the residential proxy (Steel needs a paid deposit for proxies)");
      break;
    }
    o.log(`browser: Steel session ${withProxy ? "with proxy " : ""}failed (${created!.status}): ${JSON.stringify(created!.json).slice(0, 200)}`);
  }
  if (!created || created.status >= 300) throw new Error(`Steel couldn't start a browser (${created?.status})`);
  const sessionId = String(created.json.id);
  if (typeof created.json.profileId === "string") writeFileSync(file, JSON.stringify({ profileId: created.json.profileId }), { mode: 0o600 });
  const browser: Browser = await chromium.connectOverCDP(`wss://${CONNECT_HOST}?apiKey=${encodeURIComponent(o.apiKey)}&sessionId=${encodeURIComponent(sessionId)}`);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const relay = await relayTo(o.apiKey, sessionId);
  return {
    ctx,
    cdp: relay.url,
    sessionId,
    close: async () => {
      relay.close();
      await browser.close().catch(() => undefined);
      // Releasing saves the profile; a session left running bills until its timeout.
      await api(o.apiKey, `/sessions/${sessionId}/release`, undefined, o.fetchImpl).catch(() => undefined);
    },
  };
}

/**
 * ws://127.0.0.1:<port> that forwards a WebSocket upgrade to Steel with the API key added, then
 * pipes the frames both ways untouched. Only this machine can reach it.
 */
export async function relayTo(apiKey: string, sessionId: string, host = CONNECT_HOST, port = 443): Promise<{ url: string; close(): void }> {
  const server = http.createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const up = tls.connect({ host, port, servername: host }, () => {
      const headers = [
        `GET /?apiKey=${encodeURIComponent(apiKey)}&sessionId=${encodeURIComponent(sessionId)} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"] ?? ""}`,
        `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] ?? "13"}`,
        ...(req.headers["sec-websocket-extensions"] ? [`Sec-WebSocket-Extensions: ${req.headers["sec-websocket-extensions"]}`] : []),
      ];
      up.write(`${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => (up.destroy(), socket.destroy());
    up.on("error", end);
    socket.on("error", end);
    socket.on("close", () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}
