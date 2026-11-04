import type { AccessCheck } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { accessDecider } from "../src/access-decider.js";

const check: AccessCheck = {
  who: { name: "Cara", role: "member", phone: "+14155550191" },
  policies: { Evan: "- Cara can see and do everything, but not my work email." },
  guidelines: "",
  request: "can you put on my calendar tomorrow during day to replace backup tesla key?",
  spec: "Add 'Replace backup Tesla key' to Cara's calendar, Tue Nov 3 10-11 AM",
  needs: [
    { permission: "write_calendar", account: "theirs" },
    { permission: "read_mail", account: "Evan" },
  ],
};

function fake(answers: unknown, seen: Array<Record<string, any>>, status = 200): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ answers }), { status });
  }) as unknown as typeof fetch;
}

describe("the CISO's review on Jev", () => {
  it("one call, one question per need, with the owner's words and the spec in the state", async () => {
    const seen: Array<Record<string, any>> = [];
    const decide = accessDecider({ apiKey: "k", ownerName: "Evan", fetchImpl: fake({ need_0: { type: "choice", choice: "allow", probabilities: { allow: 0.93 } }, need_1: { type: "choice", choice: "ask_owner", probabilities: { ask_owner: 0.8 } } }, seen) });
    expect(await decide(check)).toEqual({ choices: ["allow", "ask_owner"], p: [0.93, 0.8] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe("typesafe/jev-1.14");
    expect(Object.keys(seen[0]!.questions)).toEqual(["need_0", "need_1"]);
    expect(Object.keys(seen[0]!.questions.need_0.criteria)).toEqual(["allow", "ask_owner", "deny"]);
    expect(seen[0]!.questions.need_0.instructions).toMatch(/Cara's own calendar/);
    expect(seen[0]!.questions.need_1.instructions).toMatch(/Evan's email/);
    expect(seen[0]!.questions.need_1.instructions).toMatch(/Evan's policy, in their words: "- Cara can see and do everything, but not my work email."/);
    expect(seen[0]!.state).toMatchObject({ policies_of_whose_things_these_are: { Evan: "- Cara can see and do everything, but not my work email." }, spec: check.spec });
  });

  it("a missing answer or an error status throws, so the desk sends it to an owner", async () => {
    await expect(accessDecider({ apiKey: "k", fetchImpl: fake({ need_0: { type: "choice", choice: "allow" } }, []) })(check)).rejects.toThrow(/need 1/);
    await expect(accessDecider({ apiKey: "k", fetchImpl: fake({}, [], 500) })(check)).rejects.toThrow(/500/);
  });
});
