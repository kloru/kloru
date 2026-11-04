/**
 * LinkWallet: the agent's connection to the owner's Stripe Link Agent Wallet.
 *
 * It owns the OAuth dance (PKCE authorize URL, code exchange, refresh, revoke) and the two
 * secret files under <state>/secrets. The Link SDK itself never sees a refresh token; it asks
 * this class for an access token before each request and once more with `forceRefresh` after
 * a 401. Nothing here reads process.env. The server passes the client credentials in.
 */
import fs from "node:fs";
import path from "node:path";
import Link from "@stripe/link-sdk";
import type { StateDir } from "@kloru/core";
import {
  LinkOAuthError,
  buildAuthorizeUrl,
  challengeS256,
  exchangeCode,
  generateState,
  generateVerifier,
  refreshTokens,
  revokeToken,
  type OAuthClient,
  type TokenResponse,
} from "./oauth.js";
import type { LinkClientLike, LinkClientOptions } from "./link-types.js";

export const OAUTH_FILE = ["secrets", "link-oauth.json"] as const;
export const TOKENS_FILE = ["secrets", "link-tokens.json"] as const;

/** Refresh this long before the access token expires so a request never races the deadline. */
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** Link authorization codes expire after 10 minutes; a pending flow older than that is dead. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** The slice of StateDir the wallet uses. Tests pass a temp dir wrapper. */
export type WalletState = Pick<StateDir, "path">;

export interface LinkWalletOptions {
  state: WalletState;
  clientId: string;
  clientSecret: string;
  publishableKey: string;
  redirectUri: string;
  /**
   * Prefixed to the OAuth state (`<prefix>.<random>`). A gateway that fronts many agents with one
   * registered redirect URI reads the prefix (the agent's handle) to route the callback.
   */
  statePrefix?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Builds the Link client. Tests inject a stub; production uses `new Link(options)`. */
  linkFactory?: (options: LinkClientOptions) => LinkClientLike;
}

export interface PendingAuthorization {
  state: string;
  verifier: string;
  createdAt: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the access token stops working. */
  expiresAt: string;
  scope?: string;
  obtainedAt: string;
}

export class LinkWallet {
  private readonly state: WalletState;
  private readonly oauth: OAuthClient;
  private readonly statePrefix: string;
  private readonly now: () => Date;
  private readonly linkFactory: (options: LinkClientOptions) => LinkClientLike;
  private readonly fetchImpl: typeof fetch | undefined;
  private cachedClient: LinkClientLike | undefined;
  private refreshing: Promise<string> | undefined;

  constructor(opts: LinkWalletOptions) {
    for (const key of ["clientId", "clientSecret", "publishableKey", "redirectUri"] as const) {
      if (!opts[key] || !opts[key].trim()) throw new Error(`LinkWallet: ${key} is required`);
    }
    this.state = opts.state;
    this.fetchImpl = opts.fetchImpl;
    this.oauth = {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      publishableKey: opts.publishableKey,
      redirectUri: opts.redirectUri,
      fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    };
    this.now = opts.now ?? (() => new Date());
    this.statePrefix = opts.statePrefix ? `${opts.statePrefix.replace(/[^A-Za-z0-9_-]/g, "")}.` : "";
    this.linkFactory = opts.linkFactory ?? defaultLinkFactory;
  }

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  /** Start a connect flow. Writes the verifier and state to secrets/link-oauth.json (0600). */
  authorizeUrl(): { url: string; state: string } {
    const verifier = generateVerifier();
    const state = `${this.statePrefix}${generateState()}`;
    const pending: PendingAuthorization = { state, verifier, createdAt: this.now().toISOString() };
    writeSecret(this.pendingPath(), pending);
    const url = buildAuthorizeUrl({
      publishableKey: this.oauth.publishableKey,
      clientId: this.oauth.clientId,
      redirectUri: this.oauth.redirectUri,
      state,
      codeChallenge: challengeS256(verifier),
    });
    return { url, state };
  }

