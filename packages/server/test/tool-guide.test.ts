import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { loadToolGuide } from "../src/tool-guide.js";

const schema = (slug: string) => ({ slug, description: `${slug} does a thing.`, input_parameters: { properties: { id: { type: "string" } }, required: ["id"] } });

describe("the worker tool guide (#17)", () => {
  it("fetches once and reuses the cached guide for a day", async () => {
    const state = new StateDir(mkdtempSync(join(tmpdir(), "guide-")));
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      return new Response(JSON.stringify(schema(/tools\/([A-Z_]+)/.exec(url)![1]!)), { status: 200 });
    }) as unknown as typeof fetch;
    const now = new Date("2026-10-29T08:00:00Z");
    const first = await loadToolGuide(state, "ck", () => {}, fetchImpl, now);
    expect(first!.read).toContain("GMAIL_FETCH_EMAILS: GMAIL_FETCH_EMAILS does a thing.");
    expect(first!.write).toContain("GOOGLECALENDAR_CREATE_EVENT");
    const fetched = calls;
    expect(await loadToolGuide(state, "ck", () => {}, fetchImpl, new Date("2026-10-29T20:00:00Z"))).toEqual(first);
    expect(calls).toBe(fetched);
    await loadToolGuide(state, "ck", () => {}, fetchImpl, new Date("2026-10-30T09:00:00Z"));
    expect(calls).toBe(fetched * 2);
  });

  it("if Composio can't be reached, workers simply discover as before", async () => {
    const state = new StateDir(mkdtempSync(join(tmpdir(), "guide-")));
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await loadToolGuide(state, "ck", () => {}, fetchImpl)).toBeUndefined();
  });
});
