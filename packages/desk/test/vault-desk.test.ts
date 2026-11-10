/** The ticket says what the vault holds for it: a worker knows which card and login to use, or how to get one. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type WorkerHost } from "../src/desk.js";
import { Vault } from "../src/vault.js";
import { vaultTools } from "../src/vault-tools.js";

class Host implements WorkerHost {
  prompts: string[] = [];
  roles: WorkerRole[] = [];
  run(_issue: number, role: WorkerRole, prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.roles.push(role);
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

const EZRA = "+14155550190";
const VAULT_URL = "https://kloru.com/vault";
const CARD = { number: "4242424242424242", exp: "12/29", cvc: "123" };

function setup(fill: (v: Vault) => void) {
  const root = mkdtempSync(join(tmpdir(), "vault-desk-"));
  const host = new Host();
  const desk = new Desk({ root, host, planner: { handle: async () => {} } as Planner, ownerPhone: EZRA, nameOf: (p) => (p === EZRA ? "Ezra" : undefined) });
  const vault = new Vault(join(root, "secrets", "vault.json"), Buffer.alloc(32, 5).toString("base64"));
  fill(vault);
  desk.useVault(vault, () => "Ezra", VAULT_URL);
  const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "sms" });
  const issue = desk.fileIssue(call.id, "Book SFO parking for my trip");
  desk.assign(issue.id, "work", "Book SFO long-term parking Nov 3-5 and pay with Ezra's card", []);
  return { desk, host, vault, issue: desk.repo.issue(issue.id)! };
}

describe("the vault on the ticket", () => {
  it("lists the cards and logins the request may use, by name and never by value", () => {
    const { host, issue } = setup((v) => {
      v.put({ name: "ezra-visa", owner: EZRA, kind: "card", meta: { brand: "Visa", limits: { perPurchaseUsd: 80 } }, secret: CARD, createdBy: EZRA });
      v.put({ name: "sfo-parking", owner: EZRA, kind: "login", meta: { site: "parking.flysfo.com", username: "ezra@example.com" }, secret: { password: "hunter2-very-secret" }, createdBy: EZRA });
    });
    const note = issue.thread.find((e) => e.by === "system" && /vault/i.test(e.text))?.text ?? "";
    expect(note).toContain("ezra-visa");
    expect(note).toContain("Visa ending 4242, at most $80 a purchase");
    expect(note).toContain("sfo-parking");
    expect(note).not.toMatch(/4242424242424242|hunter2/);
    expect(host.prompts.at(-1)).toContain("ezra-visa");
  });

  it("with no card saved, the ticket says where the person adds one", () => {
    const { issue } = setup((v) => v.put({ name: "sfo-parking", owner: EZRA, kind: "login", meta: { site: "parking.flysfo.com", username: "e" }, secret: { password: "hunter2-very-secret" }, createdBy: EZRA }));
    const note = issue.thread.find((e) => e.by === "system" && /vault/i.test(e.text))?.text ?? "";
    expect(note).toContain(VAULT_URL);
    expect(note).toMatch(/no card/i);
  });

  it("vault_list with nothing saved says where to add a card or login", async () => {
    const { desk, vault, issue } = setup(() => {});
    const list = vaultTools(desk, vault, () => "Ezra", VAULT_URL).find((t) => t.spec.name === "vault_list")!;
    const out = JSON.stringify(await list.spec.execute({}, { conversationKey: `desk:issue:${issue.id}:engineer` } as never));
    expect(out).toContain(VAULT_URL);
  });

  it("an owner's own request is the approval: it goes ahead, and the issue and ledger say who approved it (SFO parking, 2026-11-03)", async () => {
    const { desk, host, issue } = setup(() => {});
    const role = host.roles.at(-1)!;
    expect(await role.ownerApproval!({ toolName: "browser_pay", args: { card: "ezra-visa", total_usd: 78 }, summary: "Ezra wants purchase ($78)?" })).toEqual({ approved: true });
    const note = desk.repo.issue(issue.id)!.thread.find((e) => e.text.startsWith("Approved by"))?.text;
    expect(note).toMatch(/^Approved by Ezra: they asked for this \("Book SFO parking for my trip"\)\. Ezra wants purchase \(\$78\)\?/);
    expect(desk.repo.ledger(issue.id).find((e) => e.slug === "APPROVAL")).toMatchObject({ ok: true, tool: "browser_pay", decision: "approve" });
  });

  it("never pays more than the total they agreed to: $55.41 after a yes to $38.33 asks first (Lumos light, 2026-11-03)", async () => {
    const { desk, host, issue } = setup(() => {});
    desk.askForYes(issue.id, "Buy the lavender Lumos knitting light with BLACK30 for $38.33 shipped?");
    desk.confirm(issue.id, issue.filedBy.call, desk.repo.issue(issue.id)!.confirmation!.id);
    const role = host.roles.at(-1)!;
    const pay = (total: number) => role.ownerApproval!({ toolName: "browser_pay", args: { card: "ezra-visa", total_usd: total }, summary: `Ezra wants purchase ($${total})?` });
    expect(await pay(55.41)).toMatchObject({ block: true });
    expect(desk.repo.issue(issue.id)!.confirmation).toMatchObject({ draft: "The total is $55.41, more than the $38.33 you agreed to. Pay $55.41?" });
    expect(desk.repo.ledger(issue.id).some((e) => e.slug === "APPROVAL")).toBe(false);
    // Their yes to that exact payment covers it.
    desk.confirm(issue.id, issue.filedBy.call, desk.repo.issue(issue.id)!.confirmation!.id);
    expect(await pay(55.41)).toEqual({ approved: true });
  });

  it("a total within what they agreed to goes ahead", async () => {
    const { desk, host, issue } = setup(() => {});
    desk.askForYes(issue.id, "Buy it for $38.33 shipped?");
    desk.confirm(issue.id, issue.filedBy.call, desk.repo.issue(issue.id)!.confirmation!.id);
    expect(await host.roles.at(-1)!.ownerApproval!({ toolName: "browser_pay", args: { total_usd: 38.33 }, summary: "Ezra wants purchase ($38.33)?" })).toEqual({ approved: true });
  });
});
