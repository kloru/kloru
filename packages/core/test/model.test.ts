import { describe, expect, it } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER, modelSpecOf, resolveModel } from "../src/model.js";

describe("resolveModel", () => {
  it("resolves catalog models by provider/id", () => {
    const m = resolveModel("anthropic/claude-fable-5-1");
    expect(m.provider).toBe("anthropic");
    expect(m.id).toBe("claude-fable-5-1");
    expect(m.api).toBe("anthropic-messages");
    expect(modelSpecOf(m)).toBe("anthropic/claude-fable-5-1");
  });

  it("keeps slashes inside model ids", () => {
    const m = resolveModel("openrouter/anthropic/claude-sonnet-4.5");
    expect(m.provider).toBe("openrouter");
    expect(m.id).toBe("anthropic/claude-sonnet-4.5");
  });

  it("builds an OpenAI-compatible model from env without storing the key", () => {
    const m = resolveModel("openai-compatible/llama-3.3-70b", { OPENAI_BASE_URL: "http://localhost:11434/v1", OPENAI_API_KEY: "sk-secret" });
    expect(m.provider).toBe(OPENAI_COMPATIBLE_PROVIDER);
    expect(m.id).toBe("llama-3.3-70b");
    expect(m.api).toBe("openai-completions");
    expect(m.baseUrl).toBe("http://localhost:11434/v1");
    expect(JSON.stringify(m)).not.toContain("sk-secret");
  });

  it("requires OPENAI_BASE_URL for openai-compatible", () => {
    expect(() => resolveModel("openai-compatible/x", {})).toThrow(/OPENAI_BASE_URL/);
  });

  it("explains bad specs with examples", () => {
    expect(() => resolveModel("claude-fable-5-1")).toThrow(/provider\/model-id/);
    expect(() => resolveModel("nope/model")).toThrow(/unknown provider "nope"/);
    expect(() => resolveModel("anthropic/claude-99")).toThrow(/has no model "claude-99"/);
    expect(() => resolveModel("anthropic/claude-99")).toThrow(/anthropic\/claude-fable-5-1/);
  });
});

describe("resolveModel: OpenRouter models newer than the catalog", () => {
  it("borrows a same-vendor sibling's settings and keeps the requested id", () => {
    const m = resolveModel("openrouter/openai/gpt-6.1-terra");
    const sibling = resolveModel("openrouter/openai/gpt-6-luna");
    expect(m.id).toBe("openai/gpt-6.1-terra");
    expect(m.provider).toBe("openrouter");
    expect(m.api).toBe(sibling.api);
    expect(m.baseUrl).toBe(sibling.baseUrl);
    // The closest sibling (gpt-6-luna), not the first listed (gpt-3.5-turbo's 4k output cap cut Terra off).
    expect(m.maxTokens).toBe(sibling.maxTokens);
    expect(m.reasoning).toBe(sibling.reasoning);
  });

  it("still refuses an unknown provider", () => {
    expect(() => resolveModel("nope/thing")).toThrow(/unknown provider/);
  });
});
