import { describe, expect, it } from "vitest";
import { ANY, LOOPBACK, bindHostFor } from "../src/bind.js";

describe("bindHostFor", () => {
  it("is loopback for a bare local run", () => {
    expect(bindHostFor({})).toBe(LOOPBACK);
    expect(bindHostFor({ INSTINCT_TUNNEL: "1", INKBOX_API_KEY: "k" })).toBe(LOOPBACK);
    expect(bindHostFor({ PORT: "  " })).toBe(LOOPBACK);
  });

  it("is 0.0.0.0 when PORT or a Maritime variable says this is a container", () => {
    expect(bindHostFor({ PORT: "8080" })).toBe(ANY);
    expect(bindHostFor({ MARITIME_AGENT_ID: "agent_1" })).toBe(ANY);
    expect(bindHostFor({ MARITIME_BACKEND_URL: "https://api.maritime.sh" })).toBe(ANY);
    expect(bindHostFor({ MARITIME_DESKTOP: "1" })).toBe(ANY);
  });

  it("INSTINCT_BIND wins", () => {
    expect(bindHostFor({ INSTINCT_BIND: "10.0.0.5", PORT: "8080" })).toBe("10.0.0.5");
    expect(bindHostFor({ INSTINCT_BIND: "127.0.0.1", MARITIME_AGENT_ID: "a" })).toBe(LOOPBACK);
  });
});
