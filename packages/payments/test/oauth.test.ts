import { describe, expect, it } from "vitest";
import {
  LINK_AUTHORIZE_URL,
  LINK_REVOKE_URL,
  LINK_SCOPE,
  LINK_TOKEN_URL,
  LinkOAuthError,
  buildAuthorizeUrl,
  challengeS256,
  exchangeCode,
  generateState,
  generateVerifier,
  refreshTokens,
  revokeToken,
  type OAuthClient,
} from "../src/oauth.js";
import { TOKEN_BODY, fakeFetch, json } from "./helpers.js";

const UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

describe("PKCE helpers", () => {
  it("makes a verifier inside the RFC 7636 length and alphabet", () => {
    const v = generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(UNRESERVED);
    expect(v).not.toContain("=");
  });

  it("makes different verifiers and states each time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      seen.add(generateVerifier());
      seen.add(generateState());
    }
    expect(seen.size).toBe(40);
    expect(generateState()).toMatch(UNRESERVED);
  });

  it("computes the S256 challenge from the RFC 7636 appendix B example", () => {
    expect(challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("is deterministic and sensitive to the verifier", () => {
    const a = generateVerifier();
    expect(challengeS256(a)).toBe(challengeS256(a));
    expect(challengeS256(a)).not.toBe(challengeS256(a + "x"));
  });
});

describe("buildAuthorizeUrl", () => {
  const url = buildAuthorizeUrl({
    publishableKey: "pk_test_1",
    clientId: "cid",
    redirectUri: "https://agent.example/cb?x=1",
    state: "st-ate",
    codeChallenge: "ch_allenge",
  });

  it("targets login.link.com/auth with every documented parameter", () => {
    expect(url.startsWith(`${LINK_AUTHORIZE_URL}?`)).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get("key")).toBe("pk_test_1");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://agent.example/cb?x=1");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe(LINK_SCOPE);
    expect(u.searchParams.get("state")).toBe("st-ate");
    expect(u.searchParams.get("code_challenge")).toBe("ch_allenge");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("encodes the scope with %20 and a literal colon, as the Stripe docs show", () => {
    expect(url).toContain("scope=payment_methods.agentic%20userinfo:read");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fagent.example%2Fcb%3Fx%3D1".replace("https%3A", "https:"));
  });
});

function client(fetchImpl: typeof fetch): OAuthClient {
  return { clientId: "cid", clientSecret: "csec", publishableKey: "pk_test_1", redirectUri: "https://agent.example/cb", fetchImpl };
}

describe("exchangeCode", () => {
  it("posts the form with the publishable key as bearer and parses the tokens", async () => {
    const fetchImpl = fakeFetch(() => json(TOKEN_BODY));
    const res = await exchangeCode(client(fetchImpl), "code_1", "verifier_1");
    expect(res).toEqual({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600, scope: TOKEN_BODY.scope });
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe(LINK_TOKEN_URL);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer pk_test_1");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(call.form)).toEqual({
      grant_type: "authorization_code",
      client_id: "cid",
      client_secret: "csec",
      redirect_uri: "https://agent.example/cb",
      code: "code_1",
      code_verifier: "verifier_1",
    });
  });

  it("throws a LinkOAuthError carrying the server's error code", async () => {
    const fetchImpl = fakeFetch(() => json({ error: "invalid_grant", error_description: "code expired" }, 400));
    const err = await exchangeCode(client(fetchImpl), "c", "v").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkOAuthError);
    expect((err as LinkOAuthError).code).toBe("invalid_grant");
    expect((err as LinkOAuthError).status).toBe(400);
    expect((err as Error).message).toContain("code expired");
  });

  it("rejects a 200 without an access token", async () => {
    const fetchImpl = fakeFetch(() => json({ token_type: "Bearer" }));
    await expect(exchangeCode(client(fetchImpl), "c", "v")).rejects.toThrow(/access_token/);
  });

  it("survives a non-JSON error body", async () => {
    const fetchImpl = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await exchangeCode(client(fetchImpl), "c", "v").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkOAuthError);
    expect((err as LinkOAuthError).status).toBe(502);
  });
});

describe("refreshTokens", () => {
  it("posts grant_type=refresh_token with the client credentials", async () => {
    const fetchImpl = fakeFetch(() => json({ ...TOKEN_BODY, access_token: "at_2", refresh_token: "rt_2" }));
    const res = await refreshTokens(client(fetchImpl), "rt_1");
    expect(res.access_token).toBe("at_2");
    expect(res.refresh_token).toBe("rt_2");
    expect(Object.fromEntries(fetchImpl.calls[0]!.form)).toEqual({ grant_type: "refresh_token", client_id: "cid", client_secret: "csec", refresh_token: "rt_1" });
    expect(fetchImpl.calls[0]!.url).toBe(LINK_TOKEN_URL);
  });

  it("keeps refresh_token optional when the server omits it", async () => {
    const fetchImpl = fakeFetch(() => json({ access_token: "at_2", expires_in: 1800 }));
    expect(await refreshTokens(client(fetchImpl), "rt_1")).toEqual({ access_token: "at_2", expires_in: 1800 });
  });
});

describe("revokeToken", () => {
  it("posts the refresh token with a type hint", async () => {
    const fetchImpl = fakeFetch(() => json({}));
    await revokeToken(client(fetchImpl), "rt_1");
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe(LINK_REVOKE_URL);
    expect(call.headers.authorization).toBe("Bearer pk_test_1");
    expect(Object.fromEntries(call.form)).toEqual({ client_id: "cid", client_secret: "csec", token: "rt_1", token_type_hint: "refresh_token" });
  });

  it("throws on a non-2xx answer", async () => {
    const fetchImpl = fakeFetch(() => json({ error: "server_error" }, 500));
    await expect(revokeToken(client(fetchImpl), "rt_1")).rejects.toBeInstanceOf(LinkOAuthError);
  });
});
