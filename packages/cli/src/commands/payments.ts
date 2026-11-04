/**
 * `instinct payments connect | status`: link the owner's Stripe Link wallet to
 * the agent and see where that stands. The running server owns the OAuth state
 * (PKCE verifier, tokens), so the CLI asks it first and only builds the
 * authorize URL itself when no server answers.
 */
import { randomBytes } from "node:crypto";
import { parse, str, type OptionSpec } from "../args.js";
import { table } from "../ansi.js";
import type { CliContext } from "../context.js";
import { CliError, UsageError, fetchOf } from "../io.js";
import { DEFAULT_LOCAL_URL, authHeaders } from "../local.js";

export const paymentsOptions: OptionSpec = {
  url: { type: "string" },
};

/** Stripe Link Agent Wallet OAuth, per docs.stripe.com/agentic-commerce/agents/link-agent-wallet/oauth. */
export const LINK_AUTHORIZE_URL = "https://login.link.com/auth";
export const LINK_SCOPE = "payment_methods.agentic";

/** Routes the server is asked for, in order. The first 200 with JSON wins. */
export const LINK_START_PATH = "/oauth/link/start";
export const PAYMENTS_STATUS_PATH = "/payments/status";

type Json = Record<string, unknown>;

function pickUrl(body: Json): string | undefined {
  for (const k of ["url", "authorizeUrl", "authorize_url", "authorization_url", "location"]) {
    const v = body[k];
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  }
  return undefined;
}

async function getJson(f: typeof fetch, url: string, token?: string): Promise<{ status: number; body?: Json; location?: string } | undefined> {
  let res: Response;
  try {
    res = await f(url, { headers: { Accept: "application/json", ...authHeaders(token) }, redirect: "manual" });
  } catch {
    return undefined;
  }
  const location = res.headers.get("location") ?? undefined;
  const text = await res.text().catch(() => "");
  let body: Json | undefined;
  try {
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Json;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, location };
}

/** Ask the running server for its Link authorize URL. Undefined when it has no such route. */
export async function serverAuthorizeUrl(f: typeof fetch, baseUrl: string, token?: string): Promise<string | undefined> {
  const res = await getJson(f, `${baseUrl.replace(/\/+$/, "")}${LINK_START_PATH}`, token);
  if (!res) throw new CliError(`Could not reach ${baseUrl}. Is \`instinct dev\` running? Pass --url for another server.`);
  if (res.status === 401) throw new CliError(`${baseUrl} wants a chat token. Set INSTINCT_CHAT_TOKEN to the server's value.`);
  if (res.status >= 300 && res.status < 400 && res.location) return res.location;
  if (res.status === 200 && res.body) return pickUrl(res.body);
  return undefined;
}

/**
 * Build the authorize URL from env when the server cannot. Without the server's
 * PKCE verifier the code it yields cannot be exchanged, so this is for checking
 * the client configuration, not for completing a connection.
 */
export function buildAuthorizeUrl(env: NodeJS.ProcessEnv, baseUrl: string, state: string = randomBytes(12).toString("hex")): string {
  const clientId = env.LINK_CLIENT_ID;
  if (!clientId) throw new CliError("LINK_CLIENT_ID is not set and the server did not offer an authorize URL. Set LINK_CLIENT_ID (and LINK_REDIRECT_URI) or start `instinct dev`.");
  const redirect = env.LINK_REDIRECT_URI ?? `${baseUrl.replace(/\/+$/, "")}/oauth/link/callback`;
  const u = new URL(LINK_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("scope", LINK_SCOPE);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function runPaymentsConnect(ctx: CliContext, baseUrl: string): Promise<number> {
  const { c } = ctx;
  const fromServer = await serverAuthorizeUrl(fetchOf(ctx.io), baseUrl, ctx.env.INSTINCT_CHAT_TOKEN);
  if (fromServer) {
    ctx.print(c.bold("Connect your Link wallet"));
    ctx.print(`  Open this in a browser and approve. Link sends you back to your Kloru, which confirms over iMessage.`);
    ctx.print(`  ${fromServer}`);
    return 0;
  }
  const built = buildAuthorizeUrl(ctx.env, baseUrl);
  ctx.warn(`${baseUrl} has no ${LINK_START_PATH} route, so this URL was built from LINK_CLIENT_ID. The code exchange needs the server; start one with Link configured before approving.`);
  ctx.print(built);
  return 0;
}

export async function runPaymentsStatus(ctx: CliContext, baseUrl: string): Promise<number> {
  const { c } = ctx;
  const f = fetchOf(ctx.io);
  const root = baseUrl.replace(/\/+$/, "");
  const token = ctx.env.INSTINCT_CHAT_TOKEN;
  const res = await getJson(f, `${root}${PAYMENTS_STATUS_PATH}`, token);
  if (!res) throw new CliError(`Could not reach ${baseUrl}. Is \`instinct dev\` running? Pass --url for another server.`);
  ctx.print(c.bold(`Payments at ${baseUrl}`));
  let rows: string[][] | undefined;
  if (res.status === 200 && res.body) {
    rows = Object.entries(res.body).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  } else {
    // Older servers report payments inside GET /.
    const status = await getJson(f, `${root}/`, token);
    const payments = status?.body?.["payments"];
    if (payments && typeof payments === "object") {
      rows = Object.entries(payments as Json).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    }
  }
  if (rows && rows.length > 0) {
    ctx.print(table(rows));
  } else {
    ctx.print(c.dim(`  The server does not report payments (${PAYMENTS_STATUS_PATH} answered ${res.status}).`));
  }
  ctx.print();
  ctx.print(c.bold("Local configuration"));
  ctx.print(
    table([
      ["LINK_CLIENT_ID", ctx.env.LINK_CLIENT_ID ? "set" : "missing"],
      ["LINK_CLIENT_SECRET", ctx.env.LINK_CLIENT_SECRET ? "set" : "missing"],
      ["LINK_REDIRECT_URI", ctx.env.LINK_REDIRECT_URI ?? `(default ${root}/oauth/link/callback)`],
      ["STRIPE_PUBLISHABLE_KEY", ctx.env.STRIPE_PUBLISHABLE_KEY ? "set" : "missing"],
    ]),
  );
  return 0;
}

export async function runPayments(ctx: CliContext, argv: string[]): Promise<number> {
  const { values, positionals } = parse("payments", argv, paymentsOptions);
  const [sub] = positionals;
  const url = str(values, "url") ?? DEFAULT_LOCAL_URL;
  if (sub === "connect") return runPaymentsConnect(ctx, url);
  if (sub === "status") return runPaymentsStatus(ctx, url);
  throw new UsageError(`payments needs a subcommand: connect | status${sub ? ` (got "${sub}")` : ""}`, "payments");
}
