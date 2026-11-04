/**
 * `instinct invite <name> --tier friend`: put a person in the trusted network
 * and, when we have an admin key, create an Inkbox A2A invitation their agent
 * can accept.
 */
import { ContactStore, TIER_ORDER, normalizeHandle, type Tier } from "@kloru/core";
import { parse, str, type OptionSpec } from "../args.js";
import type { CliContext } from "../context.js";
import { UsageError } from "../io.js";
import { makeProvisioner } from "../inkbox-client.js";
import { readSecrets } from "../secrets.js";
import { loadConfig } from "@kloru/core";

export const inviteOptions: OptionSpec = {
  tier: { type: "string" },
  email: { type: "string" },
  phone: { type: "string" },
  handle: { type: "string" },
  note: { type: "string" },
};

export function parseTier(value: string | undefined, command: string): Tier {
  if (!value) throw new UsageError(`--tier is required (${TIER_ORDER.filter((t) => t !== "owner").join(", ")})`, command);
  const t = value.toLowerCase();
  if (!TIER_ORDER.includes(t as Tier) || t === "owner") {
    throw new UsageError(`Unknown tier "${value}". Use one of: ${TIER_ORDER.filter((x) => x !== "owner").join(", ")}`, command);
  }
  return t as Tier;
}

export async function runInvite(ctx: CliContext, argv: string[]): Promise<number> {
  const { values, positionals } = parse("invite", argv, inviteOptions);
  const name = positionals.join(" ").trim();
  if (!name) throw new UsageError("invite needs a contact name: instinct invite \"Sam Lee\" --tier friend", "invite");
  const tier = parseTier(str(values, "tier"), "invite");
  const email = str(values, "email");
  const phone = str(values, "phone");
  const peerHandle = str(values, "handle") ? normalizeHandle(str(values, "handle")!) : undefined;
  const { c } = ctx;

  const contacts = new ContactStore(ctx.state());
  const existing = contacts.search(name).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (tier === "staff" && !(peerHandle ?? existing?.agentHandle)) {
    throw new UsageError(`Tier "staff" is only for agents, and ${existing?.name ?? name} has no agent handle. Add --handle <their agent's Inkbox handle>, or pick partner or lower.`, "invite");
  }
  const contact = contacts.upsert({
    ...(existing ?? {}),
    name: existing?.name ?? name,
    tier,
    phones: phone ? Array.from(new Set([...(existing?.phones ?? []), phone])) : existing?.phones,
    emails: email ? Array.from(new Set([...(existing?.emails ?? []), email])) : existing?.emails,
    agentHandle: peerHandle ?? existing?.agentHandle,
    notes: str(values, "note") ?? existing?.notes,
  });
  ctx.print(`${c.green(existing ? "Updated" : "Added")} ${contact.name} (${contact.id}) as ${c.bold(contact.tier)}${contact.agentHandle ? `, agent @${contact.agentHandle}` : ""}`);

  const adminKey = ctx.env.INKBOX_ADMIN_API_KEY;
  if (!adminKey) {
    ctx.print(c.dim("No INKBOX_ADMIN_API_KEY, so no A2A invitation was created. The contact and tier are saved."));
    return 0;
  }
  const secrets = readSecrets(ctx.dataDir);
  const ourHandle = secrets?.handle ?? ctx.env.INKBOX_AGENT_HANDLE ?? loadConfig(ctx.state(), ctx.env).agent.handle;
  if (!ourHandle) {
    ctx.warn("Our own handle is unknown; run `instinct init --handle` before inviting agents.");
    return 0;
  }
  const provisioner = makeProvisioner(ctx.io, ctx.env, adminKey);
  if (peerHandle) {
    // Open our side of the A2A gate now so the peer's first task is admitted.
    await provisioner.addContactRule(ourHandle, peerHandle, "both");
    ctx.print(`Allowed A2A with @${peerHandle} on @${ourHandle}.`);
  }
  const invitation = await provisioner.createInvitation({ peerHandles: [ourHandle], recipientEmail: email });
  ctx.print();
  ctx.print(c.bold(`Invitation for ${contact.name} (${tier})`));
  if (invitation.invitationUrl) ctx.print(`  link    ${invitation.invitationUrl}`);
  if (invitation.invitationToken) ctx.print(`  token   ${invitation.invitationToken}`);
  if (invitation.agentHandoffPrompt) {
    ctx.print("  Forward this to their Kloru (or paste it into any agent):");
    ctx.print(indent(invitation.agentHandoffPrompt, "    "));
  }
  if (email) ctx.print(c.dim(`  Inkbox also emailed ${email}.`));
  return 0;
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
