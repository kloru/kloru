/**
 * Thin wrapper over node:util parseArgs. Each command declares its own
 * options; unknown flags become a UsageError that names the command.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";
import { UsageError } from "./io.js";

export type OptionSpec = NonNullable<ParseArgsConfig["options"]>;

export interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export function parse(command: string, argv: string[], options: OptionSpec): Parsed {
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: values as Parsed["values"], positionals };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(message, command);
  }
}

export function str(values: Parsed["values"], name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

export function requireStr(values: Parsed["values"], name: string, command: string): string {
  const v = str(values, name);
  if (!v) throw new UsageError(`--${name} is required`, command);
  return v;
}

export function num(values: Parsed["values"], name: string, fallback: number, command: string): number {
  const v = str(values, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${v}"`, command);
  return n;
}

export function flag(values: Parsed["values"], name: string): boolean {
  return values[name] === true;
}

/**
 * Pulls `--data-dir <dir>` (or `--data-dir=<dir>`) out of argv wherever it
 * appears so every command accepts it without redeclaring it.
 */
export function extractDataDir(argv: string[]): { argv: string[]; dataDir?: string } {
  const rest: string[] = [];
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--data-dir") {
      dataDir = argv[i + 1];
      if (dataDir === undefined) throw new UsageError("--data-dir needs a path");
      i++;
    } else if (a.startsWith("--data-dir=")) {
      dataDir = a.slice("--data-dir=".length);
    } else {
      rest.push(a);
    }
  }
  return { argv: rest, dataDir };
}
