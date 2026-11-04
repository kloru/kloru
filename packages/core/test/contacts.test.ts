import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { ContactStore, StaffNeedsAgentError, slugify } from "../src/contacts.js";
import { tempState } from "./helpers.js";

describe("slugify", () => {
  it("makes readable ids", () => {
    expect(slugify("Sam Lee")).toBe("sam-lee");
    expect(slugify("  Zoë  O'Brien ")).toBe("zoe-o-brien");
    expect(slugify("!!!")).toBe("contact");
  });
});

describe("ContactStore", () => {
  it("refuses the reserved agent handle \"owner\"", () => {
    const store = new ContactStore(tempState());
    expect(() => store.upsert({ name: "Impostor", agentHandle: "@Owner" })).toThrow(/reserved/);
    expect(store.all()).toHaveLength(0);
    expect(store.findByHandle("owner")).toBeUndefined();
  });

  it("creates contacts with slug ids, normalized addresses and a default tier", () => {
    const store = new ContactStore(tempState());
    const c = store.upsert({ name: "Sam Lee", phones: ["(415) 555-0199"], emails: ["Sam@Example.com"], agentHandle: "@Sam-Instinct" });
    expect(c.id).toBe("sam-lee");
    expect(c.tier).toBe("contact");
    expect(c.phones).toEqual(["+14155550199"]);
    expect(c.emails).toEqual(["sam@example.com"]);
    expect(c.agentHandle).toBe("sam-instinct");
    expect(Date.parse(c.createdAt)).not.toBeNaN();
    expect(store.all()).toHaveLength(1);
  });

  it("merges on shared phone, email or handle and keeps existing addresses", () => {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Sam Lee", phones: ["+14155550199"] });
    const merged = store.upsert({ name: "Samantha Lee", tier: "partner", phones: ["415-555-0199"], emails: ["sam@example.com"] });
    expect(merged.id).toBe("sam-lee");
    expect(merged.name).toBe("Samantha Lee");
    expect(merged.tier).toBe("partner");
    expect(merged.emails).toEqual(["sam@example.com"]);
    expect(store.all()).toHaveLength(1);
    const byHandle = store.upsert({ name: "Sam", agentHandle: "sam-bot" });
    expect(byHandle.id).toBe("sam");
    const again = store.upsert({ name: "Sam L.", agentHandle: "@SAM-BOT", notes: "met at MIT" });
    expect(again.id).toBe("sam");
    expect(again.notes).toBe("met at MIT");
    expect(store.all()).toHaveLength(2);
  });

  it("keeps the owner's own words about what a person may do, through a reload", () => {
    const state = tempState();
    const store = new ContactStore(state);
    const cara = store.upsert({ name: "Cara", phones: ["415 555 0191"], tier: "partner", policy: "She should be able to do and see everything" });
    expect(cara.policy).toBe("She should be able to do and see everything");
    const reloaded = new ContactStore(state);
    expect(reloaded.findByPhone("+14155550191")?.policy).toBe("She should be able to do and see everything");
    expect(store.upsert({ name: "Cara", phones: ["+14155550191"], policy: "Not my email" }).policy).toBe("Not my email");
  });

  it("merges by name when adding an address, and separates same-name people by explicit id", () => {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Alex Kim", phones: ["+12125550001"] });
    const merged = store.upsert({ name: "Alex Kim", emails: ["alex@example.com"] });
    expect(merged.id).toBe("alex-kim");
    expect(merged.phones).toEqual(["+12125550001"]);
    expect(merged.emails).toEqual(["alex@example.com"]);
    const other = store.upsert({ id: "alex-kim-work", name: "Alex Kim", phones: ["+12125550002"] });
    expect(other.id).toBe("alex-kim-work");
    expect(store.all()).toHaveLength(2);
    expect(store.findByPhone("+12125550002")?.id).toBe("alex-kim-work");
    expect(store.upsert({ id: "alex-kim-work", name: "Alex Kim (work)" }).name).toBe("Alex Kim (work)");
    expect(store.all()).toHaveLength(2);
  });

  it("finds by phone, email and handle regardless of formatting", () => {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Sam Lee", phones: ["+14155550199"], emails: ["sam@example.com"], agentHandle: "sam-instinct" });
    expect(store.findByPhone("415.555.0199")?.id).toBe("sam-lee");
    expect(store.findByPhone("+12125550000")).toBeUndefined();
    expect(store.findByEmail("SAM@EXAMPLE.COM")?.id).toBe("sam-lee");
    expect(store.findByHandle("@Sam-Instinct")?.id).toBe("sam-lee");
    expect(store.findByHandle("")).toBeUndefined();
    expect(store.get("sam-lee")?.name).toBe("Sam Lee");
    expect(store.get("nobody")).toBeUndefined();
  });

  it("searches names, notes, emails and phone digits", () => {
    const store = new ContactStore(tempState());
    store.upsert({ name: "Sam Lee", phones: ["+14155550199"], notes: "dentist" });
    store.upsert({ name: "Alex Kim", emails: ["alex@mit.edu"] });
    expect(store.search("sam").map((c) => c.id)).toEqual(["sam-lee"]);
    expect(store.search("DENTIST").map((c) => c.id)).toEqual(["sam-lee"]);
    expect(store.search("mit.edu").map((c) => c.id)).toEqual(["alex-kim"]);
    expect(store.search("555-0199").map((c) => c.id)).toEqual(["sam-lee"]);
    expect(store.search("")).toHaveLength(2);
    expect(store.search("zzz")).toHaveLength(0);
  });

  it("sets tiers, removes, and persists across instances", () => {
    const state = tempState();
    const store = new ContactStore(state);
    store.upsert({ name: "Sam Lee" });
    expect(store.setTier("sam-lee", "family")?.tier).toBe("family");
    expect(store.setTier("nobody", "family")).toBeUndefined();
    expect(new ContactStore(state).get("sam-lee")?.tier).toBe("family");
    expect(store.remove("sam-lee")).toBe(true);
    expect(store.remove("sam-lee")).toBe(false);
    expect(new ContactStore(state).all()).toHaveLength(0);
  });

  it("returns copies so callers cannot corrupt the store", () => {
    const store = new ContactStore(tempState());
    const c = store.upsert({ name: "Sam Lee" });
    c.tier = "owner";
    c.phones.push("+10000000000");
    expect(store.get("sam-lee")?.tier).toBe("contact");
    expect(store.get("sam-lee")?.phones).toEqual([]);
  });
});

