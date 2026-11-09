import { describe, expect, it } from "vitest";
import { eventGate, type GateInput } from "../src/event-gate.js";

const input: GateInput = { automation: "Email replies", request: "Draft a reply.", condition: "an email I need to answer", event: "New Gmail Message: {\"subject\": \"Dinner?\"}", guidelines: "" };

function fake(answers: unknown, seen: Array<Record<string, any>> = [], status = 200): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ answers }), { status });
  }) as unknown as typeof fetch;
}

describe("the quick check before an event automation runs", () => {
  it("asks run or skip with the condition, the event and their guidelines (none: said so)", async () => {
    const seen: Array<Record<string, any>> = [];
    await eventGate({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "run", probabilities: { run: 0.8 } } }, seen) })(input);
    expect(Object.keys(seen[0]!.questions.action.criteria)).toEqual(["run", "skip"]);
    expect(seen[0]!.state).toMatchObject({ runs_only_for: "an email I need to answer", their_guidelines: "(none)", event: input.event });
  });

  it("a sure skip skips; an unsure one runs, so nothing they asked for is missed", async () => {
    const sure = await eventGate({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "skip", probabilities: { skip: 0.9 } } }) })(input);
    expect(sure).toEqual({ run: false, p: 0.9 });
    const unsure = await eventGate({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "skip", probabilities: { skip: 0.55 } } }) })(input);
    expect(unsure.run).toBe(true);
  });

  it("throws on a failed or odd answer (the router runs it then)", async () => {
    await expect(eventGate({ apiKey: "k", fetchImpl: fake({}, [], 503) })(input)).rejects.toThrow(/503/);
    await expect(eventGate({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "maybe" } }) })(input)).rejects.toThrow(/no action/);
  });
});
