import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LINK_REVOKE_URL, LINK_TOKEN_URL, challengeS256 } from "../src/oauth.js";
import { LinkWallet, OAUTH_FILE, PENDING_TTL_MS, REFRESH_AHEAD_MS, TOKENS_FILE, writeSecret, type PendingAuthorization, type StoredTokens } from "../src/wallet.js";
import type { LinkClientLike, LinkClientOptions } from "../src/link-types.js";
import { NOW, TOKEN_BODY, fakeFetch, fileMode, json, tempState, walletOpts, type TestState } from "./helpers.js";

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** Seed a connected wallet whose access token expires `expiresInMs` after NOW. */
function seedTokens(state: TestState, expiresInMs: number, extra: Partial<StoredTokens> = {}): string {
  const file = state.path(...TOKENS_FILE);
  writeSecret(file, {
    accessToken: "at_old",
    refreshToken: "rt_old",
    expiresAt: new Date(NOW.getTime() + expiresInMs).toISOString(),
    obtainedAt: NOW.toISOString(),
    ...extra,
  } satisfies StoredTokens);
  return file;
}

describe("LinkWallet constructor", () => {
  it("refuses empty credentials", () => {
    const state = tempState();
    expect(() => new LinkWallet(walletOpts(state, { clientId: "" }))).toThrow(/clientId/);
    expect(() => new LinkWallet(walletOpts(state, { publishableKey: "  " }))).toThrow(/publishableKey/);
  });
});

describe("LinkWallet.authorizeUrl", () => {
  it("stores the verifier and state in a 0600 file and puts the matching challenge in the URL", () => {
    const state = tempState();
    const wallet = new LinkWallet(walletOpts(state));
    const { url, state: returnedState } = wallet.authorizeUrl();

    const file = state.path(...OAUTH_FILE);
    expect(file).toBe(path.join(state.root, "secrets", "link-oauth.json"));
    expect(fileMode(file)).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);

    const pending = readJson<PendingAuthorization>(file);
    expect(pending.state).toBe(returnedState);
    expect(pending.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pending.createdAt).toBe(NOW.toISOString());

    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://login.link.com/auth");
    expect(u.searchParams.get("state")).toBe(returnedState);
    expect(u.searchParams.get("code_challenge")).toBe(challengeS256(pending.verifier));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("key")).toBe("pk_test_789");
    expect(u.searchParams.get("client_id")).toBe("client_123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://agent.example/oauth/link/callback");
    expect(url).not.toContain(pending.verifier);
    expect(url).not.toContain("secret_456");
  });

  it("replaces an older pending flow", () => {
    const state = tempState();
    const wallet = new LinkWallet(walletOpts(state));
    const first = wallet.authorizeUrl();
    const second = wallet.authorizeUrl();
    expect(second.state).not.toBe(first.state);
    expect(readJson<PendingAuthorization>(state.path(...OAUTH_FILE)).state).toBe(second.state);
  });
});

