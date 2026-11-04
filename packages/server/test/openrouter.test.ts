import { describe, expect, it } from "vitest";
import { chatCompletion } from "../src/openrouter.js";

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("one OpenRouter chat call (#22)", () => {
  it("a 429 waits for Retry-After (capped) and tries once more", async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = (async () => (++n === 1 ? new Response("{}", { status: 429, headers: { "Retry-After": "1" } }) : ok("hi"))) as unknown as typeof fetch;
    expect(await chatCompletion({ apiKey: "k", fetchImpl, sleep: async (ms) => void waits.push(ms) }, { model: "m", messages: [] })).toBe("hi");
    expect(n).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("a long Retry-After is capped so a caller isn't left waiting; a second failure throws", async () => {
    const waits: number[] = [];
    const fetchImpl = (async () => new Response("{}", { status: 503, headers: { "Retry-After": "60" } })) as unknown as typeof fetch;
    await expect(chatCompletion({ apiKey: "k", fetchImpl, sleep: async (ms) => void waits.push(ms) }, { model: "m", messages: [] })).rejects.toThrow(/model 503/);
    expect(waits).toEqual([2000]);
  });

  it("a 400 is not retried", async () => {
    let n = 0;
    const fetchImpl = (async () => (n++, new Response("{}", { status: 400 }))) as unknown as typeof fetch;
    await expect(chatCompletion({ apiKey: "k", fetchImpl, sleep: async () => {} }, { model: "m", messages: [] })).rejects.toThrow(/model 400/);
    expect(n).toBe(1);
  });
});
