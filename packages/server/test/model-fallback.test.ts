import { describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fallbackOf, withFallback } from "../src/model-fallback.js";

describe("the fallback model", () => {
  it("is the other vendor's", () => {
    expect(fallbackOf("openai/gpt-6-luna", {})).toBe("google/gemini-4-hydrogen");
    expect(fallbackOf("openai/gpt-6.1-terra", {})).toBe("google/gemini-4-hydrogen");
    expect(fallbackOf("google/gemini-4-hydrogen", {})).toBe("openai/gpt-6-luna");
  });

  it("can be set, or turned off", () => {
    expect(fallbackOf("openai/gpt-6-luna", { KLORU_FALLBACK_MODEL: "openrouter/openai/gpt-6.1-terra" })).toBe("openai/gpt-6.1-terra");
    expect(fallbackOf("openai/gpt-6.1-terra", { KLORU_FALLBACK_MODEL: "openai/gpt-6.1-terra" })).toBeUndefined();
    expect(fallbackOf("openai/gpt-6-luna", { KLORU_FALLBACK_MODEL: "off" })).toBeUndefined();
  });

  const fake = (responseModel?: string) => {
    const seen: { payload?: unknown; options?: unknown } = {};
    const streamFn = (async (model: unknown, _context: unknown, options: { onPayload?: (p: unknown, m: unknown) => unknown } | undefined) => {
      seen.options = options;
      seen.payload = (await options?.onPayload?.({ model: "openai/gpt-6-luna", provider: { zdr: true } }, model)) ?? undefined;
      return { result: async () => ({ ...(responseModel ? { responseModel } : {}) }) };
    }) as unknown as StreamFn;
    return { seen, streamFn };
  };
  const luna = { provider: "openrouter", id: "openai/gpt-6-luna" } as Parameters<StreamFn>[0];
  const context = {} as Parameters<StreamFn>[1];

  it("names both models on an OpenRouter turn and keeps the rest of the request", async () => {
    const { seen, streamFn } = fake();
    await withFallback(streamFn, { env: {} })(luna, context, { onPayload: (p) => ({ ...(p as object), seed: 1 }) });
    expect(seen.payload).toEqual({ model: "openai/gpt-6-luna", provider: { zdr: true }, seed: 1, models: ["openai/gpt-6-luna", "google/gemini-4-hydrogen"] });
  });

  it("leaves other providers' turns alone", async () => {
    const { seen, streamFn } = fake();
    await withFallback(streamFn, { env: {} })({ ...luna, provider: "faux" } as typeof luna, context, undefined);
    expect(seen.options).toBeUndefined();
  });

  it("logs a turn the fallback took, with dated ids too", async () => {
    const logs: string[] = [];
    await withFallback(fake("google/gemini-4-hydrogen-20261101").streamFn, { env: {}, log: (m) => logs.push(m) })(luna, context, undefined);
    await withFallback(fake("openai/gpt-6-luna-20261020").streamFn, { env: {}, log: (m) => logs.push(m) })(luna, context, undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(logs).toEqual(["model: openai/gpt-6-luna couldn't take a turn, google/gemini-4-hydrogen did"]);
  });
});
