/**
 * Entry point shared by the binary and the tests. Parses the command word,
 * dispatches, and turns thrown errors into exit codes and short messages.
 */
import { extractDataDir } from "./args.js";
import { makeContext, type CliContext } from "./context.js";
import { renderHelp } from "./help.js";
import { CliError, UsageError, type CliIo } from "./io.js";
import { runChat } from "./commands/chat.js";
import { runConnect } from "./commands/connect.js";
import { runDeploy } from "./commands/deploy.js";
import { runDev } from "./commands/dev.js";
import { runInit } from "./commands/init.js";
import { runInvite } from "./commands/invite.js";
import { runPayments } from "./commands/payments.js";
import { runPersona } from "./commands/persona.js";
import { runPrompt } from "./commands/prompt.js";
import { runSchedules } from "./commands/schedules.js";
import { runStatus } from "./commands/status.js";
import { runTrust } from "./commands/trust.js";

export const CLI_VERSION = "0.1.0";

type Command = (ctx: CliContext, argv: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: runInit,
  connect: runConnect,
  dev: runDev,
  chat: runChat,
  status: runStatus,
  deploy: runDeploy,
  invite: runInvite,
  trust: runTrust,
  schedules: runSchedules,
  payments: runPayments,
  persona: runPersona,
  prompt: runPrompt,
};

export const COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);

/** Commands whose promise resolves while the process must stay up (a listening server). */
const LONG_RUNNING = new Set(["dev"]);

/**
 * True when the invocation starts a server the binary must not exit from.
 * `--data-dir` may precede the command word, so the raw argv index is not enough.
 */
export function keepsRunning(argv: string[]): boolean {
  try {
    const command = extractDataDir(argv).argv[0];
    return command !== undefined && LONG_RUNNING.has(command);
  } catch {
    return false;
  }
}

/**
 * Runs one invocation. `argv` excludes the node binary and script path.
 * Returns the exit code instead of calling process.exit so tests can assert on it.
 */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  let ctx: CliContext | undefined;
  try {
    const { argv: rest, dataDir } = extractDataDir(argv);
    ctx = makeContext(env, io, dataDir);
    const [command, ...commandArgs] = rest;

    if (!command || command === "--help" || command === "-h" || command === "help") {
      io.stdout(renderHelp(ctx.c, commandArgs[0]) + "\n");
      return 0;
    }
    if (command === "--version" || command === "-v") {
      io.stdout(`instinct ${CLI_VERSION}\n`);
      return 0;
    }
    const run = COMMANDS[command];
    if (!run) {
      throw new UsageError(`Unknown command "${command}". Commands: ${COMMAND_NAMES.join(", ")}`);
    }
    if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
      io.stdout(renderHelp(ctx.c, command) + "\n");
      return 0;
    }
    return await run(ctx, commandArgs);
  } catch (err) {
    const c = ctx?.c;
    const red = c ? c.red : (s: string) => s;
    const dim = c ? c.dim : (s: string) => s;
    if (err instanceof UsageError) {
      io.stderr(`${red("usage error")}: ${err.message}\n`);
      if (err.command) io.stderr(dim(`Run: instinct ${err.command} --help\n`));
      return err.exitCode;
    }
    if (err instanceof CliError) {
      io.stderr(`${red("error")}: ${err.message}\n`);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`${red("error")}: ${message}\n`);
    if (env.INSTINCT_DEBUG && err instanceof Error && err.stack) io.stderr(err.stack + "\n");
    return 1;
  }
}
