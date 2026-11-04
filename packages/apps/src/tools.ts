/**
 * Two small tools so the model can answer "which apps are connected?" and
 * "connect my Notion" without guessing: apps_list and apps_connect. Both are
 * owner-only through APPS_MANAGE, and apps_connect also refuses any caller that is
 * not the owner principal, whatever the policy says. The link goes to the owner;
 * tokens never appear anywhere.
 */
import type { RegisteredTool, ToolContext, ToolResultLike, ToolSpec } from "@kloru/core";
import { Type } from "typebox";
import { APPS_MANAGE } from "./capabilities.js";
import type { ToolkitStatus } from "./composio.js";

/** The slice of ComposioApps these tools call. Narrow so tests can stub it. */
export interface AppsLike {
  readonly allToolkits: boolean;
  readonly toolkitSlugs: string[];
  connectedToolkits(): Promise<ToolkitStatus[]>;
  connectLink(toolkit: string): Promise<string | undefined>;
}

export interface AppsToolDeps {
  apps: AppsLike;
}

/** Composio toolkit slugs are lowercase words, digits and underscores. */
const TOOLKIT_SLUG = /^[a-z0-9_-]{1,64}$/;

export function appsTools(deps: AppsToolDeps): RegisteredTool[] {
  return [listTool(deps), connectTool(deps)];
}

function listTool({ apps }: AppsToolDeps): RegisteredTool {
  return {
    spec: {
      name: "apps_list",
      label: "List connected apps",
      description:
        "Which apps are connected through Composio for the owner, which configured ones are not, and whether any app can be requested by name. Call this before answering a question about connected apps.",
      parameters: Type.Object({}),
      meta: {
        capabilities: [...APPS_MANAGE],
        group: "apps",
        describe: () => "list connected apps",
      },
      execute: async (): Promise<ToolResultLike> => {
        const status = await apps.connectedToolkits();
        return text(describeStatus(status, apps.allToolkits));
      },
    },
  };
}

const CONNECT_PARAMS = Type.Object({
  toolkit: Type.String({
    description: "Toolkit slug, lowercase, for example gmail, notion, slack, github, linear, hubspot.",
  }),
});

function connectTool({ apps }: AppsToolDeps): RegisteredTool {
  const spec: ToolSpec<typeof CONNECT_PARAMS> = {
    name: "apps_connect",
    label: "Connect an app",
    description:
      "Get the sign-in link that connects one app (a Composio toolkit such as gmail, googlecalendar, notion, slack, github) for the owner. Send the link to the owner; they open it and sign in. Owner only.",
    parameters: CONNECT_PARAMS,
    meta: {
      capabilities: [...APPS_MANAGE],
      group: "apps",
      describe: (args) => `connect app ${slugOf(args)}`,
    },
    execute: async (args, ctx: ToolContext): Promise<ToolResultLike> => {
      if (ctx.principal.kind !== "owner") return error("Only the owner can connect apps. Offer to tell the owner instead.");
      const slug = args.toolkit.trim().toLowerCase();
      if (!TOOLKIT_SLUG.test(slug))
        return error(`"${args.toolkit}" is not a toolkit slug. Use lowercase letters, digits, _ or -, for example notion or googlecalendar.`);
      if (!apps.allToolkits && !apps.toolkitSlugs.includes(slug)) {
        return error(
          `${slug} is not in this agent's toolkit list (${apps.toolkitSlugs.join(", ")}). The deployer can add it with COMPOSIO_TOOLKITS=${[...apps.toolkitSlugs, slug].join(",")} or allow every app with COMPOSIO_TOOLKITS=all.`,
        );
      }
      const link = await apps.connectLink(slug);
      if (!link) return text(`${slug} needs no sign-in. It is ready to use.`);
      return text(`Send the owner this link to connect ${slug}. It opens a sign-in page; nothing is typed into the chat.\n${link}`);
    },
  };
  return { spec };
}

/** Plain lines for the model: connected, not connected, and how to get more. */
export function describeStatus(status: ToolkitStatus[], anyApp: boolean): string {
  const on = status.filter((s) => s.connected).map((s) => s.slug);
  const off = status.filter((s) => !s.connected).map((s) => s.slug);
  const lines: string[] = [];
  lines.push(on.length > 0 ? `Connected: ${on.join(", ")}.` : "Connected: none yet.");
  if (off.length > 0) lines.push(`Configured but not connected: ${off.join(", ")}. Use apps_connect to get a sign-in link.`);
  if (anyApp) {
    lines.push("Any app Composio supports can be connected by name with apps_connect, then found with app_composio_search_tools.");
  } else if (off.length === 0) {
    lines.push("Other apps need the deployer to add them to COMPOSIO_TOOLKITS, or COMPOSIO_TOOLKITS=all for any app.");
  }
  return lines.join("\n");
}

function slugOf(args: unknown): string {
  const t = (args as { toolkit?: unknown } | undefined)?.toolkit;
  return typeof t === "string" ? t.trim().toLowerCase() : "?";
}

function text(value: string): ToolResultLike {
  return { content: [{ type: "text", text: value }] };
}

function error(value: string): ToolResultLike {
  return { content: [{ type: "text", text: value }], isError: true };
}
