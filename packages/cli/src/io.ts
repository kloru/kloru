/**
 * The CLI talks to the world through this small interface so tests can
 * capture output, stub HTTP and avoid starting a real server.
 */
import type { ServerModule, TunnelConnector } from "./commands/dev.js";
import type { ProvisionerFactory } from "./inkbox-client.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Working directory used to resolve a relative data dir. */
  cwd?: string;
  /** Replaces globalThis.fetch for every HTTP call the CLI makes. */
  fetchImpl?: typeof fetch;
  /** Enables ANSI colors. Off by default so captured output stays plain. */
  color?: boolean;
  /** Overrides the dynamic import of @kloru/server (tests). */
  importServer?: () => Promise<ServerModule>;
  /** Overrides how the Inkbox provisioner is built (tests). */
  createProvisioner?: ProvisionerFactory;
  /** Overrides how `dev --tunnel` opens the Inkbox tunnel (tests). */
  connectTunnel?: TunnelConnector;
  /** `dev` registers SIGINT/SIGTERM handlers unless this is false (tests). */
  installSignalHandlers?: boolean;
}

/** Thrown for bad invocations. Exit code 2, message printed without a stack. */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string, readonly command?: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Thrown for runtime failures the user can act on. Exit code 1. */
export class CliError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function fetchOf(io: CliIo): typeof fetch {
  return io.fetchImpl ?? globalThis.fetch;
}
