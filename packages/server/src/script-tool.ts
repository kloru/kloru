/**
 * script_run: a desk worker runs a short Node script, with vault secrets it names injected as
 * environment variables (VAULT_<NAME>_<FIELD>), so an API key reaches the API and never the model.
 * The script gets no other environment (none of Kloru's own keys), runs in a scratch folder with a
 * time limit, and what it prints is scrubbed of every vault value before anyone sees it.
 * Owners only (computer.use): running code on Kloru's machine is theirs to ask for.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import type { Desk, Vault } from "@kloru/desk";
import { Type } from "@earendil-works/pi-ai";

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const MAX_OUT = 20_000;

/** VAULT_EZRA_PGE_API_KEY for ezra-pge-api.key */
export const envName = (name: string, field: string) => `VAULT_${name}_${field}`.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export function scriptTool(o: { desk: Desk; vault: Vault; workspaceDir: string }): RegisteredTool {
  return defineTool({
    name: "script_run",
    label: "Run a script",
    description:
      "Run a short Node.js script (ESM, Node 22, fetch built in) for an API or a calculation. Secrets go in by name: list them in `secrets` as name.field and read process.env.VAULT_<NAME>_<FIELD> (dashes and dots become underscores). Never print a secret; output is scrubbed anyway.",
    parameters: Type.Object({
      code: Type.String({ description: "the script; print results with console.log" }),
      secrets: Type.Optional(Type.Array(Type.String({ description: "name.field, e.g. ezra-weather-api.key" }))),
      timeout_seconds: Type.Optional(Type.Number({ description: "default 60, at most 300" })),
    }),
    meta: { capabilities: ["computer.use"], group: "files" as const },
    execute: async ({ code, secrets = [], timeout_seconds }, ctx) => {
      const issue = o.desk.issueOfKey(ctx?.conversationKey);
      if (!issue) return failed("Only desk workers run scripts.");
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_NO_WARNINGS: "1" };
      const names: string[] = [];
      for (const ref of secrets) {
        const [name, field] = ref.split(".");
        const e = name ? o.vault.get(name) : undefined;
        if (!e || !field) return failed(`no vault secret ${ref}; vault_list shows what this request may use`);
        if (!o.desk.maySecret(issue, e.owner)) {
          o.desk.recordSecret(issue, "script_run", [name!], false, "refused: someone else's secret");
          return failed(`${name} isn't this request's to use; ask its owner to share it.`);
        }
        const value = o.vault.value(name!, field);
        if (value === undefined) return failed(`${name} has no ${field}`);
        env[envName(name!, field)] = value;
        names.push(name!);
      }
      const base = join(o.workspaceDir, "scripts");
      mkdirSync(base, { recursive: true });
      const dir = mkdtempSync(join(base, "run-"));
      const file = join(dir, "script.mjs");
      writeFileSync(file, code);
      const timeout = Math.min(Math.max(timeout_seconds ?? 60, 1), 300) * 1000;
      const out = await new Promise<{ code: number | null; text: string }>((resolve) =>
        execFile(process.execPath, [file], { cwd: dir, env: { ...env, HOME: dir }, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) =>
          resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code?: unknown }).code as number) : 1) : 0, text: `${stdout}${stderr ? `\n${stderr}` : ""}` }),
        ),
      );
      rmSync(dir, { recursive: true, force: true });
      const text = o.vault.scrub(out.text).slice(0, MAX_OUT);
      if (names.length) o.desk.recordSecret(issue, "script_run", names, out.code === 0, out.code === 0 ? "ran" : `exited ${out.code}`);
      return out.code === 0 ? textResult(text || "(no output)") : failed(`The script failed (${out.code}):\n${text}`);
    },
  });
}
