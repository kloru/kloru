/**
 * vault_list, vault_save_login and vault_save_api_key for desk workers: what secrets this request
 * may use (metadata only), saving a login Kloru made with a password generated in code, and saving
 * a key a service gave it. Tools that use them take `{{vault:name.field}}` references (script_run,
 * browser_*) or names (app_server), and scrub the values out of what they return.
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
        name: Type.String({ description: "lowercase, e.g. ezra-acme-login" }),
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
    defineTool({
      name: "vault_save_api_key",
      label: "Save a new API key",
      description: "After getting an API key or token for the person who asked (a sign-up, a developer console): save it as theirs, at once, and from then on use it by name: an app's server gets it with app_server's secrets, a script with script_run's. Never put the key in a page, a message or a result.",
      parameters: Type.Object({
        name: Type.String({ description: "lowercase, e.g. ezra-carto-key" }),
        service: Type.String({ description: "what it is a key for, e.g. CARTO" }),
        key: Type.String({ description: "the key, exactly as the service showed it" }),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ name, service, key }, ctx) => {
        const issue = desk.issueOfKey(ctx?.conversationKey);
        if (!issue) return failed("Only desk workers use the vault.");
        const had = vault.get(name);
        if (had && !desk.maySecret(issue, had.owner)) return failed(`${name} already exists and isn't this request's; pick another name.`);
        const r = vault.put({ name, owner: had?.owner ?? issue.filedBy.phone, kind: "api_key", meta: { service }, secret: { key: key.trim() }, createdBy: "kloru" });
        if (!r.ok) return failed(r.error);
        desk.recordSecret(issue, "vault_save_api_key", [name], true, `${had ? "replaced" : "saved"} an API key for ${service}`);
        return textResult(`Saved ${name}: API key for ${service}. An app's server uses it with app_server's secrets: ["${name}"] (kloru.secrets["${name}"]); a script with script_run's secrets.`);
      },
    }),
  ];
}
