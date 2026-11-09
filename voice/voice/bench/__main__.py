"""Run the conversation bench (#23) against the real models.

    uv run python -m voice.bench                  # all scenarios, compare with the baseline
    uv run python -m voice.bench --only ambiguous_calendar
    uv run python -m voice.bench --no-brief       # without memory's brief (as before #6)
    uv run python -m voice.bench --save-baseline  # make this run the new baseline

Exits 1 when a score got meaningfully worse than the baseline (voice/bench/baseline.json), so a
deploy can be gated on it. Each run is saved under voice/bench/runs/ and, with Langfuse configured,
scored in Langfuse's "bench" environment (sessions bench-<run>-<scenario>).
"""
import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv

from voice.bench.harness import run_scenario
import dataclasses

from voice.bench.report import aggregate, average_repeats, regressions, regressions_by_scenario
from voice.bench.scenarios import SCENARIOS
from voice.config import load_config
from voice.observability import LangfuseClient, judge_call

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "baseline.json"
RUNS = HERE / "runs"


def openrouter_chat(client: httpx.AsyncClient, api_key: str, model: str, reasoning: str | None = None):
    async def chat(messages, tools=None):
        body: dict = {"model": model, "messages": messages, "max_tokens": 600}
        if tools:
            body["tools"] = tools
        if reasoning:
            body["reasoning"] = {"effort": reasoning}
        body["provider"] = {"zdr": True}  # as production: zero-data-retention providers only
        for attempt in range(4):
            try:
                res = await client.post("https://openrouter.ai/api/v1/chat/completions", headers={"Authorization": f"Bearer {api_key}"}, json=body, timeout=90)
            except httpx.TransportError:
                if attempt == 3:
                    raise
                await asyncio.sleep(2 * (attempt + 1))
                continue
            if res.status_code in (429, 502, 503) and attempt < 3:
                await asyncio.sleep(2 * (attempt + 1))
                continue
            res.raise_for_status()
            break
        msg = res.json()["choices"][0]["message"]
        calls = []
        for c in msg.get("tool_calls") or []:
            try:
                args = json.loads(c["function"].get("arguments") or "{}")
            except ValueError:
                args = {}
            calls.append({"id": c["id"], "name": c["function"]["name"], "arguments": args})
        return {"content": msg.get("content") or "", "tool_calls": calls}

    return chat


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", action="append", help="scenario id (repeatable)")
    ap.add_argument("--no-brief", dest="brief", action="store_false", help="run without memory's brief")
    ap.add_argument("--save-baseline", action="store_true")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--talker", help="model for the talking model (default: VOICE_MODEL)")
    ap.add_argument("--judge", help="judge model (default: KLORU_BENCH_JUDGE or google/gemini-3.6-flash, so no candidate grades itself)")
    ap.add_argument("--repeat", type=int, default=1, help="runs per scenario, averaged")
    args = ap.parse_args()

    load_dotenv()
    cfg = load_config(os.environ)
    cfg = dataclasses.replace(cfg, judge_model=args.judge or os.environ.get("KLORU_BENCH_JUDGE", "google/gemini-3.6-flash"))
    scenarios = [s for s in SCENARIOS if not args.only or s.id in args.only]
    now = datetime.now(ZoneInfo(cfg.owner_timezone))
    run_id = f"{now:%Y%m%dT%H%M%S}-{(args.talker or cfg.voice_model).split('/')[-1]}"
    sim_model = os.environ.get("KLORU_SIM_MODEL", "openai/gpt-6.1-terra")
    gate = asyncio.Semaphore(args.concurrency)

    async with httpx.AsyncClient() as http:
        talker_model = args.talker or cfg.voice_model
        talker = openrouter_chat(http, cfg.openrouter_api_key, talker_model, cfg.voice_reasoning_effort)
        caller = openrouter_chat(http, cfg.openrouter_api_key, sim_model)

        async def one(sc):
            async with gate:
                ep = await run_scenario(sc, talker, caller, now, brief=args.brief)
                judged = await judge_call(cfg, ep.lines, client=http)
                scores = {k: v for k, (v, _) in judged.items()} | ep.metrics
                return sc.id, ep, judged, scores

        raw = await asyncio.gather(*(one(sc) for sc in scenarios for _ in range(max(1, args.repeat))))
    # Keep the first run's transcript for reading; average every run's scores.
    reps: dict[str, list] = {}
    for sid, ep, judged, scores in raw:
        reps.setdefault(sid, []).append((ep, judged, scores))
    averaged = average_repeats({sid: [s for _, _, s in runs] for sid, runs in reps.items()})
    results = [(sid, runs[0][0], runs[0][1], averaged[sid]) for sid, runs in reps.items()]

    RUNS.mkdir(exist_ok=True)
    record = {
        "run": run_id, "repeat": args.repeat, "talker": args.talker or cfg.voice_model, "simulator": sim_model, "judge": cfg.judge_model, "brief": args.brief,
        "scenarios": {sid: {"scores": sc, "reasons": {k: why for k, (_, why) in j.items()}, "transcript": ep.lines, "filed": ep.filed} for sid, ep, j, sc in results},
    }
    agg = aggregate([sc for _, _, _, sc in results])
    record["aggregate"] = agg
    (RUNS / f"{run_id}.json").write_text(json.dumps(record, indent=2))

    if cfg.langfuse:
        lf = LangfuseClient(cfg.langfuse)
        for sid, _, judged, scores in results:
            await lf.scores(f"bench-{run_id}-{sid}", scores, comments={k: why for k, (_, why) in judged.items()}, environment="bench")
        await lf.aclose()

    rubric = ["happiness", "frustration", "clarifying", "expectations", "teaching", "attunement", "prepared", "mirroring", "filler", "accuracy", "follow_through", "curiosity"]
    print(f"\nbench run {run_id}: {len(results)} scenarios (talker {args.talker or cfg.voice_model}, brief={args.brief})")
    print("scenario".ljust(30) + "".join(n[:6].rjust(8) for n in rubric) + "   gap(s)")
    for sid, _, _, sc in results:
        cells = "".join((f"{sc[n]:.2f}" if n in sc else "-").rjust(8) for n in rubric)
        print(sid.ljust(30) + cells + f"{sc.get('silence.longest_gap_s', 0):9.1f}")
    print("average".ljust(30) + "".join((f"{agg[n]:.2f}" if n in agg else "-").rjust(8) for n in rubric) + f"{agg.get('silence.longest_gap_s', 0):9.1f}")
    print(f"talking model response time: p50 {agg.get('talker.latency_p50_s', 0):.2f}s, worst {agg.get('talker.latency_max_s', 0):.2f}s")
    print(f"sentences the model said twice (dropped, as on a live call): {sum(sc.get('talker.repeats', 0) for _, _, _, sc in results):.0f}")
    print(f"saved {RUNS / (run_id + '.json')}")

    per_scenario = {sid: {k: round(v, 3) for k, v in sc.items()} for sid, _, _, sc in results}
    if args.save_baseline:
        BASELINE.write_text(json.dumps({"aggregate": {k: round(v, 3) for k, v in agg.items()}, "scenarios": per_scenario}, indent=2))
        print(f"baseline saved to {BASELINE}")
        return 0
    if BASELINE.exists() and not args.only:
        base = json.loads(BASELINE.read_text())
        worse = regressions_by_scenario(per_scenario, base["scenarios"]) if "scenarios" in base else regressions(agg, base)
        if worse:
            print("\nWORSE than baseline:\n  " + "\n  ".join(worse))
            return 1
        print("\nno regressions against the baseline")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