describe("ContactStore reload", () => {
  it("sees a contacts.json written by someone else without a restart", async () => {
    const state = tempState();
    const store = new ContactStore(state);
    store.upsert({ name: "Sam Lee" });
    expect(store.all()).toHaveLength(1);
    // Another process (a host seeding a teammate) rewrites the file. Make sure the mtime moves.
    await new Promise((r) => setTimeout(r, 15));
    const now = new Date().toISOString();
    state.writeJson("contacts.json", [
      ...store.all(),
      { id: "research-bot", name: "Research", tier: "staff", phones: [], emails: [], agentHandle: "research-bot", createdAt: now, updatedAt: now },
    ]);
    expect(store.all()).toHaveLength(2);
    expect(store.findByHandle("research-bot")?.tier).toBe("staff");
    // Our own writes keep working and do not lose the external entry.
    store.setTier("sam-lee", "family");
    expect(new ContactStore(state).all().map((c) => c.id).sort()).toEqual(["research-bot", "sam-lee"]);
  });
});

describe("ContactStore staff tier", () => {
  it("refuses staff for a contact without an agent handle on every path, leaving the file unchanged", () => {
    const state = tempState();
    const store = new ContactStore(state);
    expect(() => store.upsert({ name: "Research", tier: "staff" })).toThrow(StaffNeedsAgentError);
    expect(() => store.upsert({ name: "Research", tier: "staff" })).toThrow(/only for agents/);
    expect(store.all()).toHaveLength(0);
    store.upsert({ name: "Sam Lee", tier: "friend", emails: ["sam@example.com"] });
    expect(() => store.setTier("sam-lee", "staff")).toThrow(StaffNeedsAgentError);
    expect(() => store.upsert({ name: "Sam Lee", tier: "staff" })).toThrow(StaffNeedsAgentError);
    expect(store.get("sam-lee")?.tier).toBe("friend");
    expect(new ContactStore(state).get("sam-lee")?.tier).toBe("friend");
  });

  it("allows staff once the contact has an agent handle, given now or earlier", () => {
    const store = new ContactStore(tempState());
    expect(store.upsert({ name: "Research", tier: "staff", agentHandle: "@Research-Bot" })).toMatchObject({ tier: "staff", agentHandle: "research-bot" });
    store.upsert({ name: "Ops", agentHandle: "ops-bot" });
    expect(store.setTier("ops", "staff")?.tier).toBe("staff");
    expect(store.upsert({ name: "Ops", tier: "staff" }).tier).toBe("staff");
  });
});