describe("LinkWallet.handleCallback", () => {
  it("rejects when nothing is pending", async () => {
    const fetchImpl = fakeFetch(() => json(TOKEN_BODY));
    const wallet = new LinkWallet(walletOpts(tempState(), { fetchImpl }));
    await expect(wallet.handleCallback("code", "state")).rejects.toThrow(/No Link authorization is pending/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("rejects a state mismatch without calling Link and keeps the pending flow", async () => {
    const state = tempState();
    const fetchImpl = fakeFetch(() => json(TOKEN_BODY));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    const { state: good } = wallet.authorizeUrl();
    await expect(wallet.handleCallback("code", good + "x")).rejects.toThrow(/state mismatch/);
    await expect(wallet.handleCallback("code", "")).rejects.toThrow(/state mismatch/);
    expect(fetchImpl.calls).toHaveLength(0);
    expect(wallet.isConnected()).toBe(false);
    expect(fs.existsSync(state.path(...OAUTH_FILE))).toBe(true);
  });

  it("rejects a pending flow older than ten minutes and removes it", async () => {
    const state = tempState();
    const fetchImpl = fakeFetch(() => json(TOKEN_BODY));
    let now = NOW;
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl, now: () => now }));
    const { state: s } = wallet.authorizeUrl();
    now = new Date(NOW.getTime() + PENDING_TTL_MS + 1000);
    await expect(wallet.handleCallback("code", s)).rejects.toThrow(/expired/);
    expect(fetchImpl.calls).toHaveLength(0);
    expect(fs.existsSync(state.path(...OAUTH_FILE))).toBe(false);
  });

  it("exchanges the code with the stored verifier and persists tokens at 0600", async () => {
    const state = tempState();
    const fetchImpl = fakeFetch(() => json(TOKEN_BODY));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    const { state: s } = wallet.authorizeUrl();
    const { verifier } = readJson<PendingAuthorization>(state.path(...OAUTH_FILE));

    await wallet.handleCallback("code_abc", s);

    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe(LINK_TOKEN_URL);
    expect(call.headers.authorization).toBe("Bearer pk_test_789");
    expect(Object.fromEntries(call.form)).toEqual({
      grant_type: "authorization_code",
      client_id: "client_123",
      client_secret: "secret_456",
      redirect_uri: "https://agent.example/oauth/link/callback",
      code: "code_abc",
      code_verifier: verifier,
    });

    const file = state.path(...TOKENS_FILE);
    expect(fileMode(file)).toBe(0o600);
    const tokens = readJson<StoredTokens>(file);
    expect(tokens).toEqual({
      accessToken: "at_1",
      refreshToken: "rt_1",
      expiresAt: new Date(NOW.getTime() + 3600 * 1000).toISOString(),
      obtainedAt: NOW.toISOString(),
      scope: TOKEN_BODY.scope,
    });
    expect(fs.existsSync(state.path(...OAUTH_FILE))).toBe(false);
    expect(wallet.isConnected()).toBe(true);
  });

  it("does not store anything when the exchange fails", async () => {
    const state = tempState();
    const fetchImpl = fakeFetch(() => json({ error: "invalid_grant" }, 400));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    const { state: s } = wallet.authorizeUrl();
    await expect(wallet.handleCallback("code", s)).rejects.toThrow(/invalid_grant/);
    expect(wallet.isConnected()).toBe(false);
  });
});

describe("LinkWallet.isConnected", () => {
  it("is false for a missing, torn or incomplete token file", () => {
    const state = tempState();
    const wallet = new LinkWallet(walletOpts(state));
    expect(wallet.isConnected()).toBe(false);
    const file = state.path(...TOKENS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(wallet.isConnected()).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ accessToken: "at" }));
    expect(wallet.isConnected()).toBe(false);
  });
});

