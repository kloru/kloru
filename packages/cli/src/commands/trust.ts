/**
 * `instinct trust ...`: edit tiers and grants on disk through core. The agent
 * reads the same files, so changes apply on its next message.
 */
import {
  ContactStore,
  DEFAULT_TIER_TABLE,
  PolicyEngine,
  loadPolicy,
  savePolicy,
  type Capability,
  type Contact,
} from "@kloru/core";
import { parse, str, type OptionSpec } from "../args.js";
import { table } from "../ansi.js";
import type { CliContext } from "../context.js";
import { CliError, UsageError } from "../io.js";
import { parseTier } from "./invite.js";

export const trustOptions: OptionSpec = {
  until: { type: "string" },
  "max-usd": { type: "string" },
  note: { type: "string" },
  purpose: { type: "string" },
};

export function knownCapabilities(): Capability[] {
  return Object.keys(DEFAULT_TIER_TABLE.owner) as Capability[];
}

export function parseCapabilities(text: string, command: string): Capability[] {
  const known = knownCapabilities();
  const caps = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (caps.length === 0) throw new UsageError("Give at least one capability, e.g. calendar.write,plans.commit", command);
  const bad = caps.filter((c) => !known.includes(c as Capability));
  if (bad.length > 0) throw new UsageError(`Unknown capability: ${bad.join(", ")}. Known: ${known.join(", ")}`, command);
  return caps as Capability[];
}

/** Accepts an "until" date as YYYY-MM-DD (end of that day, UTC) or any ISO timestamp. */
export function parseUntil(value: string | undefined, command: string): string | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(dateOnly ? `${value}T23:59:59.000Z` : value);
  if (Number.isNaN(d.getTime())) throw new UsageError(`--until must be a date like 2026-12-31, got "${value}"`, command);
  return d.toISOString();
}

export function findContact(contacts: ContactStore, ref: string): Contact | undefined {
  const direct = contacts.get(ref);
  if (direct) return direct;
  const q = ref.toLowerCase();
  const matches = contacts.search(ref);
  return matches.find((c) => c.name.toLowerCase() === q || c.id === q) ?? (matches.length === 1 ? matches[0] : undefined);
}

export async function runTrust(ctx: CliContext, argv: string[]): Promise<number> {
  const { values, positionals } = parse("trust", argv, trustOptions);
  const [sub, ...rest] = positionals;
  const state = ctx.state();
  const contacts = new ContactStore(state);
  const engine = new PolicyEngine(loadPolicy(state));
  const { c } = ctx;

  switch (sub) {
    case undefined:
    case "list": {
      const all = contacts.all();
      ctx.print(c.bold("Contacts"));
      if (all.length === 0) ctx.print(c.dim("  none yet. Try: instinct trust set \"Sam Lee\" partner"));
      else {
        ctx.print(
          table(
            all.map((x) => [x.id, x.name, x.tier, x.phones[0] ?? x.emails[0] ?? "", x.agentHandle ? `@${x.agentHandle}` : ""]),
          ),
        );
      }
      const grants = engine.listGrants();
      ctx.print();
      ctx.print(c.bold("Grants"));
      if (grants.length === 0) ctx.print(c.dim("  none"));
      else {
        ctx.print(
          table(
            grants.map((g) => [
              g.id,
              g.to,
              g.capabilities.join(","),
              g.scope?.maxUsd !== undefined ? `max $${g.scope.maxUsd}` : "",
              g.expiresAt ? `until ${g.expiresAt.slice(0, 10)}` : "no expiry",
              g.note ?? "",
            ]),
          ),
        );
      }
      return 0;
    }
    case "set": {
      const [ref, tierText] = rest;
      if (!ref || !tierText) throw new UsageError("usage: instinct trust set <contact> <tier>", "trust");
      const tier = parseTier(tierText, "trust");
      const found = findContact(contacts, ref);
      if (tier === "staff" && !found?.agentHandle) {
        throw new UsageError(
          `Tier "staff" is only for agents, and ${found?.name ?? ref} has no agent handle. Save it first: instinct invite "${found?.name ?? ref}" --tier staff --handle <handle>, or pick partner or lower.`,
          "trust",
        );
      }
      const contact = found ? contacts.setTier(found.id, tier) : contacts.upsert({ name: ref, tier });
      if (!contact) throw new CliError(`Could not update ${ref}`);
      ctx.print(`${c.green(found ? "Updated" : "Added")} ${contact.name} (${contact.id}) -> ${c.bold(contact.tier)}`);
      return 0;
    }
    case "grant": {
      const [ref, capsText] = rest;
      if (!ref || !capsText) throw new UsageError("usage: instinct trust grant <contact> <cap,cap> [--until YYYY-MM-DD] [--max-usd N]", "trust");
      const contact = findContact(contacts, ref);
      if (!contact) throw new CliError(`Unknown contact "${ref}". Add them first: instinct trust set "${ref}" friend`);
      const capabilities = parseCapabilities(capsText, "trust");
      const maxUsdText = str(values, "max-usd");
      const maxUsd = maxUsdText === undefined ? undefined : Number(maxUsdText);
      if (maxUsd !== undefined && !Number.isFinite(maxUsd)) throw new UsageError(`--max-usd must be a number`, "trust");
      const scope: NonNullable<Parameters<PolicyEngine["addGrant"]>[0]["scope"]> = {};
      if (maxUsd !== undefined) scope.maxUsd = maxUsd;
      const purpose = str(values, "purpose");
      if (purpose) scope.purpose = purpose;
      const grant = engine.addGrant({
        to: `contact:${contact.id}`,
        capabilities,
        scope: Object.keys(scope).length ? scope : undefined,
        expiresAt: parseUntil(str(values, "until"), "trust"),
        note: str(values, "note"),
      });
      savePolicy(state, engine.toJSON());
      ctx.print(`${c.green("Granted")} ${capabilities.join(", ")} to ${contact.name} (${grant.id})${grant.expiresAt ? ` until ${grant.expiresAt}` : ""}${maxUsd !== undefined ? `, max $${maxUsd}` : ""}`);
      return 0;
    }
    case "revoke": {
      const [id] = rest;
      if (!id) throw new UsageError("usage: instinct trust revoke <grantId>", "trust");
      const ok = engine.revokeGrant(id);
      if (!ok) throw new CliError(`No grant with id ${id}. See: instinct trust list`);
      savePolicy(state, engine.toJSON());
      ctx.print(`${c.green("Revoked")} ${id}`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown trust subcommand "${sub}". Use list, set, grant or revoke.`, "trust");
  }
}
