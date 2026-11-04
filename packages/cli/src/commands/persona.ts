/**
 * `instinct persona ...`: read and change <dataDir>/PERSONA.md, the identity section of
 * the agent's system prompt. The server reads the file on every message, so a change
 * made here applies to the next reply without a restart.
 */
import { spawnSync } from "node:child_process";
import {
  DEFAULT_PERSONA,
  PERSONA_FILE,
  ensurePersona,
  isDefaultPersona,
  personaText,
  readPersona,
  resetPersona,
  writePersona,
} from "@kloru/core";
import { parse, type OptionSpec } from "../args.js";
import type { CliContext } from "../context.js";
import { CliError, UsageError } from "../io.js";

export const personaOptions: OptionSpec = {};

/** `$VISUAL`, then `$EDITOR`, split on whitespace so "code --wait" works. */
export function editorCommand(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env.VISUAL?.trim() || env.EDITOR?.trim();
  if (!raw) return undefined;
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export async function runPersona(ctx: CliContext, argv: string[]): Promise<number> {
  const { positionals } = parse("persona", argv, personaOptions);
  const [sub, ...rest] = positionals;
  const state = ctx.state();
  const file = state.path(PERSONA_FILE);
  const { c } = ctx;

  switch (sub) {
    case undefined:
    case "show": {
      const custom = readPersona(state);
      ctx.print(c.dim(custom ? `# ${file}` : `# built-in default; ${file} does not exist yet (instinct persona edit writes it)`));
      ctx.print(personaText(state));
      return 0;
    }
    case "path": {
      ctx.print(file);
      return 0;
    }
    case "set": {
      const text = rest.join(" ").trim();
      if (!text) throw new UsageError('usage: instinct persona set "<text>"', "persona");
      writePersona(state, text);
      ctx.print(`${c.green("Wrote")} ${file}`);
      ctx.print(c.dim("The agent uses it on its next message."));
      return 0;
    }
    case "reset": {
      const wasDefault = isDefaultPersona(state) && state.exists(PERSONA_FILE);
      resetPersona(state);
      ctx.print(`${c.green(wasDefault ? "Already the default" : "Reset")} ${file}`);
      return 0;
    }
    case "edit": {
      // Make sure there is a file to edit, with the default as the starting point.
      if (ensurePersona(state)) ctx.print(c.dim(`Wrote the default persona to ${file}`));
      const editor = editorCommand(ctx.env);
      if (!editor) {
        ctx.print(`No $EDITOR set. Edit this file by hand:\n  ${file}`);
        return 0;
      }
      const [cmd, ...args] = editor;
      const result = spawnSync(cmd!, [...args, file], { stdio: "inherit" });
      if (result.error) throw new CliError(`Could not start ${cmd}: ${result.error.message}. The file is ${file}`);
      if (result.status !== 0) throw new CliError(`${cmd} exited with ${result.status}. The file is ${file}`);
      if (!readPersona(state)) {
        ctx.warn(`${file} is empty; the agent will use the built-in default until you write something.`);
        return 0;
      }
      ctx.print(`${c.green("Saved")} ${file}${isDefaultPersona(state) ? c.dim(" (unchanged from the default)") : ""}`);
      return 0;
    }
    case "default": {
      ctx.print(DEFAULT_PERSONA.trim());
      return 0;
    }
    default:
      throw new UsageError(`Unknown persona subcommand "${sub}". Use show, edit, set, reset or path.`, "persona");
  }
}
