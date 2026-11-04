import { describe, expect, it } from "vitest";
import { clampMember, DELEGABLE, memberPolicy } from "../src/member-policy.js";

function fakeFetch(content: unknown, seen: any[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  }) as typeof fetch;
}

const WORDS = "Add my wife Cara, 415 555 0191, she should be able to do and see everything";

describe("Evan's words become a membership", () => {
  it("code keeps out what no member may hold, whatever the model says, and the read-back says so", () => {
    const plan = clampMember({ who: "person", name: "Cara", phone: "415 555 0191", email: "", tier: "partner", capabilities: ["email.read", "trust.manage", "computer.use"], read_back: "Cara, 4 1 5, 5 5 5, 0 1 9 1, as your partner. Okay?" }, WORDS);
    expect(plan).toMatchObject({ name: "Cara", phone: "+14155550191", tier: "partner", capabilities: ["email.read"], leftOut: ["trust.manage", "computer.use"], words: WORDS });
    expect(plan.readBack).toContain("0 1 9 1");
    expect(plan.readBack).toMatch(/only you/);
  });

  it("anyone who calls: no number needed, and never their email, contacts or money, whatever the words", () => {
    const plan = clampMember({ who: "anyone", name: "", phone: "", email: "", tier: "friend", capabilities: ["calendar.freebusy", "calendar.write", "email.read", "purchase"], read_back: "Anyone who calls can book time with you. Okay?" }, "Anyone who calls my number can schedule a meeting with me");
    expect(plan).toMatchObject({ who: "anyone", capabilities: ["calendar.freebusy", "calendar.write"], leftOut: ["email.read", "purchase"] });
    expect(plan.readBack).toMatch(/only you/);
  });

  it("the number Evan hears is the number that's saved, said by code, whatever the model wrote", () => {
    const plan = clampMember({ who: "person", name: "Cara", phone: "415 555 0191", email: "", tier: "partner", capabilities: [], read_back: "Cara, 2 6 7, 6 1 4, 3 0 1 8, as your partner: she can see your calendar. Okay?" }, "");
    expect(plan.readBack).toContain("4 1 5, 5 5 5, 0 1 9 1");
    expect(plan.readBack).not.toContain("3 0 1 8");
    expect(plan.readBack).toContain("she can see your calendar");
  });

  it("never the owner's say unless the owner's own words make them a co-owner", () => {
    expect(clampMember({ who: "person", name: "X", phone: "4155550100", email: "", tier: "owner", capabilities: [], read_back: "x" }, "she can see everything").tier).toBe("partner");
    const co = clampMember({ who: "person", name: "Cara", phone: "4155550191", email: "", tier: "owner", capabilities: [], read_back: "x" }, "make Cara a co-owner, the same as me");
    expect(co.tier).toBe("owner");
    expect(co.readBack).toMatch(/co-owner/);
  });

  it("a number that isn't a full phone number is refused, not guessed", () => {
    expect(() => clampMember({ who: "person", name: "Cara", phone: "614 3017", email: "", tier: "partner", capabilities: [], read_back: "x" }, "")).toThrow(/number/);
  });

  it("nothing that runs a shell, changes trust, or dials is delegable", () => {
    for (const c of ["computer.use", "files.read", "files.write", "trust.manage", "memory.write", "schedule.manage", "network.invite", "phone.call"]) expect(DELEGABLE).not.toContain(c);
    expect(DELEGABLE).toEqual(expect.arrayContaining(["email.read", "email.send", "calendar.write", "purchase"]));
  });

  it("the model gets the words verbatim, the people already in the family, and a strict schema", async () => {
    const seen: any[] = [];
    const plan = await memberPolicy({ apiKey: "k", members: () => "Cara (+14155550191), partner: email.read", fetchImpl: fakeFetch({ who: "person", name: "Cara", phone: "+14155550191", email: "", tier: "partner", capabilities: ["calendar.read"], read_back: "Cara can see your calendar only. Okay?" }, seen) })("Cara shouldn't read my email");
    expect(plan.capabilities).toEqual(["calendar.read"]);
    const user = seen[0].messages[1].content as string;
    expect(user).toContain("Cara shouldn't read my email");
    expect(user).toContain("Cara (+14155550191), partner");
    expect(seen[0].response_format.json_schema.strict).toBe(true);
  });
});
