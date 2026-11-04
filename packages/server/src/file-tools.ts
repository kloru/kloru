/**
 * Pi's coding-agent file tools, bound to the owner's workspace directory and
 * tagged with capabilities so the policy engine can gate them. Only the owner
 * tier has files.read / files.write by default; staff (the owner's own agents)
 * deliberately has neither, because bash needs both and is a real shell.
 *
 * Two guards sit in front of Pi here:
 *
 * - read, ls, grep, write and edit refuse any path that resolves outside the
 *   workspace, after following symlinks. Pi's own resolver accepts absolute paths
 *   and `~`, which would otherwise expose the data dir (secrets, other
 *   principals' transcripts) to a prompt-injected owner conversation.
 * - bash runs with a small allowlisted environment. Pi spreads process.env into
 *   the shell by default, which would hand every provider and Inkbox key to
 *   `env`. Nothing matching KEY, SECRET, TOKEN or PASSWORD ever reaches it.
 *
 * bash is still a real shell with cwd = workspace, not a sandbox. It can read
 * any file the process uid can read. Keep secrets out of the process uid's reach
 * (see deploy/kloru/Dockerfile) and treat the owner conversation as the only
 * place these tools may be visible.
 */
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@kloru/core";
import type { Capability, RegisteredTool, ToolContext, ToolMeta, ToolResultLike } from "@kloru/core";

const READ: Capability[] = ["files.read"];
const WRITE: Capability[] = ["files.write"];
const BOTH: Capability[] = ["files.read", "files.write"];

/** Capabilities per Pi tool name. bash can do anything, so it needs both. */
export const FILE_TOOL_CAPABILITIES: Record<string, Capability[]> = {
  read: READ,
  ls: READ,
  grep: READ,
  write: WRITE,
  edit: WRITE,
  bash: BOTH,
};

/** Environment variables the shell may inherit. Anything else is dropped. */
export const SHELL_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
];
const SHELL_ENV_PREFIXES: readonly string[] = ["LC_"];
/** Belt and braces: even an allowlisted name that looks like a credential is dropped. */
export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

/** The environment the bash tool runs with: allowlisted names only, no credentials. */
export function shellEnvFor(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(name)) continue;
    const allowed = SHELL_ENV_ALLOWLIST.includes(name) || SHELL_ENV_PREFIXES.some((p) => name.startsWith(p));
    if (allowed) out[name] = value;
  }
  return out;
}

export interface WrapOptions {
  rename?: string;
  /** Runs before Pi; return an error result to refuse the call. */
  guard?: (args: unknown, ctx: ToolContext) => ToolResultLike | undefined;
}

/** Turn a ready-made Pi AgentTool into a RegisteredTool with policy metadata. */
export function wrapAgentTool(tool: AgentTool<any>, meta: ToolMeta, opts: WrapOptions | string = {}): RegisteredTool {
  const options: WrapOptions = typeof opts === "string" ? { rename: opts } : opts;
  return defineTool({
    name: options.rename ?? tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    meta,
    execute: async (args, ctx, signal): Promise<ToolResultLike> => {
      const refused = options.guard?.(args, ctx);
      if (refused) return refused;
      // Pi tools want a tool call id; we have no Pi-level id here, so derive one from the conversation.
      const id = `${ctx.conversationKey}:${ctx.now().getTime()}`;
      const result = await tool.execute(id, args, signal);
      return {
        content: result.content.map((block) =>
          block.type === "text"
            ? { type: "text" as const, text: block.text }
            : { type: "image" as const, data: block.data, mimeType: block.mimeType },
        ),
        details: result.details,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  });
}

/**
 * Where a tool path lands, or undefined when it escapes the workspace. Symlinks are
 * followed through the deepest existing ancestor, so a link inside the workspace that
 * points outside is refused and a path through a linked directory is judged by its
 * real location.
 */
export function resolveInsideWorkspace(workspace: string, requested: string): string | undefined {
  if (requested.startsWith("~")) return undefined;
  const root = realpathSync(workspace);
  const target = path.resolve(root, requested);
  if (!within(root, target)) return undefined;
  // Follow symlinks: realpath the deepest existing prefix and re-attach the rest.
  let existing = target;
  const rest: string[] = [];
  while (!exists(existing)) {
    rest.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) return undefined;
    existing = parent;
  }
  const real = path.join(realpathSync(existing), ...rest);
  return within(root, real) ? target : undefined;
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Guard for Pi tools whose args carry a `path`. Tools without a path arg (ls, grep defaults) pass. */
export function workspacePathGuard(workspace: string): (args: unknown) => ToolResultLike | undefined {
  return (args) => {
    if (!args || typeof args !== "object") return undefined;
    const requested = (args as Record<string, unknown>).path;
    if (typeof requested !== "string" || requested.length === 0) return undefined;
    if (resolveInsideWorkspace(workspace, requested) !== undefined) return undefined;
    return {
      content: [{ type: "text", text: `Refused: "${requested}" is outside the workspace. File tools only work on paths inside workspace/.` }],
      isError: true,
    };
  };
}

export interface FileToolsOptions {
  /** Include the bash tool. Default true. Turn off for hosts where a shell is not acceptable. */
  bash?: boolean;
  /** Environment the shell is built from. Default process.env. Filtered by shellEnvFor. */
  env?: NodeJS.ProcessEnv;
}

/**
 * File tools bound to `workspace`. read/ls/grep/write/edit refuse paths outside it.
 * bash runs with cwd = workspace and an allowlisted environment; it is a real shell,
 * not a sandbox.
 */
export function fileTools(workspace: string, opts: FileToolsOptions = {}): RegisteredTool[] {
  mkdirSync(workspace, { recursive: true });
  const guard = workspacePathGuard(workspace);
  const shellEnv = shellEnvFor(opts.env ?? process.env);
  const guarded: AgentTool<any>[] = [
    createReadTool(workspace),
    createLsTool(workspace),
    createGrepTool(workspace),
    createWriteTool(workspace),
    createEditTool(workspace),
  ];
  const tools = guarded.map((t) => wrapAgentTool(t, metaFor(t.name), { guard }));
  if (opts.bash !== false) {
    const bash = createBashTool(workspace, {
      exposeSessionEnvironment: false,
      spawnHook: (ctx) => ({ ...ctx, env: { ...shellEnv } }),
    });
    tools.push(wrapAgentTool(bash, metaFor(bash.name)));
  }
  return tools;
}

function metaFor(name: string): ToolMeta {
  return {
    capabilities: FILE_TOOL_CAPABILITIES[name] ?? BOTH,
    group: "files",
    describe: (args) => `${name} ${summarizeArgs(args)}`,
  };
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : undefined;
  const command = typeof a.command === "string" ? a.command : undefined;
  return path ?? command?.slice(0, 80) ?? "";
}
