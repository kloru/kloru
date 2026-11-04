/**
 * Inkbox credentials written by `instinct init` and read by `dev` and
 * `deploy`. They live outside config.json so the config can be committed or
 * shared without leaking keys. File mode is 0600.
 */
import fs from "node:fs";
import path from "node:path";

export interface InkboxSecrets {
  handle: string;
  identityId: string;
  apiKey: string;
  signingKey?: string;
  email?: string;
  phone?: string;
  tunnelHost?: string;
}

export const SECRETS_FILE = ["secrets", "inkbox.json"] as const;

export function secretsPath(dataDir: string): string {
  return path.join(dataDir, ...SECRETS_FILE);
}

export function readSecrets(dataDir: string): InkboxSecrets | undefined {
  const file = secretsPath(dataDir);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<InkboxSecrets>;
    if (!parsed.apiKey || !parsed.handle) return undefined;
    return parsed as InkboxSecrets;
  } catch {
    return undefined;
  }
}

export function writeSecrets(dataDir: string, secrets: InkboxSecrets): string {
  const file = secretsPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync ignores mode on an existing file, so set it again.
  fs.chmodSync(file, 0o600);
  return file;
}

/** The env the server and the Maritime agent expect for these secrets. */
export function secretsToEnv(secrets: InkboxSecrets): Record<string, string> {
  const env: Record<string, string> = {
    INKBOX_API_KEY: secrets.apiKey,
    INKBOX_AGENT_HANDLE: secrets.handle,
    INKBOX_IDENTITY_ID: secrets.identityId,
  };
  if (secrets.signingKey) env.INKBOX_SIGNING_KEY = secrets.signingKey;
  return env;
}

/** Fills env from the secrets file without overriding values already set. */
export function applySecretsToEnv(env: NodeJS.ProcessEnv, secrets: InkboxSecrets | undefined): string[] {
  if (!secrets) return [];
  const applied: string[] = [];
  for (const [k, v] of Object.entries(secretsToEnv(secrets))) {
    if (!env[k]) {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
