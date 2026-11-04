import { describe, expect, it } from "vitest";
import { makeConnectToken, readConnectToken } from "../src/connect-link.js";

const NOW = new Date("2026-10-30T02:00:00Z");

describe("connect links", () => {
  it("carry the member and the family that made them, signed", () => {
    const t = makeConnectToken("s", { person: "cara", name: "Cara", uid: "u1" }, NOW);
    expect(readConnectToken("s", t, NOW)).toEqual({ person: "cara", name: "Cara", uid: "u1" });
    expect(readConnectToken("other-secret", t, NOW)).toBeUndefined();
  });

  it("stop working after 7 days", () => {
    const t = makeConnectToken("s", { person: "cara", name: "Cara", uid: "u1" }, NOW);
    expect(readConnectToken("s", t, new Date(NOW.getTime() + 6.9 * 86_400_000))).toBeDefined();
    expect(readConnectToken("s", t, new Date(NOW.getTime() + 7.1 * 86_400_000))).toBeUndefined();
  });

  it("nonsense is undefined, never a throw", () => {
    for (const t of ["", "x", "a.b", "a.b.c", "%%%.zz"]) expect(readConnectToken("s", t, NOW)).toBeUndefined();
  });
});
