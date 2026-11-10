import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContactStore, PolicyEngine, StateDir, defaultPolicy } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { appsUserFor, familyCallers, familyMembers, saveMember, standingOf } from "../src/boot.js";
import { DELEGABLE } from "../src/member-policy.js";

const CLEO = "+14155550191";
const plan = (capabilities: string[], words: string) => ({ who: "person" as const, name: "Cleo", phone: CLEO, tier: "partner" as const, capabilities: capabilities as never[], leftOut: [], readBack: "", words });

function setup() {
  const state = new StateDir(mkdtempSync(join(tmpdir(), "member-")));
  return { contacts: new ContactStore(state), policy: new PolicyEngine(defaultPolicy()) };
}

describe("saving what Ezra said yes to", () => {
  it("Cleo becomes a member who may call, with his words and the grants they gave", () => {
    const { contacts, policy } = setup();
    saveMember(plan(["email.read", "calendar.write"], "she can do and see everything"), contacts, policy);
    expect(familyCallers({ name: "Ezra", phones: ["+14155550190"] }, contacts)(CLEO)).toEqual({ allowed: true, name: "Cleo", tier: "partner" });
    const cleo = { kind: "contact" as const, id: "contact:cleo", tier: "partner" as const, displayName: "Cleo" };
    expect(policy.evaluate(cleo, { capabilities: ["email.read"], group: "apps" }, {}).outcome).toBe("allow");
    const line = familyMembers(contacts, policy);
    expect(line).toContain("Cleo (+14155550191), partner: email.read, calendar.write");
    expect(line).toContain('The owner said: "she can do and see everything"');
  });

  it("a co-owner calls as an owner, with no member grants (the owner's say covers everything)", () => {
    const { contacts, policy } = setup();
    saveMember(plan(["email.read"], "she can see everything"), contacts, policy);
    saveMember({ ...plan([], "make Cleo a co-owner"), tier: "owner" as never }, contacts, policy);
    expect(familyCallers({ name: "Ezra", phones: ["+14155550190"] }, contacts)(CLEO)).toEqual({ allowed: true, name: "Cleo", tier: "owner" });
    const c = contacts.findByPhone(CLEO)!;
    expect(policy.listGrants(`contact:${c.id}`).filter((g) => g.note === "member" || g.note === "member (not given)")).toEqual([]);
  });

  it("saying it again replaces what his earlier words gave, and keeps the newest words", () => {
    const { contacts, policy } = setup();
    saveMember(plan(["email.read", "calendar.write"], "everything"), contacts, policy);
    saveMember(plan(["calendar.write"], "not my email"), contacts, policy);
    const cleo = { kind: "contact" as const, id: "contact:cleo", tier: "partner" as const, displayName: "Cleo" };
    expect(policy.evaluate(cleo, { capabilities: ["email.read"], group: "apps" }, {}).outcome).toBe("deny");
    expect(policy.listGrants("contact:cleo").filter((g) => !g.deny)).toHaveLength(1);
    expect(contacts.findByPhone(CLEO)?.policy).toBe("not my email");
  });

  it("his words can also take away what her tier would give: 'only when I'm free' leaves no calendar or location", () => {
    const { contacts, policy } = setup();
    saveMember(plan(["calendar.freebusy"], "Cleo can see when I'm free, nothing else"), contacts, policy);
    const cleo = { kind: "contact" as const, id: "contact:cleo", tier: "partner" as const, displayName: "Cleo", contactId: "cleo" };
    const may = (cap: string) => policy.evaluate(cleo, { capabilities: [cap as never], group: "apps" }, {}).outcome;
    expect(may("calendar.freebusy")).toBe("allow");
    expect(may("calendar.read")).toBe("deny");
    expect(may("owner.location.exact")).toBe("deny");
    expect(may("apps.use")).toBe("allow"); // the plumbing to reach the calendar stays
    saveMember(plan(["calendar.freebusy", "calendar.read"], "she can see my calendar"), contacts, policy);
    expect(may("calendar.read")).toBe("allow");
  });

  it("other grants the owner made by hand are left alone", () => {
    const { contacts, policy } = setup();
    saveMember(plan([], "x"), contacts, policy);
    policy.addGrant({ to: "contact:cleo", capabilities: ["purchase"], note: "dinner this week" });
    saveMember(plan(["calendar.read"], "y"), contacts, policy);
    expect(policy.listGrants("contact:cleo").map((g) => g.note).sort()).toEqual(["dinner this week", "member", "member (not given)"]);
  });
});

