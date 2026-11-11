import type { ResultCheck } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { resultGate } from "../src/result-gate.js";

const check: ResultCheck = {
  request: "Call the list Shopping",
  goal: "Rename the grocery app to Shopping",
  doneWhen: "the title reads Shopping",
  deliverable: "app",
  result: "Renamed.",
  changed: 'app "Groceries": version 4 → 5, 2 of 120 lines changed',
  ledger: [],
};

function fake(answers: unknown, seen: Array<{ url: string; body: Record<string, any> }> = [], status = 200): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers }), { status });
  }) as unknown as typeof fetch;
}
const answer = (choice: string, p: number) => ({ check: { type: "choice", choice, probabilities: { [choice]: p } } });

describe("the result gate on Jev", () => {
  it("asks Jev one choice, with the spec, the result and what changed", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    await resultGate({ apiKey: "k", fetchImpl: fake(answer("none", 0.9), seen) })(check);
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(seen[0]!.body).toMatchObject({ model: "typesafe/jev-1.14", provider: { zdr: true } });
    expect(Object.keys(seen[0]!.body.questions.check.criteria)).toEqual(["none", "tried", "unsure"]);
    expect(seen[0]!.body.state).toEqual({
      what_they_asked: "Call the list Shopping",
      spec: { goal: "Rename the grocery app to Shopping", done_when: "the title reads Shopping", deliverable: "app" },
      engineers_result: "Renamed.",
      what_changed: 'app "Groceries": version 4 → 5, 2 of 120 lines changed',
      changes_made_elsewhere: [],
    });
  });

  it("none only when Jev is sure; anything else means the app is tried", async () => {
    const gate = (a: unknown) => resultGate({ apiKey: "k", fetchImpl: fake(a) })(check);
    expect(await gate(answer("none", 0.9))).toEqual({ check: "none", p: 0.9 });
    expect(await gate(answer("none", 0.6))).toEqual({ check: "none", p: 0.6 });
    expect(await gate(answer("none", 0.59))).toEqual({ check: "tried", p: 0.59 });
    expect(await gate(answer("unsure", 0.7))).toEqual({ check: "tried", p: 0.7 });
    expect(await gate(answer("tried", 0.95))).toEqual({ check: "tried", p: 0.95 });
    expect(await gate({ check: { type: "choice", choice: "none" } })).toEqual({ check: "tried" });
  });

  it("throws on an error or an answer it can't read, so the desk falls back to trying", async () => {
    await expect(resultGate({ apiKey: "k", fetchImpl: fake({}, [], 503) })(check)).rejects.toThrow("decision model 503");
    await expect(resultGate({ apiKey: "k", fetchImpl: fake({ check: { type: "choice", choice: "ship_it" } }) })(check)).rejects.toThrow(/no check in/);
    await expect(resultGate({ apiKey: "k", fetchImpl: fake({}) })(check)).rejects.toThrow(/no check in/);
  });
});
