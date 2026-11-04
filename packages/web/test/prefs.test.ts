import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { improveKloru, setImproveKloru } from "../src/prefs.js";

describe("voice preferences", () => {
  it("help improve Kloru is on until someone turns it off, per phone number", () => {
    const file = join(mkdtempSync(join(tmpdir(), "prefs-")), "voice", "prefs.json");
    expect(improveKloru(file, "+14155550190")).toBe(true);
    setImproveKloru(file, "+1 (415) 555-0190", false);
    expect(improveKloru(file, "+14155550190")).toBe(false);
    expect(improveKloru(file, "+14155550100")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, transcriptsOff: ["+14155550190"] });
    setImproveKloru(file, "+14155550190", true);
    expect(improveKloru(file, "+14155550190")).toBe(true);
  });

  it("an unreadable file counts as off and is never silently overwritten", () => {
    const file = join(mkdtempSync(join(tmpdir(), "prefs-")), "prefs.json");
    writeFileSync(file, "{not json");
    expect(improveKloru(file, "+14155550190")).toBe(false);
    expect(() => setImproveKloru(file, "+14155550190", false)).toThrow();
  });
});
