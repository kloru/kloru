import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Vault, luhnNumbers } from "../src/vault.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const EZRA = "+14155550190";
const fresh = () => new Vault(join(mkdtempSync(join(tmpdir(), "vault-")), "secrets", "vault.json"), KEY);
const CARD = { number: "4242 4242 4242 4242", cvc: "123", exp: "12/29", name: "Ezra Vega", zip: "94105" };

describe("the vault", () => {
  it("keeps secrets encrypted on disk (0600) and shows only metadata", () => {
    const v = fresh();
    expect(v.put({ name: "ezra-credit-card", owner: EZRA, kind: "card", meta: { brand: "Visa", limits: { perPurchaseUsd: 100 } }, secret: CARD, createdBy: EZRA }).ok).toBe(true);
    const raw = readFileSync(v.file, "utf8");
    expect(raw).not.toContain("4242 4242");
    expect(raw).not.toContain("94105");
    expect(statSync(v.file).mode & 0o777).toBe(0o600);
    expect(v.list()).toEqual([expect.objectContaining({ name: "ezra-credit-card", kind: "card", meta: { brand: "Visa", last4: "4242", limits: { perPurchaseUsd: 100 } } })]);
    expect(JSON.stringify(v.list())).not.toContain("4242 4242");
  });

  it("references resolve at the last moment, only where allowed, and values scrub back to references", () => {
    const v = fresh();
    v.put({ name: "ezra-credit-card", owner: EZRA, kind: "card", meta: {}, secret: CARD, createdBy: EZRA });
    v.put({ name: "pge-login", owner: EZRA, kind: "login", meta: { site: "pge.com", username: "ezra@example.com" }, secret: { password: "hunter2-very-secret" }, createdBy: EZRA });
    expect(v.resolve("pw={{vault:pge-login.password}}", () => true)).toEqual({ ok: true, value: "pw=hunter2-very-secret" });
    expect(v.resolve("{{vault:pge-login.password}}", () => false).ok).toBe(false);
    expect(v.resolve("{{vault:nope.password}}", () => true).ok).toBe(false);
    const leaked = "card 4242424242424242 or 4242-4242-4242-4242 and hunter2-very-secret, at Suite 123";
    const clean = v.scrub(leaked);
    expect(clean).not.toMatch(/4242.?4242/);
    expect(clean).not.toContain("hunter2");
    expect(clean).toContain("{{vault:ezra-credit-card.number}}");
    expect(clean).toContain("{{vault:pge-login.password}}");
    expect(clean).toContain("Suite 123");
    expect(v.scrub("Welcome back, Ezra Vega")).toBe("Welcome back, Ezra Vega");
    expect(v.get("pge-login")?.usedAt).toBeDefined();
  });

  it("a login Kloru makes gets a password no model ever sees", () => {
    const v = fresh();
    const r = v.generateLogin({ name: "acme-login", owner: EZRA, site: "acme.com", username: "ezra@example.com", createdBy: "kloru" });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/password":/);
    expect(v.value("acme-login", "password")).toMatch(/^.{20,}$/);
  });

  it("refuses bad names and empty secrets; a wrong key can't open it", () => {
    const v = fresh();
    expect(v.put({ name: "Ezra Card", owner: EZRA, kind: "card", meta: {}, secret: CARD, createdBy: EZRA }).ok).toBe(false);
    expect(v.put({ name: "ezra-card", owner: EZRA, kind: "card", meta: {}, secret: {}, createdBy: EZRA }).ok).toBe(false);
    v.put({ name: "ezra-card", owner: EZRA, kind: "card", meta: {}, secret: CARD, createdBy: EZRA });
    const other = new Vault(v.file, Buffer.alloc(32, 9).toString("base64"));
    expect(() => other.value("ezra-card", "number")).toThrow();
    expect(() => new Vault(v.file, "short")).toThrow(/32 bytes/);
  });

  it("finds card numbers people type, and not phone numbers or dates", () => {
    expect(luhnNumbers("my card is 4242 4242 4242 4242 exp 12/29")).toEqual(["4242 4242 4242 4242"]);
    expect(luhnNumbers("call me at 415-555-0190 on 2026-11-03")).toEqual([]);
    expect(luhnNumbers("order 1234567890123")).toEqual([]);
  });
});
