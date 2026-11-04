import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContactStore, PolicyEngine, StateDir, defaultPolicy } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { appsUserFor, familyCallers, familyMembers, saveMember } from "../src/boot.js";

const CARA = "+14155550191";
const plan = (capabilities: string[], words: string) => ({ who: "person" as const, name: "Cara", phone: CARA, tier: "partner" as const, capabilities: capabilities as never[], leftOut: [], readBack: "", words });

function setup() {
  const state = new StateDir(mkdtempSync(join(tmpdir(), "member-")));
  return { contacts: new ContactStore(state), policy: new PolicyEngine(defaultPolicy()) };
}

describe("saving what Evan said yes to", () => {
  it("Cara becomes a member who may call, with his words and the grants they gave", () => {
    const { contacts, policy } = setup();
    saveMember(plan(["email.read", "calendar.write"], "she can do and see everything"), contacts, policy);
    expect(familyCallers({ name: "Evan", phones: ["+14155550190"] }, contacts)(CARA)).toEqual({ allowed: true, name: "Cara", tier: "partner" });
    const cara = { kind: "contact" as const, id: "contact:cara", tier: "partner" as const, displayName: "Cara" };
    expect(policy.evaluate(cara, { capabilities: ["email.read"], group: "apps" }, {}).outcome).toBe("allow");
    const line = familyMembers(contacts, policy);
    expect(line).toContain("Cara (+14155550191), partner: email.read, calendar.write");
    expect(line).toContain('The owner said: "she can do and see everything"');
  });

  it("a co-owner calls as an owner, with no member grants (the owner's say covers everything)", () => {
    const { contacts, policy } = setup();
    saveMember(plan(["email.read"], "she can see everything"), contacts, policy);
    saveMember({ ...plan([], "make Cara a co-owner"), tier: "owner" as never }, contacts, policy);
    expect(familyCallers({ name: "Evan", phones: ["+14155550190"] }, contacts)(CARA)).toEqual({ allowed: true, name: "Cara", tier: "owner" });
    const c = contacts.findByPhone(CARA)!;
    expect(policy.listGrants(`contact:${c.id}`).filter((g) => g.note === "member" || g.note === "member (not given)")).toEqual([]);
  });

  it("saying it again replaces what his earlier words gave, and keeps the newest words", () => {
    const { contacts, policy } = setup();
    saveMember(plan(["email.read", "calendar.write"], "everything"), contacts, policy);
    saveMember(plan(["calendar.write"], "not my email"), contacts, policy);
    const cara = { kind: "contact" as const, id: "contact:cara", tier: "partner" as const, displayName: "Cara" };
    expect(policy.evaluate(cara, { capabilities: ["email.read"], group: "apps" }, {}).outcome).toBe("deny");
    expect(policy.listGrants("contact:cara").filter((g) => !g.deny)).toHaveLength(1);
    expect(contacts.findByPhone(CARA)?.policy).toBe("not my email");
  });

  it("his words can also take away what her tier would give: 'only when I'm free' leaves no calendar or location", () => {
    const { contacts, policy } = setup();
    saveMember(plan(["calendar.freebusy"], "Cara can see when I'm free, nothing else"), contacts, policy);
    const cara = { kind: "contact" as const, id: "contact:cara", tier: "partner" as const, displayName: "Cara", contactId: "cara" };
    const may = (cap: string) => policy.evaluate(cara, { capabilities: [cap as never], group: "apps" }, {}).outcome;
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
    policy.addGrant({ to: "contact:cara", capabilities: ["purchase"], note: "dinner this week" });
    saveMember(plan(["calendar.read"], "y"), contacts, policy);
    expect(policy.listGrants("contact:cara").map((g) => g.note).sort()).toEqual(["dinner this week", "member", "member (not given)"]);
  });
});

describe("anyone who calls", () => {
  const anyone = (capabilities: string[], words: string) => ({ who: "anyone" as const, name: "Anyone who calls", phone: "", tier: "friend" as const, capabilities: capabilities as never[], leftOut: [], readBack: "", words });

  it("off by default: an unknown number may not call; on, they may, as a stranger; off again, refused", () => {
    const { contacts, policy } = setup();
    const callers = familyCallers({ name: "Evan", phones: ["+14155550190"] }, contacts, policy);
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
    expect(familyCallers({ name: "Evan", phones: ["+14155550190"] }, contacts, policy)("+14155550100")).toEqual({ allowed: true, name: "Sam", tier: "friend" });
  });
});

describe("whose apps Kloru uses", () => {
  it("the family's own handle, even when an Inkbox identity with another handle is added later", () => {
    expect(appsUserFor({ agent: { handle: "evan-kloru" } } as never, { handle: "kloru-marshalls" })).toBe("evan-kloru");
    expect(appsUserFor({ agent: {} } as never, { handle: "kloru-marshalls" })).toBe("kloru-marshalls");
    expect(appsUserFor({ agent: {} } as never, undefined)).toBeUndefined();
  });
});
