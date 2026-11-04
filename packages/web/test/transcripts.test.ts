import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTranscript } from "../src/transcripts.js";

const SID = "CA341913eaade29d7559d4762f3287d05e";

describe("call transcripts", () => {
  it("finds a call's transcript in its day directory and skips bad lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "tx-"));
    mkdirSync(join(dir, "2026-10-27"));
    writeFileSync(join(dir, "2026-10-27", `${SID}.jsonl`), [
      JSON.stringify({ at: "2026-10-27T22:42:33Z", kind: "call_started", call_sid: SID, from: "+14155550190" }),
      JSON.stringify({ at: "2026-10-27T22:42:36Z", kind: "caller", text: "What's Wednesday look like?" }),
      "oops",
      JSON.stringify({ at: "2026-10-27T22:42:37Z", kind: "task_started", task: 1, request: "Check all calendars for Oct 28", size: "quick" }),
    ].join("\n"));
    const t = readTranscript(dir, SID)!;
    expect(t.map((e) => e.kind)).toEqual(["call_started", "caller", "task_started"]);
    expect(t[1]!.text).toBe("What's Wednesday look like?");
  });

  it("rejects anything that isn't a Twilio call id, and a missing call is undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "tx-"));
    expect(readTranscript(dir, "../../etc/passwd")).toBeUndefined();
    expect(readTranscript(dir, "CA00000000spooftest-ratingC")).toBeUndefined();
    expect(readTranscript(dir, SID)).toBeUndefined();
    expect(readTranscript("/nonexistent", SID)).toBeUndefined();
  });
});
