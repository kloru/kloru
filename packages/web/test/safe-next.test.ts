import { describe, expect, it } from "vitest";
import { safeNext } from "../src/safe-next.js";

describe("safeNext", () => {
  it("keeps same-site paths with their query", () => {
    expect(safeNext("/connections/return?toolkit=gmail")).toBe("/connections/return?toolkit=gmail");
    expect(safeNext("/permissions")).toBe("/permissions");
  });
  it("drops anything that could leave the site", () => {
    for (const evil of ["/\t/evil.com", "/\r\n/evil.com", "/%09/evil.com", "/%5cevil.com", "//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "", undefined, null]) {
      expect(safeNext(evil)).toBe("/");
    }
  });
});
