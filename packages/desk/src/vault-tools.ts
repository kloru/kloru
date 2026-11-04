/**
 * vault_list and vault_save_login for desk workers: what secrets this request may use (metadata
 * only), and saving a login Kloru made with a password generated in code. Values never reach a
 * model: tools that use them take `{{vault:name.field}}` references (script_run, browser_*).
 */
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import type { Desk } from "./desk.js";
import { describeEntry, type Vault } from "./vault.js";

export { describeEntry };

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function vaultTools(desk: Desk, vault: Vault, nameOf: (phone: string) => string, vaultUrl = "https://kloru.com/vault"): RegisteredTool[] {
  return [
    defineTool({
      name: "vault_list",
      label: "List usable secrets",
      description: "The family's saved cards, logins and API keys this request may use, by name, never their values. Use one by name: fillSecret in browser_run for a login, browser_pay for a card, script_run's secrets for an API key.",
      parameters: Type.Object({}),
      meta: { capabilities: [], group: "files" as const },
      execute: async (_args, ctx) => {
        const issue = desk.issueOfKey(ctx?.conversationKey);
        if (!issue) return failed("Only desk workers use the vault.");
        const usable = vault.list().filter((e) => desk.maySecret(issue, e.owner));
        return textResult(usable.length ? usable.map((e) => `- ${describeEntry(e, nameOf)}`).join("\n") : `Nothing saved this request may use. Cards, logins and keys go in the Vault at ${vaultUrl}: send the person that link, and do everything up to the step that needs it.`);
      },
    }),
    defineTool({
      name: "vault_save_login",
      label: "Save a new login",
      description: "After signing up on a site for the person who asked: makes a strong password (you never see it) and saves the login as theirs. Then fillSecret(selector, '<name>.password') in browser_run where the site asks for it.",
      parameters: Type.Object({
        name: Type.String({ description: "lowercase, e.g. evan-acme-login" }),
        site: Type.String({ description: "the site's address, e.g. acme.com" }),
        username: Type.String({ description: "the email or username used to sign up" }),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ name, site, username }, ctx) => {
        const issue = desk.issueOfKey(ctx?.conversationKey);
        if (!issue) return failed("Only desk workers use the vault.");
        if (vault.get(name)) return failed(`${name} already exists; pick another name, or use it.`);
        const r = vault.generateLogin({ name, owner: issue.filedBy.phone, site, username, createdBy: "kloru" });
        if (!r.ok) return failed(r.error);
        desk.recordSecret(issue, "vault_save_login", [name], true, `saved a login for ${site} as ${username}`);
        return textResult(`Saved ${name}: ${site} as ${username}. In browser_run: await fillSecret("<password field selector>", "${name}.password").`);
      },
    }),
  ];
}
