/**
 * Groceries (#34): a list becomes one Amazon Fresh or Whole Foods link that shows every item
 * matched at the owner's prices, with one "add to cart" button. Units Amazon would silently drop
 * are mapped or refused, never lost.
 */
import { gunzipSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type WorkerHost } from "../src/desk.js";
import { groceryLink, groceryTools } from "../src/groceries.js";

const decode = (url: string) => {
  const u = new URL(url);
  return { brand: Buffer.from(u.searchParams.get("almBrandId")!, "base64").toString(), list: JSON.parse(gunzipSync(Buffer.from(u.searchParams.get("encodedIngredients")!, "base64url")).toString()) };
};

describe("an Amazon grocery link", () => {
  it("encodes the list for the store, with units Amazon accepts", () => {
    const r = groceryLink([{ name: "bananas", amount: 4, unit: "each" }, { name: "chicken thighs", amount: 2, unit: "lb" }, { name: "eggs", amount: 1, unit: "dozen", asin: "B07EXAMPLE" }], "fresh");
    expect(r.url.startsWith("https://www.amazon.com/afx/ingredients/landingencoded?almBrandId=QW1hem9uIEZyZXNo&encodedIngredients=")).toBe(true);
    const { brand, list } = decode(r.url);
    expect(brand).toBe("Amazon Fresh");
    expect(list.ingredients).toEqual([
      { name: "bananas", quantityList: [{ unit: "COUNT", amount: 4 }] },
      { name: "chicken thighs", quantityList: [{ unit: "POUNDS", amount: 2 }] },
      { name: "eggs", quantityList: [{ unit: "COUNT", amount: 12 }], asinOverride: "B07EXAMPLE" },
    ]);
    expect(r.notes).toEqual(["eggs: a pinned product always lands at quantity 1; change it in the cart if you need more."]);
  });

  it("Whole Foods has its own store id; an item with a unit Amazon would drop goes in by count, and says so", () => {
    const r = groceryLink([{ name: "milk", amount: 64, unit: "fl oz" }, { name: "cereal", amount: 2, unit: "box" }], "wholefoods");
    const { brand, list } = decode(r.url);
    expect(brand).toBe("UFG Whole Foods");
    expect(list.ingredients[0]).toEqual({ name: "milk", quantityList: [{ unit: "OUNCES", amount: 64 }] });
    expect(list.ingredients[1]).toEqual({ name: "cereal", quantityList: [{ unit: "COUNT", amount: 2 }] });
    expect(r.notes).toContain('cereal: "box" isn\'t an Amazon unit, so it\'s 2 by count.');
  });
});

describe("the grocery tool", () => {
  it("puts the cart link on a page for the issue, so it reaches the owner's email", async () => {
    const host: WorkerHost = { run: () => new Promise(() => {}), steer: () => false, stop: () => {} };
    const planner: Planner = { handle: async () => {} };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "groc-")), host, planner });
    const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    const issue = desk.fileIssue(call.id, "Order groceries");
    const tool = groceryTools(desk)[0]!;
    const out = await tool.spec.execute({ items: [{ name: "bananas", amount: 6, unit: "count" }], store: "fresh" } as never, { conversationKey: `desk:issue:${issue.id}:engineer` } as never);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toMatch(/https:\/\/kloru\.com\/a\//);
    const page = desk.repo.artifacts()[0]!;
    expect(page.title).toBe("Groceries: Amazon Fresh cart");
    expect(page.markdown).toContain("amazon.com/afx/ingredients/landingencoded");
    expect(page.markdown).toContain("bananas");
  });
});
