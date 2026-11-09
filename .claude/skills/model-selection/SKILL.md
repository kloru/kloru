---
name: model-selection
description: Use when choosing or questioning which model a Kloru role runs on (texting model, PM, engineers, ops, voice, fast path), or when a role misbehaves in a way a different model might fix. Combines OpenRouter's benchmark and live latency/throughput data with a bench on Kloru's own cases.
---

# Choosing a model for a role

Evan's rule (2026-11-09): don't pick a model from a short test alone, and don't pick it from
benchmarks alone. Use OpenRouter's public data to shortlist, then Kloru's own cases to decide.

Decisions with a fixed set of answers go to Jev, not a general model (the `decision-models` skill).
Kloru never uses Anthropic models.

**Only the newest version of a model.** Every candidate, including the one a role runs on today, is
the latest version of its line (Gemini 3.8 Flash, not 3.5 Flash). Find them by release date:
`GET /api/v1/models` sorted by `created`, newest per family. When a newer version of a role's model
ships, bench it against the current one; an older version never wins a tie.

**Zero data retention everywhere** (Evan, 2026-11-09). Every model call carries family data, so every
one asks OpenRouter for `provider: { zdr: true }`:
- pi-ai models (PM, workers, the chat runtime): `resolveModel` sets `compat.openRouterRouting.zdr`
  (`packages/core/src/model.ts`).
- Direct chat calls (texting model, fast path, action decider, member policy, steering):
  `chatMessage` in `packages/server/src/openrouter.ts`.
- Jev decisions (`/api/alpha/decisions`): each request body, in the decider files.
- Image generation (`packages/core/src/core-tools.ts`) and voice (`voice/voice/bot.py`, the call judge,
  the voice bench).
A new call site adds it too. Only shortlist models with a zero-data-retention provider
(`compare.py --zdr` shows none otherwise).

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
  (build first), then the full suite with `TEXT_MODEL=<id> npx vitest run test/text-talker.live.test.ts`
  in `packages/server`, at least twice. Add the real miss as a case before benching.
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

- **Texting model** (`packages/server/src/text-talker.ts`, `MODEL`): **Gemini 3.8 Flash since 2026-11-09.**
  Of the newest models (ZDR only): Gemini 3.8 Flash 24/24 core cases, 20/20 honest status, 4/4 full
  suites; DeepSeek V4.1 Flash fastest (~1–4 s) and 20/20 status, but email results too long 3/4;
  GPT-6.1 Terra and Gemini 3.5 Flash dropped a suite case; GLM-5.3 18/20 status; GLM-5.3 FlashX,
  MiniMax M3.1 Flash and Muse Spark failed to file. Gemini 4 Argon too slow (6 s first token).
  History: Gemini 3.5 Flash, minimal
  reasoning, since 2026-10-30, chosen for speed without a comparison. On 2026-11-09 it skipped filing
  2/5 with Evan's real context. After the prompt fix, Flash, gpt-6-luna, Gemini 3.8 Flash and GLM-5.3
  all passed 15/15. Flash Lite failed; GLM-5.3-flash and DeepSeek V4 Flash missed some. Calls go to
  zero-data-retention providers only (`provider: { zdr: true }`, 11-09).
  GLM-5.3 led on the data (agentic 53 vs 26, first token 0.3 s vs 1.5 s, a tenth of the price) and
  filed 16/16, but said the delay on "is it done yet?" only 14/20 (3 with no words) vs Flash ~19/20.
  Not switched: honest status matters more. Retry it after tuning the status line for it.
- **PM** (`KLORU_PM_MODEL`): Gemini 3.5 Flash since 2026-10-30, an old version: bench 3.8 Flash. Luna passed the same 8 of 9 cases
  in about twice the time.
- **Fast path and action decider:** Gemini 3.5 Flash, an old version: bench 3.8 Flash. Flash Lite missed items (10-29); Flash with
  thinking turned on took up to 16 s.
- **Engineers, ops, voice:** gpt-6-luna. Terra and Flash scored worse on voice.
