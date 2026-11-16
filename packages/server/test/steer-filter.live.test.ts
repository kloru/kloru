/**
 * Does the steering model tell a change to the request from waiting and small talk? Runs only with
 * OPENROUTER_API_KEY; TRY_MODELS="steer=<id>" tries another model (the model-selection skill):
 *   OPENROUTER_API_KEY=… npx vitest run test/steer-filter.live.test.ts
 */
import type { Issue } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { steerFilter } from "../src/steer-filter.js";

const key = process.env.OPENROUTER_API_KEY;

const WEATHER = "What's the weather in Tucson this weekend?";
const DINNER = "Book dinner for two on Friday at 7 somewhere Italian near home";
const CASES: Array<[string, string, boolean]> = [
  [WEATHER, "I'll just wait", false],
  [WEATHER, "Thanks, take your time", false],
  [WEATHER, "Actually make that Phoenix", true],
  [WEATHER, "And tell me if I need a jacket", true],
  [WEATHER, "What time is it?", false],
  [WEATHER, "Never mind, forget it", true],
  [DINNER, "Make it 7:30, and four of us", true],
  [DINNER, "Not sushi though, Cleo had it yesterday", true],
  [DINNER, "Okay, sounds good", false],
  [DINNER, "Can you also remind me to call my mom tomorrow?", false],
  [DINNER, "Is it still raining out?", false],
  [DINNER, "Somewhere with outdoor seating if you can", true],
];

describe.skipIf(!key)("steering, live", () => {
  const changes = steerFilter({ apiKey: key ?? "" });
  it.each(CASES)("%s / %s", async (request, said, want) => {
    expect(await changes({ request } as Issue, said)).toBe(want);
  }, 30_000);
});
