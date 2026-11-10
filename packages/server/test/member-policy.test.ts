import { describe, expect, it } from "vitest";
import { clampMember, DELEGABLE, memberPolicy } from "../src/member-policy.js";

function fakeFetch(content: unknown, seen: any[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  }) as typeof fetch;
}

const WORDS = "Add my wife Cleo, 415 555 0191, she should be able to do and see everything";

describe("Ezra's words become a membership", () => {
  it("code keeps out what no member may hold, whatever the model says, and the read-back says so", () => {
    const plan = clampMember({ who: "person", name: "Cleo", phone: "415 555 0191", email: "", tier: "partner", capabilities: ["email.read", "trust.manage", "computer.use"] }, WORDS);
    expect(plan).toMatchObject({ name: "Cleo", phone: "+14155550191", tier: "partner", capabilities: ["email.read"], leftOut: ["trust.manage", "computer.use"], words: WORDS });
    expect(plan.readBack).toContain("0 1 9 1");
    expect(plan.readBack).toMatch(/only you/);
  });

  it("anyone who calls: no number needed, and never their email, contacts or money, whatever the words", () => {
    const plan = clampMember({ who: "anyone", name: "", phone: "", email: "", tier: "friend", capabilities: ["calendar.freebusy", "calendar.write", "email.read", "purchase"] }, "Anyone who calls my number can schedule a meeting with me");
    expect(plan).toMatchObject({ who: "anyone", capabilities: ["calendar.freebusy", "calendar.write"], leftOut: ["email.read", "purchase"] });
    expect(plan.readBack).toMatch(/only you/);
  });

  it("the number Ezra hears is the number that's saved, said by code, whatever the model wrote", () => {
    const plan = clampMember({ who: "person", name: "Cleo", phone: "415 555 0191", email: "", tier: "partner", capabilities: [] }, "");
    expect(plan.readBack).toContain("4 1 5, 5 5 5, 0 1 9 1");
    expect(plan.readBack).not.toContain("3 0 1 8");
    expect(plan.readBack).not.toContain("she can see your calendar");
  });

  it("the read-back says what they are now, what they'd become, and what they'd lose: lowering a co-owner (Nov 10, #698)", () => {
    const plan = clampMember({ who: "person", name: "Cleo", phone: "267 614 3017", email: "", tier: "friend", capabilities: ["apps.use"] }, "Yes, she can do everything.", { tier: "owner", capabilities: DELEGABLE });
    expect(plan.readBack).toBe("Cleo, 2 6 7, 6 1 4, 3 0 1 7: a co-owner now. This would lower Cleo to a friend. Cleo could: use your connected apps. Cleo would no longer be a co-owner, and would lose everything else. Okay?");
  });

  it("raising someone, adding someone new, and changing nothing are each said as plainly", () => {
    const raw = { who: "person", name: "Cleo", phone: "267 614 3017", email: "" };
    const up = clampMember({ ...raw, tier: "partner", capabilities: ["calendar.read", "email.read"] }, "", { tier: "friend", capabilities: ["calendar.read", "contacts.read"] });
    expect(up.readBack).toContain("a friend now. This would raise Cleo to your partner. Cleo could: see your calendar; read your email. Cleo would lose: see your contacts. Okay?");
    const added = clampMember({ ...raw, tier: "family", capabilities: DELEGABLE }, "");
    expect(added.readBack).toContain("not in the family yet. This would add Cleo as family. Cleo could: everything a family member can. Okay?");
    const co = clampMember({ ...raw, tier: "owner", capabilities: [] }, "make Cleo a co-owner", { tier: "partner", capabilities: [] });
    expect(co.readBack).toContain("your partner now. This would make Cleo a co-owner: the same say as you, over everything. Okay?");
    const same = clampMember({ ...raw, tier: "owner", capabilities: [] }, "make Cleo a co-owner", { tier: "owner", capabilities: DELEGABLE });
    expect(same.readBack).toContain("a co-owner now. Nothing would change. Okay?");
  });

  it("anyone who calls: the read-back says what's open now and what it would become", () => {
    const off = clampMember({ who: "anyone", name: "", phone: "", email: "", tier: "friend", capabilities: [] }, "turn that off", { capabilities: ["calendar.freebusy", "calendar.write"] });
    expect(off.readBack).toBe("Anyone who calls can now: see when you're free; add meetings to your calendar, or move and remove events. This would change it to: nothing, Kloru would be just for your family. Okay?");
  });

  it("never the owner's say unless the owner's own words make them a co-owner", () => {
    expect(clampMember({ who: "person", name: "X", phone: "4155550100", email: "", tier: "owner", capabilities: [] }, "she can see everything").tier).toBe("partner");
    const co = clampMember({ who: "person", name: "Cleo", phone: "4155550191", email: "", tier: "owner", capabilities: [] }, "make Cleo a co-owner, the same as me");
    expect(co.tier).toBe("owner");
    expect(co.readBack).toMatch(/co-owner/);
  });

  it("a number that isn't a full phone number is refused, not guessed", () => {
    expect(() => clampMember({ who: "person", name: "Cleo", phone: "614 3017", email: "", tier: "partner", capabilities: [] }, "")).toThrow(/number/);
  });

  it("nothing that runs a shell, changes trust, or dials is delegable", () => {
    for (const c of ["computer.use", "files.read", "files.write", "trust.manage", "memory.write", "schedule.manage", "network.invite", "phone.call"]) expect(DELEGABLE).not.toContain(c);
    expect(DELEGABLE).toEqual(expect.arrayContaining(["email.read", "email.send", "calendar.write", "purchase"]));
  });

  it("the model gets the words verbatim, the people already in the family, and a strict schema", async () => {
    const seen: any[] = [];
    const plan = await memberPolicy({ apiKey: "k", members: () => "Cleo (+14155550191), partner: email.read", fetchImpl: fakeFetch({ who: "person", name: "Cleo", phone: "+14155550191", email: "", tier: "partner", capabilities: ["calendar.read"] }, seen) })("Cleo shouldn't read my email");
    expect(plan.capabilities).toEqual(["calendar.read"]);
    const user = seen[0].messages[1].content as string;
    expect(user).toContain("Cleo shouldn't read my email");
    expect(user).toContain("Cleo (+14155550191), partner");
    expect(seen[0].response_format.json_schema.strict).toBe(true);
  });
});
