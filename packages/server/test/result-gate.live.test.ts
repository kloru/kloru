/**
 * The result gate on invented finished work, each with the check its family would want. Runs only with
 * OPENROUTER_API_KEY:  OPENROUTER_API_KEY=… npx vitest run test/result-gate.live.test.ts
 */
import type { ResultCheck } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { resultGate } from "../src/result-gate.js";

const key = process.env.OPENROUTER_API_KEY;
const c = (request: string, doneWhen: string, result: string, changed: string, ledger: string[] = []): ResultCheck => ({ request, goal: request, doneWhen, deliverable: "app", result, changed, ledger });

// [name, what the gate sees, checks the family would accept]
const CASES: Array<[string, ResultCheck, Array<"none" | "tried">]> = [
  ["a new app", c("Make us a shared grocery list", "we can add, tick and remove items on a phone", "Built the list with add, tick and remove.", 'app "Groceries": new, 140 lines'), ["tried"]],
  ["a new app with several parts", c("An app where the kids log chores, earn points, and we approve them", "kids log chores; parents approve; points total per child", "Built logging, approvals and a points view.", 'app "Chores": new, 620 lines'), ["tried"]],
  ["a title change", c("Call the list Shopping", "the title reads Shopping", "Renamed it.", 'app "Groceries": version 4 → 5, 2 of 140 lines changed'), ["none"]],
  ["a color change", c("Make the chores app header green", "the header is green", "Changed the header color.", 'app "Chores": version 7 → 8, 1 of 620 lines changed'), ["none"]],
  ["a label's wording", c("Change 'Submit' to 'Add' on the list", "the button says Add", "Changed the button label.", 'app "Groceries": version 5 → 6, 2 of 140 lines changed'), ["none"]],
  ["a typo fixed", c("There's a typo: 'Grocries'", "the heading is spelled Groceries", "Fixed the spelling.", 'app "Groceries": version 6 → 7, 2 of 140 lines changed'), ["none"]],
  ["a new field with sorting", c("Add a due date to each chore and sort by it", "chores have a due date and sort by it", "Added due dates and sorting.", 'app "Chores": version 8 → 9, 48 of 660 lines changed'), ["tried"]],
  ["how data is kept changes", c("Make lists per store and remember each item's aisle, keeping what's there", "lists are per store; items show their aisle; old items are still there", "Reworked the lists and moved the 140 existing items over.", 'app "Groceries": version 9 → 10, 310 of 420 lines changed'), ["tried"]],
  ["a bug fix in saving", c("Removed items come back when I reload", "a removed item stays removed after a reload", "Fixed: remove now saves.", 'app "Groceries": version 7 → 8, 6 of 140 lines changed'), ["tried"]],
  ["a new button that does something", c("Add a 'clear ticked' button", "one tap removes every ticked item", "Added the button.", 'app "Groceries": version 8 → 9, 14 of 150 lines changed'), ["tried"]],
  ["sign-in added", c("Only our family should be able to edit the list", "visitors can look; only the family can change it", "Visitors are now read-only.", 'app "Groceries": version 10 → 11, 9 of 420 lines changed'), ["tried"]],
  ["bigger text", c("The text is too small on my phone", "the list is easy to read on a phone", "Raised the font size.", 'app "Groceries": version 11 → 12, 3 of 420 lines changed'), ["none", "tried"]],
  ["a small change the engineer calls risky", c("Rename the 'items' list to 'things' everywhere", "it says things, and nothing is lost", "Renamed the label and the stored collection; old entries may need moving.", 'app "Groceries": version 12 → 13, 11 of 420 lines changed'), ["tried"]],
  ["an emoji in the heading", c("Put a cart emoji next to the title", "the title has a cart emoji", "Added it.", 'app "Groceries": version 13 → 14, 2 of 420 lines changed'), ["none"]],
];

describe.skipIf(!key)("the result gate, on Jev", () => {
  const gate = resultGate({ apiKey: key ?? "", timeoutMs: 10_000 });
  it.each(CASES)("%s", async (_name, check, accepted) => {
    const d = await gate(check);
    expect(accepted, `chose ${d.check} at ${d.p}`).toContain(d.check);
  });
});