describe("where someone stands before a change, for the read-back", () => {
  it("a stranger is nobody; a member has what his words gave; a co-owner has everything and is on the family list", () => {
    const { contacts, policy } = setup();
    expect(standingOf(CLEO, contacts, policy)).toBeUndefined();
    saveMember(plan(["email.read", "calendar.write"], "she can read my mail and add to my calendar"), contacts, policy);
    const member = standingOf(CLEO, contacts, policy)!;
    expect(member.tier).toBe("partner");
    expect(member.capabilities).toEqual(expect.arrayContaining(["email.read", "calendar.write"]));
    expect(member.capabilities).not.toContain("purchase");
    saveMember({ ...plan([], "make Cleo a co-owner"), tier: "owner" as never }, contacts, policy);
    expect(standingOf(CLEO, contacts, policy)).toEqual({ tier: "owner", capabilities: DELEGABLE });
    expect(familyMembers(contacts, policy)).toContain("Cleo (+14155550191), owner");
  });

  it("anyone who calls: what's open to the public now", () => {
    const { contacts, policy } = setup();
    expect(standingOf("", contacts, policy)).toEqual({ capabilities: [] });
    saveMember({ ...plan(["calendar.freebusy"], "anyone can see when I'm free"), who: "anyone" as const }, contacts, policy);
    expect(standingOf("", contacts, policy)).toEqual({ capabilities: ["calendar.freebusy"] });
  });
});

describe("anyone who calls", () => {
  const anyone = (capabilities: string[], words: string) => ({ who: "anyone" as const, name: "Anyone who calls", phone: "", tier: "friend" as const, capabilities: capabilities as never[], leftOut: [], readBack: "", words });

  it("off by default: an unknown number may not call; on, they may, as a stranger; off again, refused", () => {
    const { contacts, policy } = setup();
    const callers = familyCallers({ name: "Ezra", phones: ["+14155550190"] }, contacts, policy);
    expect(callers("+14155550123")).toEqual({ allowed: false });
    saveMember(anyone(["calendar.freebusy", "calendar.write"], "Anyone who calls can schedule a meeting with me"), contacts, policy);
    expect(callers("+14155550123")).toEqual({ allowed: true, tier: "stranger" });
    expect(policy.publicPolicy()?.words).toBe("Anyone who calls can schedule a meeting with me");
    expect(contacts.all()).toEqual([]); // nobody was added as a person
    saveMember(anyone([], "Turn that off"), contacts, policy);
    expect(callers("+14155550123")).toEqual({ allowed: false });
  });

  it("a known friend calls as themselves when it's on", () => {
    const { contacts, policy } = setup();
    contacts.upsert({ name: "Sam", phones: ["+14155550100"], tier: "friend" });
    saveMember(anyone(["calendar.freebusy"], "x"), contacts, policy);
    expect(familyCallers({ name: "Ezra", phones: ["+14155550190"] }, contacts, policy)("+14155550100")).toEqual({ allowed: true, name: "Sam", tier: "friend" });
  });
});

describe("whose apps Kloru uses", () => {
  it("the family's own handle, even when an Inkbox identity with another handle is added later", () => {
    expect(appsUserFor({ agent: { handle: "ezra-kloru" } } as never, { handle: "kloru-vegas" })).toBe("ezra-kloru");
    expect(appsUserFor({ agent: {} } as never, { handle: "kloru-vegas" })).toBe("kloru-vegas");
    expect(appsUserFor({ agent: {} } as never, undefined)).toBeUndefined();
  });
});
