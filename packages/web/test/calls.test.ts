import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCalls } from "../src/calls.js";

const NOW = new Date("2026-10-27T20:00:00Z");
const line = (at: string, outcome: string, extra: Record<string, string> = {}) => JSON.stringify({ at, call_sid: `CA-${at}`, from: "+14155550190", verstat: "", outcome, ...extra });

describe("call log summary", () => {
  it("counts the last 7 days by outcome and lists the newest calls first", () => {
    const dir = mkdtempSync(join(tmpdir(), "calls-"));
    const file = join(dir, "calls.jsonl");
    writeFileSync(file, [
      line("2026-10-10T00:00:00Z", "connected"),
      line("2026-10-25T00:00:00Z", "connected"),
      line("2026-10-26T00:00:00Z", "hung_up_attestation", { verstat: "TN-Validation-Passed-C" }),
      "garbage",
      line("2026-10-27T19:00:00Z", "refused_unknown", { from: "+19995550000" }),
      line("2026-10-27T19:30:00Z", "bad_signature", { ip: "203.0.113.9" }),
    ].join("\n") + "\n");
    const s = readCalls(file, NOW);
    expect(s.week).toEqual({ connected: 1, hung_up_attestation: 1, refused_unknown: 1, bad_signature: 1 });
    expect(s.recent.map((c) => c.outcome)).toEqual(["bad_signature", "refused_unknown", "hung_up_attestation", "connected", "connected"]);
    expect(s.recent[0]!.ip).toBe("203.0.113.9");
  });

  it("a missing file is an empty log, and the list is capped", () => {
    expect(readCalls("/nonexistent/calls.jsonl", NOW)).toEqual({ week: { connected: 0, hung_up_attestation: 0, refused_unknown: 0, bad_signature: 0 }, recent: [] });
    const file = join(mkdtempSync(join(tmpdir(), "calls-")), "calls.jsonl");
    writeFileSync(file, Array.from({ length: 80 }, (_, i) => line(`2026-10-27T10:${String(i % 60).padStart(2, "0")}:00Z`, "connected")).join("\n"));
    expect(readCalls(file, NOW).recent).toHaveLength(50);
  });
});