  /** Finish the connect flow with the code and state from the redirect. */
  async handleCallback(code: string, state: string): Promise<void> {
    const pending = readSecret<PendingAuthorization>(this.pendingPath());
    if (!pending) throw new Error("No Link authorization is pending. Start again with payment_connect.");
    if (!state || pending.state !== state) throw new Error("Link OAuth state mismatch. Start again with payment_connect.");
    const age = this.now().getTime() - Date.parse(pending.createdAt);
    if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
      removeFile(this.pendingPath());
      throw new Error("The Link authorization expired. Start again with payment_connect.");
    }
    if (!code) throw new Error("Link OAuth callback had no code.");
    const tokens = await exchangeCode(this.oauth, code, pending.verifier);
    this.storeTokens(tokens, undefined);
    removeFile(this.pendingPath());
    this.cachedClient = undefined;
  }

  isConnected(): boolean {
    return this.readTokens() !== undefined;
  }

  /** Revoke the refresh token at Link and forget it locally. Local state is cleared even if Link is down. */
  async revoke(): Promise<void> {
    const tokens = this.readTokens();
    try {
      if (tokens) await revokeToken(this.oauth, tokens.refreshToken);
    } finally {
      this.clearTokens();
    }
  }

  // ---------------------------------------------------------------------------
  // Link client
  // ---------------------------------------------------------------------------

  /** A Link client whose access token this wallet keeps fresh. Cached per wallet. At runtime this is a `Link` instance. */
  client(): LinkClientLike {
    if (!this.cachedClient) {
      const options: LinkClientOptions = {
        getAccessToken: (o) => this.getAccessToken(o),
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      };
      this.cachedClient = this.linkFactory(options);
    }
    return this.cachedClient;
  }

  /**
   * Access token for the SDK. Returns the stored token while it has more than REFRESH_AHEAD_MS
   * left, otherwise refreshes. Concurrent callers share one refresh.
   */
  async getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const tokens = this.readTokens();
    if (!tokens) throw new Error("Link wallet is not connected. The owner must run payment_connect.");
    const remaining = Date.parse(tokens.expiresAt) - this.now().getTime();
    if (!opts.forceRefresh && Number.isFinite(remaining) && remaining > REFRESH_AHEAD_MS) return tokens.accessToken;
    return this.refresh();
  }

  private refresh(): Promise<string> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const current = this.readTokens();
    if (!current) throw new Error("Link wallet is not connected. The owner must run payment_connect.");
    let next: TokenResponse;
    try {
      next = await refreshTokens(this.oauth, current.refreshToken);
    } catch (err) {
      if (err instanceof LinkOAuthError && err.code === "invalid_grant") {
        // The refresh token was revoked or already rotated elsewhere. Keeping it would only fail again.
        this.clearTokens();
        throw new Error("Link wallet was disconnected (refresh token rejected). The owner must run payment_connect again.", { cause: err });
      }
      throw err;
    }
    // Rotating refresh tokens: the old one is dead once Link answers, so persist before returning.
    this.storeTokens(next, current.refreshToken);
    return next.access_token;
  }

  // ---------------------------------------------------------------------------
  // Secret files
  // ---------------------------------------------------------------------------

  private storeTokens(res: TokenResponse, previousRefreshToken: string | undefined): void {
    const refreshToken = res.refresh_token ?? previousRefreshToken;
    if (!refreshToken) throw new Error("Link token response had no refresh_token.");
    const now = this.now();
    const stored: StoredTokens = {
      accessToken: res.access_token,
      refreshToken,
      expiresAt: new Date(now.getTime() + res.expires_in * 1000).toISOString(),
      obtainedAt: now.toISOString(),
      ...(res.scope ? { scope: res.scope } : {}),
    };
    writeSecret(this.tokensPath(), stored);
  }

  private readTokens(): StoredTokens | undefined {
    const t = readSecret<Partial<StoredTokens>>(this.tokensPath());
    if (!t || typeof t.accessToken !== "string" || typeof t.refreshToken !== "string" || typeof t.expiresAt !== "string") return undefined;
    return t as StoredTokens;
  }

  private clearTokens(): void {
    removeFile(this.tokensPath());
    this.cachedClient = undefined;
  }

  pendingPath(): string {
    return this.state.path(...OAUTH_FILE);
  }

  tokensPath(): string {
    return this.state.path(...TOKENS_FILE);
  }
}

/** The real SDK client. Its declaration files do not resolve under NodeNext, so the instance is typed by our own slice. */
function defaultLinkFactory(options: LinkClientOptions): LinkClientLike {
  return new Link(options) as unknown as LinkClientLike;
}

/** Write JSON to a 0600 file in a 0700 directory, through a temp file so readers never see a torn write. */
export function writeSecret(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  // writeFileSync ignores mode on an existing file, so set it again.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function readSecret<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function removeFile(file: string): void {
  fs.rmSync(file, { force: true });
}
