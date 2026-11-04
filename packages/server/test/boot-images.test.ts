import { describe, expect, it } from "vitest";
import { imagesFrom, OPENROUTER_IMAGES } from "../src/boot.js";

describe("where image_generate draws", () => {
  it("with only the OpenRouter key, OpenRouter's images endpoint and Gemini 3.1 Flash Image", () => {
    expect(imagesFrom({ OPENROUTER_API_KEY: "or" })).toEqual({ apiKey: "or", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-3.1-flash-image" });
    expect(OPENROUTER_IMAGES.model).toBe("google/gemini-3.1-flash-image");
  });

  it("IMAGE_MODEL picks another OpenRouter model", () => {
    expect(imagesFrom({ OPENROUTER_API_KEY: "or", IMAGE_MODEL: "qwen/qwen-image-2.1-turbo" })?.model).toBe("qwen/qwen-image-2.1-turbo");
  });

  it("a dedicated image key or an OpenAI key wins, with its own URL and model", () => {
    expect(imagesFrom({ OPENROUTER_API_KEY: "or", IMAGE_API_KEY: "img", IMAGE_BASE_URL: "https://x/v1" })).toEqual({ apiKey: "img", baseUrl: "https://x/v1" });
    expect(imagesFrom({ OPENROUTER_API_KEY: "or", OPENAI_API_KEY: "oa" })).toEqual({ apiKey: "oa" });
  });

  it("no key at all: no image generation", () => {
    expect(imagesFrom({})).toBeUndefined();
  });
});
