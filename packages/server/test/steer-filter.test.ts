import { describe, expect, it } from "vitest";
import { steerFilter } from "../src/steer-filter.js";

function model(changes: boolean) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ changes }) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

describe("does this caller line change the work?", () => {
  it("asks a structured yes/no about this issue's request and this line", async () => {
    const m = model(false);
    const filter = steerFilter({ apiKey: "k", fetchImpl: m.fetchImpl });
    expect(await filter({ request: "Weather in Oakland today", spec: "Look up today's forecast" } as never, "I'll just wait.")).toBe(false);
    const body = m.bodies[0]!;
    expect(body.model).toBe("google/gemini-3.5-flash-lite");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(JSON.stringify(body.messages)).toContain("Weather in Oakland today");
    expect(JSON.stringify(body.messages)).toContain("I'll just wait.");
  });

  it("a change comes back true", async () => {
    expect(await steerFilter({ apiKey: "k", fetchImpl: model(true).fetchImpl })({ request: "Weather today" } as never, "Actually, Friday")).toBe(true);
  });
});
