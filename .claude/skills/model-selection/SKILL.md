---
name: model-selection
description: Use when choosing or questioning which model a Kloru role runs on (texting model, PM, engineers, ops, voice, fast path), or when a role misbehaves in a way a different model might fix. Combines OpenRouter's benchmark and live latency/throughput data with a bench on Kloru's own cases.
---

# Choosing a model for a role

Evan's rule (2026-11-09): don't pick a model from a short test alone, and don't pick it from
benchmarks alone. Use OpenRouter's public data to shortlist, then Kloru's own cases to decide.

Decisions with a fixed set of answers go to Jev, not a general model (the `decision-models` skill).
Kloru never uses Anthropic models.

**Only the latest generation** (Evan, 2026-11-16). Every job runs on its vendor's newest line: today
Gemini 4, GPT-6 / 6.1, Jev 1.14. Gemini 3.x is a past generation, so no job runs on it and it is never
a candidate, whatever it scores.
- Find the newest by date, not by name: `GET /api/v1/models?output_modalities=all` sorted by
  `created`, newest per vendor line, and listed in `GET /api/v1/endpoints/zdr`. Admin → Models shows
  the same list.
- When a vendor ships a new generation, bench it for every job on the old one in the same week.
- When the newest of a line is too slow or wrong for a job, take another latest-generation model
  (a smaller one of the line, or another vendor's newest; see step 4 on new vendors). Never go back
  a version. A newer minor version is not always faster: 3.8 Flash was twice as slow as 3.5 Flash
  on short calls because it can't skip thinking.
- Check how little a model can think before timing it: `reasoning.supported_efforts` on its
  listing. GPT-6 takes `none`; Gemini 4 has no `minimal` or `none` and thinks least at `low`
  (`minimal` is taken as `low`; `none` is a 400, as it is for most vendors). Short schema-shaped calls use
  `leastThinking(model)` (`packages/server/src/openrouter.ts`); add a line there for a new vendor.

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
- **App engineer:** `ENGINEER_MODEL=openrouter/<id> RUNS=5 npx vitest run test/app-bench.live.test.ts`
  in `packages/server` (make a list, fix a broken one, a chore chart through QA; `BENCH_OUT=<file>`
  keeps each run). Production picks it with `KLORU_APP_ENGINEER_MODEL`.
- **QA:** `QA_MODEL=openrouter/<id> npx vitest run test/app-qa.live.test.ts` (it must catch a list
  whose removed items come back, and pass a working one). `KLORU_QA_MODEL`; unset, the app model.
- **Other engineers and ops:** no live suite runs a real worker model on other work yet
  (`pm.live.test.ts` fakes the workers). Write a case before choosing one; `KLORU_ENGINEER_MODEL`.
- **Voice:** `voice.bench` (see the `prompt-editing` skill), with the model set in its config.
- **Fast path, steering, family member setup, the action check's second look:** in `packages/server`,
  `TRY_MODELS="steer=<id>,fast-path-plan=<id>" npx vitest run test/<x>.live.test.ts` with
  `fast-path`, `steer-filter`, `member-policy` or `action-decider`. `TRY_MODELS` sets any job in
  `models.ts` by its id for that run. Run candidates one after another: side by side they hit rate
  limits and time out, which reads as a slow model.
- **Images:** one `POST /api/v1/images/generations` with `provider: { zdr: true }`, and look at it.
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
Point the job's default in `packages/server/src/models.ts` (`ROLES`) or its env var at the winner,
and keep the bench case. An owner's pick under Admin → Models wins over both.

## What we know (update this as roles change)

Every job is on a latest-generation model since 2026-11-16. Benches below are from that day, ZDR
providers only, least thinking unless said.

- **Fallback** (`model-fallback.ts`, since 2026-11-21): every agent turn (engineers, PM, organizer,
  QA, memory) names a second model, and OpenRouter uses it only when no provider of the first can
  take the turn. An OpenAI model falls back to Hydrogen, a Google one to Luna: one vendor's models
  are rate-limited together (11-16 to 11-20 a third of engineer runs failed on Luna's limit).
  `KLORU_FALLBACK_MODEL` sets another, `off` turns it off. Once the fallback takes a turn the run
  stays on it. Live check: `test/model-fallback.live.test.ts` (Hydrogen sends an empty turn about
  one run in ten there, as it does when it is the first model). A new default needs a fallback
  that is latest generation, from another vendor, and passes the job's bench.
- **Texting:** **Gemini 4 Hydrogen.** Full suite twice: Hydrogen 24/24 in 25 s; Gemini 3.8 Flash
  24/24 in 59–85 s; Luna 20/24. `talker-bench` 5 runs a case: Hydrogen 15/15, medians 1.6–2.6 s;
  3.8 Flash 15/15, 4.8–7.7 s. Earlier (11-09): DeepSeek V4.1 Flash fast but wrote email results
  too long; GLM-5.3 said the delay on "is it done yet?" only 14/20; GLM-5.3 FlashX, MiniMax M3.1
  Flash and Muse Spark failed to file; Gemini 4 Argon 6 s to first token.
- **PM** (`KLORU_PM_MODEL`; the outbox organizer runs on it too): **Gemini 4 Hydrogen.** Suite of
  25 twice, three models side by side: Hydrogen 24 and 23 in 255 s; Gemini 3.5 Flash 23 and 22 in
  330–520 s; Luna 19 and 20. Hydrogen leaves an unanswered question open without a note, which the
  case now accepts.
- **Fast path plan and change, action check's second look:** **Gemini 4 Hydrogen.** Fast path 18/18
  (3.5 Flash 17/18; Luna 13/18, wrong answers). Second look 69/69 at least thinking, 52 s a run
  against 64–68 s on 3.5 Flash; at its default thinking 5 of 69 ran past the 8 s limit. Hydrogen is
  0.5–1 s slower than 3.5 Flash on some fast-path changes.
- **Fast path answer, steering, family member setup:** **GPT-6 Luna with no thinking** (~1.4 s a
  call; at `minimal` it still thinks, ~2.5 s). Steering 36/36 (3.5 Flash Lite 33/36), member setup
  15/15 in 7 s (3.5 Flash 13/15 in 16 s), answers as good as Hydrogen's at a fifteenth of the price.
  MiniMax M3.1 Flash was wrong on all of them.
- **Images:** **Gemini Nano Banana 2.1** (one try: 14 s, $0.034; 3.1 Flash Image 10 s, $0.067).
- **Engineers, ops, voice:** GPT-6 Luna. Terra and Flash scored worse on voice. Voice sends
  `minimal`; `none` is not benched there yet.
- **Call judge:** GPT-6.1 Terra. **Decisions:** Jev 1.14 (`decision-models`).
- **App engineer and QA** (`KLORU_APP_ENGINEER_MODEL`): **GPT-6.1 Terra since 2026-11-10** (Evan asked
  for a smarter model for apps). Bench, ZDR, thinking medium, make / fix / chores: Terra 4/4, 5/5, 5/5
  (62–81 s, ~$0.07 a run); Luna 5/5, 5/5, 4/5 (96–111 s, ~$0.005; one chart came up empty). GLM-5.3
  0/3 on fix; Gemini 4 Carbon passed but took 3–9 min a run; GPT-6.1 Sol's ZDR provider refused
  every call (capacity).
- **Tried and not used:** Gemini 3.8 Flash (2x slower than 3.5 at short calls, and now a past
  generation); no Gemini 4 Lite or GPT-6.1 Luna exists yet: bench them when they do.
