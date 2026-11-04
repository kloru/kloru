/**
 * Groceries (#34): a list becomes one Amazon Fresh or Whole Foods "shoppable recipe" link. The
 * page matches each item to a product at the owner's address and prices, with one button that
 * adds them all to the cart; the owner checks out. Built offline: no Amazon login or API.
 *
 * Tested 2026-10-27: the link is gzip(JSON) in unpadded base64url; an item whose unit Amazon
 * doesn't know is dropped without a word, so every unit is mapped here or the item goes by count.
 * A pinned product (asin) always lands at quantity 1.
 */
import { gzipSync } from "node:zlib";
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import type { Desk } from "./desk.js";

export type GroceryStore = "fresh" | "wholefoods";
export interface GroceryItem {
  name: string;
  amount: number;
  unit: string;
  asin?: string;
}

const STORES: Record<GroceryStore, { brand: string; name: string }> = {
  fresh: { brand: "Amazon Fresh", name: "Amazon Fresh" },
  wholefoods: { brand: "UFG Whole Foods", name: "Whole Foods" },
};

/** Words people use → Amazon's units (the ones that worked in testing), with a factor. */
const UNITS: Record<string, [string, number]> = {
  count: ["COUNT", 1], each: ["COUNT", 1], ea: ["COUNT", 1], ct: ["COUNT", 1], item: ["COUNT", 1], items: ["COUNT", 1], unit: ["COUNT", 1], "": ["COUNT", 1],
  dozen: ["COUNT", 12],
  lb: ["POUNDS", 1], lbs: ["POUNDS", 1], pound: ["POUNDS", 1], pounds: ["POUNDS", 1],
  oz: ["OUNCES", 1], ounce: ["OUNCES", 1], ounces: ["OUNCES", 1], "fl oz": ["OUNCES", 1], "fluid ounces": ["OUNCES", 1],
  gallon: ["GALLONS", 1], gallons: ["GALLONS", 1], gal: ["GALLONS", 1], "half gallon": ["GALLONS", 0.5],
  quart: ["QUARTS", 1], quarts: ["QUARTS", 1], qt: ["QUARTS", 1],
  pint: ["PINTS", 1], pints: ["PINTS", 1], pt: ["PINTS", 1],
};

export function groceryLink(items: GroceryItem[], store: GroceryStore): { url: string; notes: string[] } {
  const notes: string[] = [];
  const ingredients = items.map((i) => {
    const said = i.unit.trim().toLowerCase().replace(/\.$/, "");
    const known = UNITS[said];
    if (!known) notes.push(`${i.name}: "${i.unit}" isn't an Amazon unit, so it's ${i.amount} by count.`);
    const [unit, factor] = known ?? ["COUNT", 1];
    if (i.asin) notes.push(`${i.name}: a pinned product always lands at quantity 1; change it in the cart if you need more.`);
    return { name: i.name, quantityList: [{ unit, amount: Math.round(i.amount * factor * 100) / 100 }], ...(i.asin ? { asinOverride: i.asin } : {}) };
  });
  const enc = gzipSync(JSON.stringify({ ingredients })).toString("base64url");
  const id = Buffer.from(STORES[store].brand).toString("base64").replace(/=+$/, "");
  return { url: `https://www.amazon.com/afx/ingredients/landingencoded?almBrandId=${id}&encodedIngredients=${enc}`, notes };
}

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function groceryTools(desk: Desk): RegisteredTool[] {
  return [
    defineTool({
      name: "amazon_grocery_cart",
      label: "Make an Amazon grocery cart link",
      description:
        "Turn a grocery list into one Amazon Fresh or Whole Foods link: it shows each item matched at the owner's prices, and one button adds them all to their cart; they check out. Puts the link on a page (it goes in their email). Returns the page link and anything to fix.",
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            name: Type.String({ description: "plain product words, e.g. 'organic whole milk'" }),
            amount: Type.Number(),
            unit: Type.String({ description: "count, lb, oz, gallon, quart, pint or dozen" }),
            asin: Type.Optional(Type.String({ description: "an exact Amazon product id, if known" })),
          }),
        ),
        store: Type.Union([Type.Literal("fresh"), Type.Literal("wholefoods")], { description: "Whole Foods finds milk; Fresh doesn't" }),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ items, store }, ctx) => {
        const issue = /^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1];
        if (!issue) return failed("Only desk workers can make a grocery cart.");
        if (!items.length) return failed("The list is empty.");
        const { url, notes } = groceryLink(items, store);
        const name = STORES[store as GroceryStore].name;
        const markdown = [
          `# Groceries from ${name}`,
          `[Open the cart on Amazon](${url}): each item is matched at your prices; tap **Add selected items to cart**, then check out.`,
          "",
          ...items.map((i) => `- ${i.name}: ${i.amount} ${i.unit}`),
          ...(notes.length ? ["", "## Check these", ...notes.map((n) => `- ${n}`)] : []),
        ].join("\n");
        const page = desk.publishArtifact(Number(issue), `Groceries: ${name} cart`, markdown);
        if (!page.ok) return failed(page.error);
        return textResult(`Cart page: ${page.value.url}${notes.length ? `\nTo fix: ${notes.join(" ")}` : ""}\nPut the page link in your result; the owner checks out.`);
      },
    }),
  ];
}
