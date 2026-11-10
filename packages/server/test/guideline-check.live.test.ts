/**
 * Jev on what's a guideline. Runs only with OPENROUTER_API_KEY:
 *   OPENROUTER_API_KEY=… npx vitest run test/guideline-check.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { guidelineCheck } from "../src/guideline-check.js";

const key = process.env.OPENROUTER_API_KEY;
const CASES: Array<[string, boolean]> = [
  ["Be more concise with all of your messages and writing", true],
  ["Prefers to be texted, not emailed, unless he asks", true],
  ["Always ask me before spending money", true],
  ["Don't recap work I already know about", true],
  ["Cleo's birthday is March 3", false],
  ["Ezra prefers Uber over rental cars in Tucson", false],
  ["Parks at SFO long-term parking", false],
];

describe.skipIf(!key)("is it a guideline? (Jev, live)", () => {
  const check = guidelineCheck({ apiKey: key ?? "", timeoutMs: 8000 });
  for (const [text, want] of CASES) it(text, async () => expect(await check(text)).toBe(want), 15_000);
});
