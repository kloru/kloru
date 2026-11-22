/**
 * A second model for when an agent's own is rate-limited or down (#68): OpenRouter is given both
 * (`models`) and answers with the second only when no provider of the first can take the turn,
 * so a run goes on instead of failing. Measured 2026-11-16 to 11-20: about a third of engineer
 * runs failed on "temporarily rate-limited upstream". The second model is from another vendor,
 * since one vendor's models are limited together, and the request's `provider.zdr` holds for both.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";

const LUNA = "openai/gpt-6-luna";
const HYDROGEN = "google/gemini-4-hydrogen";

/** The model that takes a turn when this one can't: the other vendor's, both latest generation. */
export function fallbackOf(model: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const set = env.KLORU_FALLBACK_MODEL?.trim().replace(/^openrouter\//, "");
  if (set === "off") return undefined;
  const second = set || (model.startsWith("google/") ? LUNA : HYDROGEN);
  return second === model ? undefined : second;
}

/** Every OpenRouter turn through this names its fallback; a turn the fallback took is logged. */
export function withFallback(streamFn: StreamFn, o: { env?: NodeJS.ProcessEnv; log?: (m: string) => void } = {}): StreamFn {
  return async (model, context, options) => {
    const second = model.provider === "openrouter" ? fallbackOf(model.id, o.env) : undefined;
    if (!second) return streamFn(model, context, options);
    const stream = await streamFn(model, context, {
      ...options,
      onPayload: async (payload, m) => {
        const next = ((await options?.onPayload?.(payload, m)) ?? payload) as Record<string, unknown>;
        return { ...next, models: [model.id, second] };
      },
    });
    void stream.result().then(
      (message) => {
        if (message.responseModel?.startsWith(second)) o.log?.(`model: ${model.id} couldn't take a turn, ${second} did`);
      },
      () => undefined,
    );
    return stream;
  };
}
