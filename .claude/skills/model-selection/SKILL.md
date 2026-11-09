---
name: model-selection
description: Use when choosing or questioning which model a Kloru role runs on (texting model, PM, engineers, ops, voice, fast path), or when a role misbehaves in a way a different model might fix. Combines OpenRouter's benchmark and live latency/throughput data with a bench on Kloru's own cases.
---

# Choosing a model for a role

Evan's rule (2026-11-09): don't pick a model from a short test alone, and don't pick it from
benchmarks alone. Use OpenRouter's public data to shortlist, then Kloru's own cases to decide.

Decisions with a fixed set of answers go to Jev, not a general model (the `decision-models` skill).
Kloru never uses Anthropic models.

## 1. Write down what the role needs

One line each:
- **Job:** what it decides or writes, and with which tools.
- **Time budget:** how long someone waits. A text reply should land in about 2–3 s; the PM and
  workers can take longer.
- **Data:** does it see family data? (Almost every role does.) Then use zero-data-retention providers only.
- **The case that started this:** the real conversation that went wrong, if any.

## 2. Shortlist from OpenRouter's data

```
set -a && . ./.instinct.env && set +a
python3 .claude/skills/model-selection/scripts/compare.py --zdr <current model> <candidates…> --top 8 --max-input 1.0
```

It combines:
- `GET /api/v1/benchmarks`: Artificial Analysis `agentic_index` (tool use), `intelligence_index`
  (reasoning), and OpenRouter's `tau_bench_verified_airline` (an agent following a policy and calling
  tools correctly).
- `GET /api/v1/models/<id>/endpoints`, or `GET /api/v1/endpoints/zdr` with `--zdr`: per-provider
  `latency_last_30m` (time to first token), `throughput_last_30m` (tokens/s), uptime, price, tool support.
  These are the numbers on each model's page (e.g. openrouter.ai/google/gemini-3.5-flash-lite).

How to read it:
- **Tool-using roles** (texting model, PM, workers): agentic index and tau-bench first.
- **Time:** about first-token latency + output tokens ÷ tokens/s, per model call. A texting turn with a
  tool call is two calls. Look at p90, not just p50: the slow tail is what people notice.
- **Price:** dollars per million tokens. Zero-data-retention providers can cost more (Gemini Flash
  doubled on Nov 9).
- The live numbers move hour to hour. Compare models from one run, and save the table (`--json`).

Keep 2–4 models: the current one, the best on the data, and one cheaper or faster option.

## 3. Bench on Kloru's own cases

The data says what a model can do in general. Only our cases say whether it does our job. At least
5 runs per case; record the pass rate and median time.

- **Texting model:** `node .claude/skills/model-selection/scripts/talker-bench.mjs <models…>`
  (build first). Add the real miss as a case before benching.
- **PM:** `KLORU_PM_MODEL=openrouter/<id> npx vitest run test/pm.live.test.ts` in `packages/desk`.
- **Engineers and ops:** no live suite runs a real worker model yet (`pm.live.test.ts` fakes the
  workers). Write a case before choosing one; production picks it with `KLORU_ENGINEER_MODEL`.
- **Voice:** `voice.bench` (see the `prompt-editing` skill), with the model set in its config.
- **Quick check and other Jev decisions:** not this skill (`decision-models`).

Run the current model in the same session. A difference smaller than one run in five is noise.

## 4. Decide

1. Pass rate on our cases first.
2. Then time within the budget (live p90 and our median).
3. Then price.
4. A tie keeps the current model: switching has its own risk.

Ask Evan before switching a role to a model from a new vendor, or when its providers differ from
today's on data handling. Say what data it would see and where.

## 5. Record it

In the commit: the role, the candidates, the data table with its `as_of` date and source citation
(Artificial Analysis and OpenRouter via OpenRouter), the bench results, and why the winner won.
Point the role's model constant or env var at the winner, and keep the bench case.

## What we know (update this as roles change)

- **Texting model** (`packages/server/src/text-talker.ts`, `MODEL`): Gemini 3.5 Flash, minimal
  reasoning, since 2026-10-30, chosen for speed without a comparison. On 2026-11-09 it skipped filing
  2/5 with Evan's real context. After the prompt fix, Flash, gpt-6-luna, Gemini 3.8 Flash and GLM-5.3
  all passed 15/15. Flash Lite failed; GLM-5.3-flash and DeepSeek V4 Flash missed some.
- **PM** (`KLORU_PM_MODEL`): Gemini 3.5 Flash since 2026-10-30. Luna passed the same 8 of 9 cases
  in about twice the time.
- **Fast path and action decider:** Gemini 3.5 Flash. Flash Lite missed items (10-29); Flash with
  thinking turned on took up to 16 s.
- **Engineers, ops, voice:** gpt-6-luna. Terra and Flash scored worse on voice.
