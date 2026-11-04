/**
 * Link OAuth: PKCE helpers and the three login.link.com endpoints. Pure functions over an
 * injected fetch so the wallet can be tested without the network.
 * Reference: https://docs.stripe.com/agentic-commerce/agents/link-agent-wallet/oauth
 */
import { createHash, randomBytes } from "node:crypto";

export const LINK_AUTHORIZE_URL = "https://login.link.com/auth";
export const LINK_TOKEN_URL = "https://login.link.com/auth/token";
export const LINK_REVOKE_URL = "https://login.link.com/auth/revoke";
export const LINK_SCOPE = "payment_methods.agentic userinfo:read";

/** RFC 7636: the verifier is 43 to 128 characters from the unreserved set. */
export const VERIFIER_BYTES = 64;

export function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateVerifier(): string {
  return base64url(randomBytes(VERIFIER_BYTES));
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

/** S256 code challenge: BASE64URL(SHA256(ASCII(verifier))). */
export function challengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export interface AuthorizeParams {
  publishableKey: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * Build the authorize URL by hand so spaces encode as %20 and the scope reads exactly as the
 * Stripe docs show it. URLSearchParams would use "+" and escape the colon.
 */
export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const pairs: Array<[string, string]> = [
    ["key", p.publishableKey],
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["response_type", "code"],
    ["scope", LINK_SCOPE],
    ["state", p.state],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", "S256"],
  ];
  const query = pairs.map(([k, v]) => `${k}=${encodeQuery(v)}`).join("&");
  return `${LINK_AUTHORIZE_URL}?${query}`;
}

function encodeQuery(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":");
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  publishableKey: string;
  redirectUri: string;
  fetchImpl: typeof fetch;
}

export class LinkOAuthError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(operation: string, status: number, code: string | undefined, description: string | undefined) {
    super(`Link ${operation} failed (${status}${code ? ` ${code}` : ""})${description ? `: ${description}` : ""}`);
    this.name = "LinkOAuthError";
    this.status = status;
    this.code = code;
  }
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(client: OAuthClient, code: string, codeVerifier: string): Promise<TokenResponse> {
  return postToken(client, "token exchange", {
    grant_type: "authorization_code",
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    code,
    code_verifier: codeVerifier,
  });
}

/** Trade a refresh token for a new pair. Link rotates refresh tokens; persist the new one at once. */
export async function refreshTokens(client: OAuthClient, refreshToken: string): Promise<TokenResponse> {
  return postToken(client, "token refresh", {
    grant_type: "refresh_token",
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
  });
}

/** Revoke a refresh token. A 200 with any body counts as success. */
export async function revokeToken(client: OAuthClient, refreshToken: string): Promise<void> {
  const res = await postForm(client, LINK_REVOKE_URL, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    token: refreshToken,
    token_type_hint: "refresh_token",
  });
  if (!res.ok) {
    const body = await readJson(res);
    throw new LinkOAuthError("token revoke", res.status, str(body.error), str(body.error_description));
  }
}

async function postToken(client: OAuthClient, operation: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await postForm(client, LINK_TOKEN_URL, form);
  const body = await readJson(res);
  if (!res.ok) throw new LinkOAuthError(operation, res.status, str(body.error), str(body.error_description));
  const accessToken = str(body.access_token);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new LinkOAuthError(operation, res.status, "invalid_response", "missing access_token or expires_in");
  }
  const out: TokenResponse = { access_token: accessToken, expires_in: expiresIn };
  const refresh = str(body.refresh_token);
  if (refresh) out.refresh_token = refresh;
  const scope = str(body.scope);
  if (scope) out.scope = scope;
  return out;
}

async function postForm(client: OAuthClient, url: string, form: Record<string, string>): Promise<Response> {
  return client.fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${client.publishableKey}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
