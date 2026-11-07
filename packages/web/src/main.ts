/** `node dist/main.js`: read the environment, start the console. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { clientFor } from "./agent-client.js";
import { createConsole } from "./server.js";
import { existsSync } from "node:fs";
import pg from "pg";
import { type AgentRef, type ConsoleStore, FileStore, PgStore, isPhone, normPhone } from "./store.js";
import { TwilioVerify, type TwilioVerifyOptions } from "./verify.js";

export interface ConsoleEnv {
  port: number;
  bind: string;
  publicUrl: string;
  dataDir: string;
  sessionSecret: string;
  adminPhones: string[];
  verify: TwilioVerifyOptions;
  trustProxy: boolean;
  /** Postgres connection string (Neon). Unset: console.json in dataDir. */
  databaseUrl?: string;
  devAgent?: AgentRef;
  /** The voice service's call log, for the Admin page. */
  callLogPath?: string;
  /** The voice service's call transcripts, for the Admin page. */
  transcriptsDir?: string;
  deskDir?: string;
  version?: string;
  alertsPath?: string;
  revokedArtifactsPath?: string;
  /** Per-person voice preferences, shared with the voice service. */
  prefsPath?: string;
}

const REQUIRED = ["KLORU_SESSION_SECRET", "KLORU_ADMIN_PHONES", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"] as const;

export function loadConsoleEnv(env: NodeJS.ProcessEnv): ConsoleEnv {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length > 0) throw new Error(`kloru console: missing env ${missing.join(", ")}`);
  const sessionSecret = env.KLORU_SESSION_SECRET!.trim();
  if (sessionSecret.length < 32) throw new Error("kloru console: KLORU_SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)");
  const port = Number(env.KLORU_PORT ?? 8790);
  const publicUrl = (env.KLORU_PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, "");
  const devUrl = env.KLORU_DEV_AGENT_URL?.trim();
  const adminPhones = env.KLORU_ADMIN_PHONES!.split(",").map((p) => p.trim()).filter(Boolean);
  const bad = adminPhones.filter((p) => !isPhone(p));
  if (bad.length > 0) throw new Error(`kloru console: KLORU_ADMIN_PHONES has numbers without a country or area code: ${bad.join(", ")}`);
  return {
    port,
    bind: env.KLORU_BIND?.trim() || "127.0.0.1",
    publicUrl,
    dataDir: env.KLORU_DATA_DIR?.trim() || ".kloru",
    sessionSecret,
    adminPhones: adminPhones.map(normPhone),
    verify: { accountSid: env.TWILIO_ACCOUNT_SID!.trim(), authToken: env.TWILIO_AUTH_TOKEN!.trim(), serviceSid: env.TWILIO_VERIFY_SERVICE_SID!.trim() },
    trustProxy: /^(1|true|yes)$/i.test(env.KLORU_TRUST_PROXY?.trim() ?? ""),
    ...(env.DATABASE_URL?.trim() ? { databaseUrl: env.DATABASE_URL.trim() } : {}),
    ...(env.KLORU_CALL_LOG?.trim() ? { callLogPath: env.KLORU_CALL_LOG.trim() } : {}),
    ...(env.KLORU_TRANSCRIPTS?.trim() ? { transcriptsDir: env.KLORU_TRANSCRIPTS.trim() } : {}),
    ...(env.KLORU_DESK_DIR?.trim() ? { deskDir: env.KLORU_DESK_DIR.trim() } : {}),
    ...(env.KLORU_VERSION?.trim() ? { version: env.KLORU_VERSION.trim() } : {}),
    ...(env.KLORU_ALERTS?.trim() ? { alertsPath: env.KLORU_ALERTS.trim() } : {}),
    ...(env.KLORU_DATA_DIR?.trim() ? { revokedArtifactsPath: `${env.KLORU_DATA_DIR.trim()}/revoked-artifacts.json` } : {}),
    ...(env.KLORU_VOICE_PREFS?.trim() ? { prefsPath: env.KLORU_VOICE_PREFS.trim() } : {}),
    ...(devUrl ? { devAgent: { kind: "direct", url: devUrl, tokenEnv: "INSTINCT_CHAT_TOKEN", secretEnv: "OWNER_API_SECRET" } as const } : {}),
  };
}

/** Postgres when configured (importing an existing console.json once), else the file store. */
export async function openStore(cfg: ConsoleEnv, log: (m: string) => void): Promise<ConsoleStore> {
  const file = new FileStore(cfg.dataDir);
  if (!cfg.databaseUrl) return file;
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 5, idleTimeoutMillis: 30_000 });
  const store = await PgStore.open(pool);
  if (existsSync(file.file)) {
    await store.importFile(file.read());
    log(`imported ${file.file} into Postgres (existing rows kept)`);
  }
  return store;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cfg = loadConsoleEnv(env);
  const log = (m: string) => console.log(`[kloru] ${m}`);
  const store = await openStore(cfg, log);
  const server = createConsole({
    store,
    sessionSecret: cfg.sessionSecret,
    publicUrl: cfg.publicUrl,
    ...(env.KLORU_CONTACT_EMAIL?.trim() ? { operator: { contact: env.KLORU_CONTACT_EMAIL.trim() } } : {}),
    adminPhones: cfg.adminPhones,
    verifier: new TwilioVerify(cfg.verify),
    trustProxy: cfg.trustProxy,
    ...(cfg.callLogPath ? { callLogPath: cfg.callLogPath } : {}),
    ...(cfg.transcriptsDir ? { transcriptsDir: cfg.transcriptsDir } : {}),
    ...(cfg.deskDir ? { deskDir: cfg.deskDir } : {}),
    ...(cfg.alertsPath ? { alertsPath: cfg.alertsPath } : {}),
    ...(cfg.revokedArtifactsPath ? { revokedArtifactsPath: cfg.revokedArtifactsPath } : {}),
    ...(cfg.prefsPath ? { prefsPath: cfg.prefsPath } : {}),
    clientFor: (user) => clientFor(user, env),
    ...(cfg.devAgent ? { pageClient: () => clientFor({ agent: cfg.devAgent } as Parameters<typeof clientFor>[0], env) } : {}),
    staticDir: fileURLToPath(new URL("../static", import.meta.url)),
    ...(cfg.devAgent ? { devAgent: cfg.devAgent } : {}),
    log,
  });
  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.bind, () => resolve()));
  log(`console on ${cfg.publicUrl} (listening ${cfg.bind}:${cfg.port}); ${cfg.adminPhones.length} admin number(s); store: ${cfg.databaseUrl ? "postgres" : "file"}`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
