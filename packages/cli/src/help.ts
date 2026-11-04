/** Grouped help text. One line per command and one example each. */
import type { Palette } from "./ansi.js";

export interface HelpEntry {
  name: string;
  usage: string;
  summary: string;
  example: string;
  flags?: string[];
}

export interface HelpGroup {
  title: string;
  entries: HelpEntry[];
}

export const HELP_GROUPS: HelpGroup[] = [
  {
    title: "Set up",
    entries: [
      {
        name: "init",
        usage: "init --name <you> [--phone +1...] [--email ...] [--handle <handle>] [--model provider/id] [--apps] [--toolkits a,b]",
        summary: "Write config.json and, with INKBOX_ADMIN_API_KEY, provision the agent's iMessage identity.",
        example: 'instinct init --name "Maria" --phone +14155550100 --email maria@example.com --handle maria-instinct',
        flags: [
          "--timezone America/New_York",
          "--city \"San Francisco\"",
          "--agent-name \"Kloru\"",
          "--phone-number (also buy an SMS line)",
          "--skip-inkbox",
          "--use-existing (explicitly import an existing Inkbox identity instead of choosing a free handle)",
          "--rotate-signing-key (replace the identity's signing key; other receivers must use the new key)",
          "--apps / --no-apps (Composio apps; on by itself when COMPOSIO_API_KEY or COMPOSIO_TOOLKITS is in env)",
          "--toolkits gmail,googlecalendar,googlecontacts (also turns apps on)",
        ],
      },
      {
        name: "connect",
        usage: "connect",
        summary: "Print the router number and `connect @handle` text; save the QR to <dataDir>/connect-qr.png.",
        example: "instinct connect",
      },
    ],
  },
  {
    title: "Run",
    entries: [
      {
        name: "dev",
        usage: "dev [--port 8080] [--host 127.0.0.1] [--tunnel] [--quiet]",
        summary: "Run the agent server in this process. --tunnel opens an Inkbox tunnel so iMessage reaches it.",
        example: "instinct dev --port 8080 --tunnel",
      },
      {
        name: "chat",
        usage: 'chat "<message>" [--url http://127.0.0.1:8080] [--agent <maritimeAgentId>] [--conversation <id>]',
        summary: "Send one message to a running agent, locally or through api.maritime.sh. Local calls send INSTINCT_CHAT_TOKEN when set; --agent uses MARITIME_API_KEY.",
        example: 'instinct chat "what is on my calendar tomorrow"',
      },
      {
        name: "status",
        usage: "status [--url http://127.0.0.1:8080]",
        summary: "Show what a running server reports on GET /. Sends INSTINCT_CHAT_TOKEN when set.",
        example: "instinct status",
      },
    ],
  },
  {
    title: "Deploy",
    entries: [
      {
        name: "deploy",
        usage: "deploy --image ghcr.io/<you>/kloru-agent:<tag> [--name instinct-<handle>] [--idle 900] [--no-desktop] [--maritime-llm] [--model <id>] [--dry-run]",
        summary: "Create the Maritime agent (own microVM with a desktop) from a built image. Needs MARITIME_API_KEY.",
        example: "instinct deploy --image ghcr.io/you/kloru-agent:latest",
        flags: [
          "--maritime-llm (no model key of your own: Maritime injects its metered OpenAI-compatible proxy; INSTINCT_MODEL becomes openai-compatible/<model>)",
          "--model <id> (proxy model with --maritime-llm, default gpt-5.4 or INSTINCT_MARITIME_MODEL; otherwise overrides config.model.primary)",
          "LINK_CLIENT_ID, LINK_CLIENT_SECRET, LINK_REDIRECT_URI, STRIPE_PUBLISHABLE_KEY in env are copied into the agent when LINK_CLIENT_ID is set",
        ],
      },
    ],
  },
  {
    title: "Payments",
    entries: [
      {
        name: "payments",
        usage: "payments connect | status [--url http://127.0.0.1:8080]",
        summary: "Link the owner's Stripe Link wallet to the agent (prints the authorize URL) and show what is connected.",
        example: "instinct payments connect",
        flags: ["connect: asks the running server for GET /oauth/link/start, else builds the URL from LINK_CLIENT_ID and LINK_REDIRECT_URI", "status: GET /payments/status plus the local LINK_* configuration"],
      },
    ],
  },
  {
    title: "People and trust",
    entries: [
      {
        name: "invite",
        usage: "invite <name> --tier <tier> [--email x@y] [--phone +1...] [--handle <peer-handle>]",
        summary: "Add a person to the trusted network and create an Inkbox A2A invitation for their agent.",
        example: 'instinct invite "Sam Lee" --tier partner --email sam@example.com --handle sam-instinct',
      },
      {
        name: "trust",
        usage: "trust list | set <contact> <tier> | grant <contact> <cap,cap> [--until YYYY-MM-DD] [--max-usd N] [--purpose text] [--note text] | revoke <grantId>",
        summary: "Change tiers and scoped grants. Tiers: staff (agents only: needs an agent handle), partner, family, friend, contact, stranger.",
        example: 'instinct trust grant sam-lee calendar.write,plans.commit --until 2026-10-12 --max-usd 150 --note "dinner this week"',
      },
    ],
  },
  {
    title: "Customize",
    entries: [
      {
        name: "persona",
        usage: 'persona show | edit | set "<text>" | reset | path',
        summary: "Read or change <dataDir>/PERSONA.md: the agent's name, voice, texting style and limits.",
        example: 'instinct persona set "You are Pip. Dry wit, short sentences, never emojis."',
        flags: [
          "show: print the persona in effect (the file, or the built-in default before one exists)",
          "edit: open the file in $VISUAL or $EDITOR; without one, print the path",
          "reset: write the built-in default back",
          "config.json agent.persona (instinct init --agent-name sets the name) adds a one-line note on top of the file",
          "AGENTS.md next to PERSONA.md adds standing instructions; see docs/CUSTOMIZE.md",
        ],
      },
      {
        name: "prompt",
        usage: "prompt [--channel imessage|sms|email|chat|scheduled] [--layers] [--json] [--no-skills]",
        summary: "Print the system prompt your own conversation would get right now, built from the data dir.",
        example: "instinct prompt --layers",
        flags: ["--layers: one row per section with its source file instead of the full text", "--json: the sections as JSON", "--no-skills: leave out the skills index"],
      },
    ],
  },
  {
    title: "Proactive",
    entries: [
      {
        name: "schedules",
        usage: 'schedules list | add "<cron>" "<prompt>" [--tz Area/City] [--name ...] | add --at <iso> "<prompt>" | remove <id>',
        summary: "Cron or one-shot prompts the agent runs for you, delivered over iMessage.",
        example: 'instinct schedules add "0 8 * * 1-5" "Morning briefing: calendar, weather, top emails" --tz America/New_York',
      },
    ],
  },
];

