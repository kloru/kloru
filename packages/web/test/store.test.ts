import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { FileStore, PgStore, type ConsoleStore } from "../src/store.js";

const makers: Array<[string, () => Promise<ConsoleStore>]> = [
  ["FileStore", async () => new FileStore(join(mkdtempSync(join(tmpdir(), "console-")), "data"))],
  ["PgStore", async () => PgStore.open(new PGlite())],
];

for (const [name, make] of makers) {
  describe(name, () => {
    it("keeps users and invites with normalized phones", async () => {
      const s = await make();
      expect(await s.users()).toEqual([]);
      await s.invite("(415) 555-0100", "+14155550190");
      const u = await s.upsertUser({ phone: "+1 415 555 0190", name: "Ezra" });
      expect(u.id).toMatch(/^u_[0-9a-f]{8}$/);
      expect(await s.isInvited("+14155550100")).toBe(true);
      expect((await s.invites())[0]).toMatchObject({ phone: "+14155550100", invitedBy: "+14155550190" });
      expect((await s.userByPhone("4155550190"))?.id).toBe(u.id);
      expect((await s.user(u.id))?.name).toBe("Ezra");
      expect(await s.user("u_missing")).toBeUndefined();
    });

    it("updates a user in place and keeps createdAt", async () => {
      const s = await make();
      const u = await s.upsertUser({ phone: "+14155550100" });
      const v = await s.upsertUser({ id: u.id, phone: u.phone, agent: { kind: "maritime", agentId: "ag_1" } });
      expect(v).toMatchObject({ id: u.id, createdAt: u.createdAt, agent: { kind: "maritime", agentId: "ag_1" } });
      expect(await s.users()).toHaveLength(1);
      expect((await s.upsertUser({ phone: "415-555-0100", name: "A" })).id).toBe(u.id);
      expect((await s.user(u.id))?.agent).toEqual({ kind: "maritime", agentId: "ag_1" });
    });

    it("re-inviting replaces, and removing works", async () => {
      const s = await make();
      await s.invite("+14155550100", "+14155550190");
      await s.invite("+14155550100", "+12125550199");
      expect(await s.invites()).toHaveLength(1);
      expect((await s.invites())[0]!.invitedBy).toBe("+12125550199");
      await s.removeInvite("(415) 555-0100");
      expect(await s.isInvited("+14155550100")).toBe(false);
    });
  });
}

describe("FileStore on disk", () => {
  it("writes 0600 and survives a reopen", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "console-")), "data");
    const u = await new FileStore(dir).upsertUser({ phone: "+14155550190" });
    expect(statSync(join(dir, "console.json")).mode & 0o777).toBe(0o600);
    expect((await new FileStore(dir).user(u.id))?.phone).toBe("+14155550190");
  });
});

describe("PgStore migrations", () => {
  it("are idempotent and can import a console.json", async () => {
    const db = new PGlite();
    await PgStore.open(db);
    const s = await PgStore.open(db);
    await s.importFile({ version: 1, users: [{ id: "u_12345678", phone: "+14155550190", createdAt: "2026-10-27T00:00:00.000Z", agent: { kind: "direct", url: "http://127.0.0.1:8080", tokenEnv: "T", secretEnv: "S" } }], invites: [{ phone: "+14155550100", invitedBy: "+14155550190", createdAt: "2026-10-27T00:00:00.000Z" }] });
    expect((await s.user("u_12345678"))?.agent).toMatchObject({ kind: "direct" });
    expect((await s.user("u_12345678"))?.createdAt).toBe("2026-10-27T00:00:00.000Z");
    expect(await s.isInvited("+14155550100")).toBe(true);
  });
});

describe("PgStore on a pool", () => {
  it("runs migrations on one dedicated connection and releases it", async () => {
    const db = new PGlite();
    const onClient: string[] = [];
    let released = 0;
    const pool = {
      query: async (sql: string, params?: unknown[]) => db.query(sql, params),
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => { onClient.push(sql.trim().split(/\s+/)[0]!.toLowerCase()); return db.query(sql, params); },
        release: () => { released++; },
      }),
    };
    const s = await PgStore.open(pool as never);
    expect(onClient).toContain("begin");
    expect(onClient).toContain("commit");
    expect(released).toBe(1);
    expect(await s.users()).toEqual([]);
  });
});
