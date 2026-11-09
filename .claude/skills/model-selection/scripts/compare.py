#!/usr/bin/env python3
"""
Compare candidate models for one Kloru role from OpenRouter's public data:
benchmarks (GET /api/v1/benchmarks: Artificial Analysis indexes, OpenRouter's tau-bench) and each
model's live endpoints (GET /api/v1/models/<id>/endpoints: latency, throughput, uptime, price,
tool support, per provider). Prints one table; --json writes the rows for a page or a commit.

  OPENROUTER_API_KEY=… python3 compare.py google/gemini-3.5-flash openai/gpt-6-luna …
  python3 compare.py --top 15 --max-input 1.0          # shortlist from the benchmarks first

Latency is OpenRouter's time to first token (ms) and throughput is tokens/second, both the p50 over the
last 30 minutes for the model's best provider (the lowest p50 latency among providers that are up and
support tools). They move hour to hour: compare models from one run, not across days.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

API = "https://openrouter.ai/api/v1"


def get(path, key):
    req = urllib.request.Request(f"{API}{path}", headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def base(slug):
    """'google/gemini-3.5-flash-20260519' -> 'google/gemini-3.5-flash' (benchmarks use dated permaslugs)."""
    head, _, tail = slug.rpartition("-")
    return head if tail.isdigit() and len(tail) == 8 else slug


def per_million(p):
    try:
        return float(p) * 1e6
    except (TypeError, ValueError):
        return None


def newest(items):
    """One row per model: its newest dated version (the one OpenRouter serves under the plain id)."""
    out = {}
    for d in sorted(items, key=lambda d: d["model_permaslug"]):
        out[base(d["model_permaslug"])] = d
    return out


def benchmarks(key):
    aa = newest(get("/benchmarks?source=artificial-analysis", key)["data"])
    tau = newest(get("/benchmarks?source=openrouter&benchmark_type=tau_bench_verified_airline", key)["data"])
    return aa, tau


_zdr = None


def live(model, key, zdr=False):
    """The best provider's live numbers: up, takes tools, lowest p50 latency. zdr: zero-data-retention providers only."""
    global _zdr
    try:
        if zdr:
            _zdr = _zdr if _zdr is not None else get("/endpoints/zdr", key)["data"]
            eps = [e for e in _zdr if e.get("model_id") == model]
        else:
            eps = get(f"/models/{urllib.parse.quote(model, safe='/')}/endpoints", key)["data"]["endpoints"]
    except Exception as e:  # noqa: BLE001 - a missing model shouldn't stop the table
        return {"error": str(e)}
    ok = [e for e in eps if e.get("status", 0) == 0 and (zdr or "tools" in (e.get("supported_parameters") or [])) and (e.get("latency_last_30m") or {}).get("p50")]
    if not ok:
        return {"error": "no provider up with tools and recent traffic"}
    e = min(ok, key=lambda e: e["latency_last_30m"]["p50"])
    return {
        "provider": e["provider_name"],
        "ttft_p50_ms": e["latency_last_30m"]["p50"],
        "ttft_p90_ms": e["latency_last_30m"].get("p90"),
        "tps_p50": (e.get("throughput_last_30m") or {}).get("p50"),
        "uptime_1d": e.get("uptime_last_1d"),
        "in_per_m": per_million((e.get("pricing") or {}).get("prompt")),
        "out_per_m": per_million((e.get("pricing") or {}).get("completion")),
        "reasoning": "reasoning" in (e.get("supported_parameters") or []),
        "providers": len(ok),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="*", help="OpenRouter model ids to compare")
    ap.add_argument("--top", type=int, default=0, help="also add the N best by tau-bench + agentic index")
    ap.add_argument("--max-input", type=float, default=None, help="with --top: max $ per million input tokens")
    ap.add_argument("--exclude", default="anthropic/", help="comma-separated id prefixes to leave out (Kloru never uses Anthropic models)")
    ap.add_argument("--zdr", action="store_true", help="live numbers from zero-data-retention providers only (family data)")
    ap.add_argument("--json", help="write the rows to this file")
    a = ap.parse_args()
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("set OPENROUTER_API_KEY")
    aa, tau = benchmarks(key)
    excluded = tuple(x for x in a.exclude.split(",") if x)
    models = list(dict.fromkeys(a.models))
    if a.top:
        pool = [m for m in set(aa) | set(tau) if not m.startswith(excluded)]
        def cheap(m):
            p = per_million(((aa.get(m) or {}).get("pricing") or {}).get("prompt"))
            return a.max_input is None or (p is not None and p <= a.max_input)
        score = lambda m: (tau.get(m, {}).get("accuracy") or 0) * 100 + ((aa.get(m) or {}).get("agentic_index") or 0)
        models += [m for m in sorted(filter(cheap, pool), key=score, reverse=True) if m not in models][: a.top]
    rows = []
    for m in models:
        b, t, l = aa.get(m) or {}, tau.get(m) or {}, live(m, key, a.zdr)
        rows.append({"model": m, "agentic": b.get("agentic_index"), "intelligence": b.get("intelligence_index"), "tau": t.get("accuracy"), "tau_cost": t.get("avg_cost_per_task"), **l})
    f = lambda v, fmt: (fmt % v) if isinstance(v, (int, float)) else "-"
    print(f"{'model':34} {'agentic':>7} {'intel':>5} {'tau':>5} {'ttft p50':>8} {'p90':>6} {'tok/s':>6} {'up 1d':>6} {'in $/M':>6} {'out $/M':>7}  provider")
    for r in rows:
        print(f"{r['model'][:34]:34} {f(r['agentic'],'%7.1f'):>7} {f(r['intelligence'],'%5.1f'):>5} {f(r['tau'],'%5.2f'):>5} "
              f"{f(r.get('ttft_p50_ms'),'%6.0fms'):>8} {f(r.get('ttft_p90_ms'),'%4.0fms'):>6} {f(r.get('tps_p50'),'%6.0f'):>6} {f(r.get('uptime_1d'),'%5.1f%%'):>6} "
              f"{f(r.get('in_per_m'),'%6.2f'):>6} {f(r.get('out_per_m'),'%7.2f'):>7}  {r.get('provider') or r.get('error','')}")
    print("\nSources: Artificial Analysis (artificialanalysis.ai) and OpenRouter evals and endpoints (openrouter.ai), via OpenRouter.")
    if a.json:
        json.dump(rows, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
