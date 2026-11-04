"""Bench results: averages across scenarios, and what got worse than the saved baseline."""

# Lower is better for these; every other rubric score is higher-is-better.
LOWER_IS_BETTER = {"frustration", "filler"}
# Timing scores, in seconds: a regression is a rise of more than this.
SECONDS_SLACK = 3.0
SCORE_SLACK = 0.1
TRACKED_SECONDS = {"silence.longest_gap_s", "silence.dead_air_s"}


def aggregate(runs: list[dict[str, float]]) -> dict[str, float]:
    sums: dict[str, list[float]] = {}
    for r in runs:
        for k, v in r.items():
            sums.setdefault(k, []).append(v)
    return {k: sum(v) / len(v) for k, v in sums.items()}


def regressions(now: dict[str, float], base: dict[str, float]) -> list[str]:
    """Scores that got meaningfully worse than the baseline, as readable lines."""
    out = []
    for k, b in base.items():
        if k not in now:
            continue
        v = now[k]
        if k in TRACKED_SECONDS:
            if v - b > SECONDS_SLACK:
                out.append(f"{k}: {b:.1f}s → {v:.1f}s")
        elif k.startswith(("silence.", "latency.", "turn.", "style.", "call.", "interruptions", "talker.")):
            continue
        elif k in LOWER_IS_BETTER:
            if v - b > SCORE_SLACK:
                out.append(f"{k}: {b:.2f} → {v:.2f} (lower is better)")
        elif b - v > SCORE_SLACK:
            out.append(f"{k}: {b:.2f} → {v:.2f}")
    return out


def regressions_by_scenario(now: dict[str, dict[str, float]], base: dict[str, dict[str, float]]) -> list[str]:
    """Like `regressions`, but each score is averaged only over scenarios scored in both runs, so a
    score that comes up in a new scenario can't look like a regression."""
    names = {k for scores in base.values() for k in scores}
    now_avg, base_avg = {}, {}
    for name in names:
        common = [sid for sid in base if name in base[sid] and name in now.get(sid, {})]
        if common:
            now_avg[name] = sum(now[sid][name] for sid in common) / len(common)
            base_avg[name] = sum(base[sid][name] for sid in common) / len(common)
    return regressions(now_avg, base_avg)


def average_repeats(reps: dict[str, list[dict[str, float]]]) -> dict[str, dict[str, float]]:
    """Several runs of each scenario, averaged per score (a score missing from a run doesn't count)."""
    return {sid: aggregate(runs) for sid, runs in reps.items()}