export function renderHelp(c: Palette, command?: string): string {
  const lines: string[] = [];
  const entry = command ? HELP_GROUPS.flatMap((g) => g.entries).find((e) => e.name === command) : undefined;
  if (entry) {
    lines.push(c.bold(`instinct ${entry.usage}`));
    lines.push("");
    lines.push(`  ${entry.summary}`);
    if (entry.flags?.length) {
      lines.push("");
      lines.push("  More flags:");
      for (const f of entry.flags) lines.push(`    ${f}`);
    }
    lines.push("");
    lines.push(`  ${c.dim("example")}  ${entry.example}`);
    lines.push("");
    lines.push(c.dim("  Every command accepts --data-dir <dir> (default $INSTINCT_DATA_DIR or ./.instinct)."));
    return lines.join("\n");
  }
  lines.push(c.bold("instinct") + "  Kloru: a personal agent you text on iMessage, with its own computer.");
  lines.push("");
  lines.push("Usage: instinct <command> [options]   (add --help to any command)");
  lines.push("");
  for (const group of HELP_GROUPS) {
    lines.push(c.bold(group.title));
    const width = Math.max(...group.entries.map((e) => e.name.length));
    for (const e of group.entries) {
      lines.push(`  ${c.cyan(e.name.padEnd(width))}  ${e.summary}`);
      lines.push(`  ${" ".repeat(width)}  ${c.dim(e.example)}`);
    }
    lines.push("");
  }
  lines.push("Global: --data-dir <dir> (default $INSTINCT_DATA_DIR or ./.instinct), --help, --version");
  lines.push("");
  lines.push("Env: INSTINCT_DATA_DIR, INKBOX_ADMIN_API_KEY, MARITIME_API_KEY, ANTHROPIC_API_KEY, COMPOSIO_API_KEY, COMPOSIO_TOOLKITS, LINK_CLIENT_ID, EDITOR");
  lines.push("Customize the agent (persona, instructions, skills, memory, tiers): docs/CUSTOMIZE.md");
  return lines.join("\n");
}
