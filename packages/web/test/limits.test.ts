import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/limits.js";

describe("RateLimiter", () => {
  it("allows up to the limit per key inside the window, then frees up", () => {
    let now = 0;
    const l = new RateLimiter(3, 60_000, () => now);
    expect([l.take("a"), l.take("a"), l.take("a"), l.take("a")]).toEqual([true, true, true, false]);
    expect(l.take("b")).toBe(true);
    now = 60_001;
    expect(l.take("a")).toBe(true);
  });
});
