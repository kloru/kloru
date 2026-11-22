/**
 * Does a tool-using run carry on when its model can't take a turn and the fallback does, and on the
 * turn after? Luna is made unavailable by routing a turn to Google's providers only. Once the
 * fallback has taken a turn OpenRouter keeps that run on it (its cache is warm there); new runs start on Luna.
 * Runs only with OPENROUTER_API_KEY:
 *   OPENROUTER_API_KEY=… npx vitest run test/model-fallback.live.test.ts
 */
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { resolveModel } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { withFallback } from "../src/model-fallback.js";

const key = process.env.OPENROUTER_API_KEY;

describe.skipIf(!key)("the fallback model, live", () => {
  it("takes a turn mid-run, and the run goes on", async () => {
    const luna = resolveModel("openrouter/openai/gpt-6-luna", process.env);
    const noLuna = { ...luna, compat: { ...luna.compat, openRouterRouting: { ...luna.compat?.openRouterRouting, only: ["google-vertex", "google-ai-studio"] } } };
    const calls: number[][] = [];
    const add: AgentTool<any> = {
      name: "add",
      label: "add",
      description: "Adds two numbers. Always use it to add.",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } as any,
      execute: async (_id, args: { a: number; b: number }) => {
        calls.push([args.a, args.b]);
        return { content: [{ type: "text", text: String(args.a + args.b) }], details: undefined };
      },
    };
    const logs: string[] = [];
    const agent = new Agent({
      initialState: { systemPrompt: "Add with the add tool, then say the number.", model: luna, thinkingLevel: "medium", tools: [add], messages: [] },
      streamFn: withFallback(streamSimple as StreamFn, { env: {}, log: (m) => logs.push(m) }),
      getApiKey: () => key,
      toolExecution: "sequential",
    });
    const turn = async (text: string) => {
      await agent.prompt(text);
      await agent.waitForIdle();
      const last = agent.state.messages.at(-1) as { role: string; stopReason?: string; errorMessage?: string; responseModel?: string; content: Array<{ type: string; text?: string }> };
      expect(last.errorMessage).toBeUndefined();
      return { text: last.content.map((c) => c.text ?? "").join(""), by: last.responseModel };
    };
    const first = await turn("What is 1234 plus 4321?");
    expect(first.text).toContain("5555");
    expect(first.by ?? "openai/gpt-6-luna").toMatch(/^openai\/gpt-6-luna/);

    agent.state.model = noLuna;
    const second = await turn("Now add 1111 to that with the tool and tell me the result.");
    expect(second.text).toMatch(/6,?666/);
    expect(second.by).toMatch(/^google\/gemini-4-hydrogen/);
    expect(logs.some((l) => l.includes("google/gemini-4-hydrogen did"))).toBe(true);

    agent.state.model = luna;
    const third = await turn("Add 1111 more with the tool and tell me the result.");
    expect(third.text).toMatch(/7,?777/);
    expect(calls).toEqual([[1234, 4321], [5555, 1111], [6666, 1111]]);
  }, 120_000);
});
