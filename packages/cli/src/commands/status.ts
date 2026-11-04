/** `instinct status`: ask a running server who it is and print a short table. */
import { parse, str, type OptionSpec } from "../args.js";
import { table } from "../ansi.js";
import type { CliContext } from "../context.js";
import { fetchOf } from "../io.js";
import { DEFAULT_LOCAL_URL, localStatus } from "../local.js";

export const statusOptions: OptionSpec = {
  url: { type: "string" },
};

/** Flattens one level of nesting so `{ owner: { name } }` prints as `owner.name`. */
export function flattenStatus(value: Record<string, unknown>, prefix = ""): string[][] {
  const rows: string[][] = [];
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !prefix) {
      rows.push(...flattenStatus(v as Record<string, unknown>, key));
    } else if (Array.isArray(v)) {
      rows.push([key, v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ")]);
    } else if (v && typeof v === "object") {
      rows.push([key, JSON.stringify(v)]);
    } else {
      rows.push([key, String(v)]);
    }
  }
  return rows;
}

export async function runStatus(ctx: CliContext, argv: string[]): Promise<number> {
  const { values } = parse("status", argv, statusOptions);
  const url = str(values, "url") ?? DEFAULT_LOCAL_URL;
  const info = await localStatus(fetchOf(ctx.io), url, ctx.env.INSTINCT_CHAT_TOKEN);
  ctx.print(ctx.c.bold(`Kloru at ${url}`));
  ctx.print(table(flattenStatus(info)));
  return 0;
}
