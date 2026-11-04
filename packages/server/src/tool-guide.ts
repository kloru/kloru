/**
 * The schemas of the app actions workers use most (#17), fetched from Composio and cached for a
 * day in the agent's state, so workers call them directly instead of searching first.
 */
import { READ_ACTIONS, WRITE_ACTIONS, fetchToolSchemas, renderToolGuide } from "@kloru/apps";
import type { StateDir } from "@kloru/core";

const FILE = "composio-tool-guide.json";
const DAY = 24 * 60 * 60 * 1000;

interface Cached {
  at: string;
  read: string;
  write: string;
}

export async function loadToolGuide(state: StateDir, apiKey: string, log: (m: string) => void, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ read: string; write: string } | undefined> {
  const cached = state.readJson<Cached | null>(FILE, null);
  if (cached && now.getTime() - Date.parse(cached.at) < DAY && cached.read) return { read: cached.read, write: cached.write };
  const [read, write] = await Promise.all([fetchToolSchemas(apiKey, READ_ACTIONS, fetchImpl), fetchToolSchemas(apiKey, WRITE_ACTIONS, fetchImpl)]);
  if (!read.length) {
    log("apps: couldn't fetch tool schemas; workers will discover tools as before");
    return cached ? { read: cached.read, write: cached.write } : undefined;
  }
  const guide = { read: renderToolGuide(read), write: renderToolGuide(write) };
  state.writeJson(FILE, { at: now.toISOString(), ...guide });
  log(`apps: preloaded ${read.length + write.length} tool schemas for workers`);
  return guide;
}
