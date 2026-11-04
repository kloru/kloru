/**
 * Preloaded schemas for the app actions workers use on almost every issue (#17). Without them each
 * run starts with COMPOSIO_SEARCH_TOOLS and a schema fetch (a median 9 s, measured on #27). The
 * guide goes into worker prompts so they call these actions directly.
 */
export interface ToolSchema {
  slug: string;
  description?: string;
  input_parameters?: { properties?: Record<string, { type?: string; items?: { type?: string }; description?: string }>; required?: string[] };
}

/** The actions workers actually call (counted from production sessions, 2026-10-29). */
export const READ_ACTIONS = [
  "GMAIL_FETCH_EMAILS",
  "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS",
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_LIST_CALENDARS",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_FIND_EVENT",
];
export const WRITE_ACTIONS = [
  "GMAIL_MOVE_TO_TRASH",
  "GMAIL_BATCH_MODIFY_MESSAGES",
  "GMAIL_SEND_EMAIL",
  "GMAIL_CREATE_EMAIL_DRAFT",
  "GMAIL_REPLY_TO_THREAD",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_PATCH_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
];

export async function fetchToolSchemas(apiKey: string, slugs: string[], fetchImpl: typeof fetch = fetch): Promise<ToolSchema[]> {
  const out = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const res = await fetchImpl(`https://backend.composio.dev/api/v3/tools/${slug}?toolkit_versions=latest`, { headers: { "x-api-key": apiKey } });
        if (!res.ok) return undefined;
        const body = (await res.json()) as ToolSchema;
        return body.slug ? body : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return out.filter((s): s is ToolSchema => !!s);
}

const firstSentence = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim().split(/(?<=\.)\s/)[0] ?? "";
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** One line per action, one per parameter: name* (type) — short description. */
export function renderToolGuide(schemas: ToolSchema[]): string {
  return schemas
    .map((s) => {
      const props = s.input_parameters?.properties ?? {};
      const required = new Set(s.input_parameters?.required ?? []);
      const params = Object.entries(props).map(([name, p]) => {
        const type = p.type === "array" ? `${p.items?.type ?? "any"}[]` : (p.type ?? "any");
        return `  ${name}${required.has(name) ? "*" : ""} (${type})${p.description ? `: ${firstSentence(p.description, 90)}` : ""}`;
      });
      return [`${s.slug}: ${firstSentence(s.description ?? "", 110)}`, ...params].join("\n");
    })
    .join("\n");
}
