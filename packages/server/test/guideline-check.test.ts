import { describe, expect, it } from "vitest";
import { guidelineCheck } from "../src/guideline-check.js";

describe("is this how they want Kloru to work? (Jev)", () => {
  it("asks Jev a yes/no and reads its probability", async () => {
    const seen: Array<Record<string, any>> = [];
    const check = guidelineCheck({ apiKey: "k", fetchImpl: (async (_u: string, init: RequestInit) => (seen.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ answers: { guideline: { type: "noul", noul: 0.93 } } })))) as unknown as typeof fetch });
    expect(await check("Be more concise in all messages")).toBe(true);
    expect(seen[0]!.model).toBe("typesafe/jev-1.14");
    expect(seen[0]!.questions.guideline.type).toBe("noul");
    expect(seen[0]!.state.what_they_said).toBe("Be more concise in all messages");
  });

  it("below even odds is no; a bad answer throws", async () => {
    const at = (noul: unknown) => guidelineCheck({ apiKey: "k", fetchImpl: (async () => new Response(JSON.stringify({ answers: { guideline: { type: "noul", noul } } }))) as unknown as typeof fetch });
    expect(await at(0.2)("Cara's birthday is March 3")).toBe(false);
    await expect(at("x")("y")).rejects.toThrow();
  });
});
