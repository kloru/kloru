#!/usr/bin/env node
/** The `instinct` binary. Everything testable lives in cli.ts. */
import { keepsRunning, runCli } from "./cli.js";

const argv = process.argv.slice(2);
const code = await runCli(argv, process.env, {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  color: process.stdout.isTTY === true && !process.env.NO_COLOR,
});

// `instinct dev` keeps the server alive; every other command ends here.
if (!keepsRunning(argv) || code !== 0) process.exit(code);
