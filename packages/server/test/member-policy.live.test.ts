/**
 * Does the decision model turn the owner's words into the membership he meant? Runs only with OPENROUTER_API_KEY:
 *   OPENROUTER_API_KEY=… npx vitest run test/member-policy.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { memberPolicy } from "../src/member-policy.js";

const key = process.env.OPENROUTER_API_KEY;

const CASES: Array<[string, { tier?: string; phone: string; has?: string[]; lacks?: string[] }]> = [
  ["Add my wife Cara to the account, 415 555 0191. She should be able to do and see everything", { tier: "partner", phone: "+14155550191", has: ["email.read", "email.send", "calendar.write", "purchase", "travel.book"] }],
  ["Add my mom Linda at 415 555 0100. She can see my calendar but nothing else", { tier: "family", phone: "+14155550100", has: ["calendar.read"], lacks: ["email.read", "calendar.write", "purchase"] }],
  ["My sister Kate, 510 555 0199, can add things to my calendar and order groceries", { phone: "+15105550199", has: ["calendar.write", "purchase"], lacks: ["email.read", "email.send"] }],
];

const PUBLIC: Array<[string, string[], string[]]> = [
  ["Anyone who calls my number can schedule a meeting with me", ["calendar.write"], ["email.read", "purchase", "calendar.read"]],
  ["Turn off the public line, nobody else can use Kloru", [], []],
];

describe.skipIf(!key)("the public case, live", () => {
  it.each(PUBLIC)("%s", async (words, has, lacks) => {
    const plan = await memberPolicy({ apiKey: key!, members: () => "" })(words);
    expect(plan.who).toBe("anyone");
    for (const c of has) expect(plan.capabilities).toContain(c);
    for (const c of lacks) expect(plan.capabilities).not.toContain(c);
    if (!has.length) expect(plan.capabilities).toEqual([]);
    console.log(plan.readBack);
  }, 30_000);
});

describe.skipIf(!key)("member policy, live", () => {
  it.each(CASES)("%s", async (words, want) => {
    const plan = await memberPolicy({ apiKey: key!, members: () => "" })(words);
    if (want.tier) expect(plan.tier).toBe(want.tier);
    expect(plan.who).toBe("person");
    expect(plan.phone).toBe(want.phone);
    for (const c of want.has ?? []) expect(plan.capabilities).toContain(c);
    for (const c of want.lacks ?? []) expect(plan.capabilities).not.toContain(c);
    expect(plan.leftOut).toEqual([]);
    expect(plan.readBack.replace(/\D/g, "")).toContain(want.phone.slice(-4));
    console.log(plan.readBack);
  }, 30_000);
});
