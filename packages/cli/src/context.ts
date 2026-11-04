/**
 * Per-invocation context: where state lives, how to print, which env to read.
 * Commands receive this instead of touching process.* directly.
 */
import path from "node:path";
import { StateDir } from "@kloru/core";
import { palette, type Palette } from "./ansi.js";
import type { CliIo } from "./io.js";

export interface CliContext {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  c: Palette;
  dataDir: string;
  /** Lazily created so `--help` never touches the disk. */
  state(): StateDir;
  print(text?: string): void;
  warn(text: string): void;
}

export function resolveCliDataDir(env: NodeJS.ProcessEnv, cwd: string, explicit?: string): string {
  const chosen = explicit ?? env.INSTINCT_DATA_DIR?.trim() ?? ".instinct";
  return path.resolve(cwd, chosen);
}

export function makeContext(env: NodeJS.ProcessEnv, io: CliIo, dataDirFlag?: string): CliContext {
  const cwd = io.cwd ?? process.cwd();
  const dataDir = resolveCliDataDir(env, cwd, dataDirFlag);
  const c = palette(io.color === true);
  let state: StateDir | undefined;
  return {
    env,
    io,
    c,
    dataDir,
    state() {
      if (!state) {
        state = new StateDir(dataDir);
        state.ensure();
      }
      return state;
    },
    print(text = "") {
      io.stdout(text + "\n");
    },
    warn(text) {
      io.stderr(c.yellow(text) + "\n");
    },
  };
}
