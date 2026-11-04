/**
 * Per-person voice preferences the voice service reads at the start of each call
 * (voice/prefs.py). "Help improve Kloru for everyone" is on unless a number is listed
 * in transcriptsOff, so everyone starts opted in and turning it off is one write.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normPhone } from "./store.js";

interface PrefsFile {
  version: 1;
  transcriptsOff: string[];
}

function load(path: string): PrefsFile {
  if (!existsSync(path)) return { version: 1, transcriptsOff: [] };
  const f = JSON.parse(readFileSync(path, "utf8")) as Partial<PrefsFile>;
  return { version: 1, transcriptsOff: Array.isArray(f.transcriptsOff) ? f.transcriptsOff : [] };
}

/** Whether this person's calls keep transcripts. Unreadable preferences count as off, matching the voice service. */
export function improveKloru(path: string, phone: string): boolean {
  try {
    return !load(path).transcriptsOff.includes(normPhone(phone));
  } catch {
    return false;
  }
}

/** Throws if the file can't be read, rather than overwrite other people's choices. */
export function setImproveKloru(path: string, phone: string, on: boolean): void {
  const f = load(path);
  const p = normPhone(phone);
  f.transcriptsOff = on ? f.transcriptsOff.filter((x) => x !== p) : [...new Set([...f.transcriptsOff, p])];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