describe("LinkWallet.getAccessToken", () => {
  it("returns the stored token without a network call while it has more than five minutes left", async () => {
    const state = tempState();
    seedTokens(state, REFRESH_AHEAD_MS + 60_000);
    const fetchImpl = fakeFetch(() => json(TOKEN_BODY));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    expect(await wallet.getAccessToken()).toBe("at_old");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("refreshes ahead of expiry and persists the rotated refresh token", async () => {
    const state = tempState();
    seedTokens(state, REFRESH_AHEAD_MS - 1000);
    const fetchImpl = fakeFetch(() => json({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));

    expect(await wallet.getAccessToken()).toBe("at_new");
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.url).toBe(LINK_TOKEN_URL);
    expect(Object.fromEntries(fetchImpl.calls[0]!.form)).toEqual({ grant_type: "refresh_token", client_id: "client_123", client_secret: "secret_456", refresh_token: "rt_old" });

    const stored = readJson<StoredTokens>(state.path(...TOKENS_FILE));
    expect(stored.accessToken).toBe("at_new");
    expect(stored.refreshToken).toBe("rt_new");
    expect(stored.expiresAt).toBe(new Date(NOW.getTime() + 3600 * 1000).toISOString());
    expect(fileMode(state.path(...TOKENS_FILE))).toBe(0o600);

    // The new token is fresh, so the next call is served from disk.
    expect(await wallet.getAccessToken()).toBe("at_new");
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("uses the fake clock: the same token flips from fresh to stale as time passes", async () => {
    const state = tempState();
    seedTokens(state, 3600_000);
    let now = NOW;
    const fetchImpl = fakeFetch(() => json({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl, now: () => now }));
    expect(await wallet.getAccessToken()).toBe("at_old");
    now = new Date(NOW.getTime() + 3600_000 - REFRESH_AHEAD_MS + 1);
    expect(await wallet.getAccessToken()).toBe("at_new");
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("refreshes on forceRefresh even when the token looks fresh", async () => {
    const state = tempState();
    seedTokens(state, 3600_000);
    const fetchImpl = fakeFetch(() => json({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    expect(await wallet.getAccessToken({ forceRefresh: true })).toBe("at_new");
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("coalesces concurrent refreshes into one request", async () => {
    const state = tempState();
    seedTokens(state, 0);
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = fakeFetch(() => gate);
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));

    const pending = [wallet.getAccessToken(), wallet.getAccessToken({ forceRefresh: true }), wallet.getAccessToken()];
    await Promise.resolve();
    expect(fetchImpl.calls).toHaveLength(1);
    release(json({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }));
    expect(await Promise.all(pending)).toEqual(["at_new", "at_new", "at_new"]);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(readJson<StoredTokens>(state.path(...TOKENS_FILE)).refreshToken).toBe("rt_new");
  });

  it("keeps the old refresh token when the server does not rotate it", async () => {
    const state = tempState();
    seedTokens(state, 0);
    const fetchImpl = fakeFetch(() => json({ access_token: "at_new", expires_in: 3600 }));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    expect(await wallet.getAccessToken()).toBe("at_new");
    expect(readJson<StoredTokens>(state.path(...TOKENS_FILE)).refreshToken).toBe("rt_old");
  });

  it("forgets the tokens when Link rejects the refresh token", async () => {
    const state = tempState();
    seedTokens(state, 0);
    const fetchImpl = fakeFetch(() => json({ error: "invalid_grant", error_description: "revoked" }, 400));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    await expect(wallet.getAccessToken()).rejects.toThrow(/payment_connect/);
    expect(wallet.isConnected()).toBe(false);
    expect(fs.existsSync(state.path(...TOKENS_FILE))).toBe(false);
  });

  it("keeps the tokens on a transient server error", async () => {
    const state = tempState();
    seedTokens(state, 0);
    const fetchImpl = fakeFetch(() => json({ error: "server_error" }, 503));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    await expect(wallet.getAccessToken()).rejects.toThrow(/503/);
    expect(wallet.isConnected()).toBe(true);
  });

  it("throws a clear error when the wallet is not connected", async () => {
    const wallet = new LinkWallet(walletOpts(tempState(), { fetchImpl: fakeFetch(() => json({})) }));
    await expect(wallet.getAccessToken()).rejects.toThrow(/not connected/);
  });
});

describe("LinkWallet.client", () => {
  it("builds one Link client through the factory with a working token provider and the injected fetch", async () => {
    const state = tempState();
    seedTokens(state, 3600_000);
    const fetchImpl = fakeFetch(() => json({}));
    const seen: LinkClientOptions[] = [];
    const stub = {} as LinkClientLike;
    const wallet = new LinkWallet(
      walletOpts(state, {
        fetchImpl,
        linkFactory: (o) => {
          seen.push(o);
          return stub;
        },
      }),
    );
    expect(wallet.client()).toBe(stub);
    expect(wallet.client()).toBe(stub);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.fetch).toBe(fetchImpl);
    expect(await seen[0]!.getAccessToken()).toBe("at_old");
  });

  it("drops the cached client after a reconnect so no stale token provider lingers", async () => {
    const state = tempState();
    seedTokens(state, 3600_000);
    let n = 0;
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl: fakeFetch(() => json(TOKEN_BODY)), linkFactory: () => ({ n: ++n }) as unknown as LinkClientLike }));
    const before = wallet.client();
    const { state: s } = wallet.authorizeUrl();
    await wallet.handleCallback("code", s);
    expect(wallet.client()).not.toBe(before);
  });
});

describe("LinkWallet.revoke", () => {
  it("revokes the refresh token at Link and deletes the local file", async () => {
    const state = tempState();
    seedTokens(state, 3600_000);
    const fetchImpl = fakeFetch(() => json({}));
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl }));
    await wallet.revoke();
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.url).toBe(LINK_REVOKE_URL);
    expect(Object.fromEntries(fetchImpl.calls[0]!.form)).toMatchObject({ token: "rt_old", token_type_hint: "refresh_token" });
    expect(wallet.isConnected()).toBe(false);
    expect(fs.existsSync(state.path(...TOKENS_FILE))).toBe(false);
  });

  it("still forgets the tokens locally when Link is down, and reports the failure", async () => {
    const state = tempState();
    seedTokens(state, 3600_000);
    const wallet = new LinkWallet(walletOpts(state, { fetchImpl: fakeFetch(() => json({ error: "server_error" }, 500)) }));
    await expect(wallet.revoke()).rejects.toThrow(/revoke/);
    expect(wallet.isConnected()).toBe(false);
  });

  it("is a no-op without tokens", async () => {
    const fetchImpl = fakeFetch(() => json({}));
    const wallet = new LinkWallet(walletOpts(tempState(), { fetchImpl }));
    await wallet.revoke();
    expect(fetchImpl.calls).toHaveLength(0);
  });
});