describe("ContactStore load safety", () => {
  const seed = (store: ContactStore) => {
    store.upsert({ name: "Sam Lee", tier: "partner", emails: ["sam@example.com"] });
    store.upsert({ name: "Alex Kim", tier: "friend" });
  };

  it("keeps the previous list when contacts.json stops parsing, and refuses to save until it is fixed", () => {
    const state = tempState();
    const warnings: string[] = [];
    const store = new ContactStore(state, { warn: (m) => warnings.push(m) });
    seed(store);
    expect(store.all()).toHaveLength(2);

    const broken = '[{"id": "sam-lee", "name": "Sam Lee", "tier": "partner",, }';
    fs.writeFileSync(state.path("contacts.json"), broken);
    expect(store.all().map((c) => c.id)).toEqual(["sam-lee", "alex-kim"]);
    expect(store.findByEmail("sam@example.com")?.tier).toBe("partner");
    expect(warnings.some((w) => w.includes("contacts.json could not be read"))).toBe(true);

    expect(() => store.upsert({ name: "New Person" })).toThrow(/could not be read.*not overwritten/);
    expect(() => store.setTier("alex-kim", "family")).toThrow(/could not be read/);
    expect(() => store.remove("alex-kim")).toThrow(/could not be read/);
    // The owner's broken file is untouched, so their edit is not lost either.
    expect(fs.readFileSync(state.path("contacts.json"), "utf8")).toBe(broken);
    // Repeated reads of the same broken file warn once, not on every lookup.
    store.all();
    expect(warnings.filter((w) => w.includes("could not be read"))).toHaveLength(1);

    // Fixing the file is picked up and unblocks saves.
    const now = new Date().toISOString();
    fs.writeFileSync(state.path("contacts.json"), JSON.stringify([{ id: "sam-lee", name: "Sam Lee", tier: "family", phones: [], emails: [], createdAt: now, updatedAt: now }]));
    expect(store.all().map((c) => c.id)).toEqual(["sam-lee"]);
    expect(store.upsert({ name: "New Person" }).id).toBe("new-person");
    expect(new ContactStore(state).all().map((c) => c.id)).toEqual(["sam-lee", "new-person"]);
  });

  it("refuses to save on a cold start with a malformed file instead of replacing it with one entry", () => {
    const state = tempState();
    fs.writeFileSync(state.path("contacts.json"), "{ not json");
    const store = new ContactStore(state, { warn: () => {} });
    expect(store.all()).toEqual([]);
    expect(() => store.upsert({ name: "Sam Lee" })).toThrow(/could not be read/);
    expect(fs.readFileSync(state.path("contacts.json"), "utf8")).toBe("{ not json");
  });

  it("treats a JSON value that is not an array as unreadable", () => {
    const state = tempState();
    const store = new ContactStore(state, { warn: () => {} });
    seed(store);
    fs.writeFileSync(state.path("contacts.json"), JSON.stringify({ contacts: [] }));
    expect(store.all()).toHaveLength(2);
    expect(() => store.upsert({ name: "X" })).toThrow(/expected a JSON array/);
  });

  it("validates each entry: missing address lists become [], unknown tiers become stranger, a co-owner stays owner, unusable entries are skipped", () => {
    const state = tempState();
    const warnings: string[] = [];
    fs.writeFileSync(
      state.path("contacts.json"),
      JSON.stringify([
        { id: "sam-lee", name: "Sam Lee", tier: "partner" },
        { id: "boss", name: "Boss", tier: "owner", phones: ["+14155550100"] },
        { id: "vip", name: "VIP", tier: "vip", emails: "vip@example.com", phones: [42, "+14155550111"] },
        { id: "bad-handle", name: "Bad Handle", tier: "friend", agentHandle: "@owner" },
        { name: "No Id" },
        "just a string",
        null,
      ]),
    );
    const store = new ContactStore(state, { warn: (m) => warnings.push(m) });
    expect(store.all().map((c) => c.id)).toEqual(["sam-lee", "boss", "vip", "bad-handle"]);
    expect(store.get("sam-lee")).toMatchObject({ tier: "partner", phones: [], emails: [] });
    // Lookups that walk phones and emails no longer crash on a hand-written entry.
    expect(store.findByPhone("+14155550199")).toBeUndefined();
    expect(store.findByEmail("nobody@example.com")).toBeUndefined();
    expect(store.search("sam")).toHaveLength(1);
    // A co-owner (Kloru's set_member, with an owner's yes) keeps her tier across a restart.
    expect(store.get("boss")?.tier).toBe("owner");
    expect(store.get("vip")).toMatchObject({ tier: "stranger", emails: [], phones: ["+14155550111"] });
    expect(store.get("bad-handle")?.agentHandle).toBeUndefined();
    expect(store.findByHandle("owner")).toBeUndefined();
    expect(warnings.filter((w) => w.includes("skipped entry"))).toHaveLength(3);
    // A valid load allows saves again.
    expect(store.setTier("sam-lee", "family")?.tier).toBe("family");
  });

  it("notices an external rewrite even when it lands within the same mtime tick as our own save", () => {
    const state = tempState();
    const store = new ContactStore(state);
    store.upsert({ name: "Sam Lee" });
    const file = state.path("contacts.json");
    // Pin our file to a whole-second mtime so another writer can match it exactly.
    const tick = 1_700_000_000;
    fs.utimesSync(file, tick, tick);
    expect(store.all().map((c) => c.id)).toEqual(["sam-lee"]);
    expect(fs.statSync(file).mtimeMs).toBe(tick * 1000);
    // Another writer replaces the file atomically within the same tick: only the inode and size differ.
    const now = new Date().toISOString();
    const tmp = `${file}.other`;
    fs.writeFileSync(tmp, JSON.stringify([...store.all(), { id: "ops", name: "Ops", tier: "friend", phones: [], emails: [], createdAt: now, updatedAt: now }]));
    fs.utimesSync(tmp, tick, tick);
    fs.renameSync(tmp, file);
    expect(fs.statSync(file).mtimeMs).toBe(tick * 1000);
    expect(store.all().map((c) => c.id)).toEqual(["sam-lee", "ops"]);
  });

  it("does not re-read the file after its own save", () => {
    const state = tempState();
    const store = new ContactStore(state);
    store.upsert({ name: "Sam Lee" });
    const spy = vi.spyOn(fs, "readFileSync");
    try {
      store.all();
      store.get("sam-lee");
      expect(spy.mock.calls.filter(([p]) => String(p).endsWith("contacts.json"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
