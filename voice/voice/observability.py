"""Langfuse for calls: traces, the call's numbers, and a judge's read of how it felt.

- Traces: Pipecat's OpenTelemetry spans (turns, STT, LLM, TTS) go to Langfuse's OTLP endpoint,
  grouped into one session per call (the Twilio CallSid). They include what was said, so they
  are only on when the caller's "Help improve Kloru for everyone" setting is on.
- Numbers: worked out from the SpeakingObserver's moments. Silence is a negative score: any
  stretch where nobody is speaking. Sent for every call; they contain no words.
- Judge: after the call a model reads the transcript and scores frustration and happiness,
  0 to 1, with a reason. Only when the setting is on.

Nothing here may raise into a call: every network failure is logged and dropped.
"""
import base64
import json
import re
from collections.abc import Iterable

import httpx
from loguru import logger
from pipecat.observers.speaking_observer import SpeechEvent, SpeechEventKind as K

from voice.config import Config

LangfuseKeys = tuple[str, str, str]  # base_url, public key, secret key

GAP_S = 2.0


def _auth(keys: LangfuseKeys) -> str:
    _, public, secret = keys
    return "Basic " + base64.b64encode(f"{public}:{secret}".encode()).decode()


def langfuse_otlp(keys: LangfuseKeys) -> tuple[str, dict[str, str]]:
    """Where Pipecat's spans go, and how they authenticate."""
    return f"{keys[0].rstrip('/')}/api/public/otel/v1/traces", {"Authorization": _auth(keys)}


def setup_tracing(cfg: Config) -> bool:
    """Send Pipecat's spans to Langfuse. Call once per process; False when not configured."""
    if not cfg.langfuse:
        return False
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from pipecat.utils.tracing.setup import setup_tracing as pipecat_setup

        url, headers = langfuse_otlp(cfg.langfuse)
        return bool(pipecat_setup(service_name="kloru-voice", exporter=OTLPSpanExporter(endpoint=url, headers=headers)))
    except Exception as err:  # noqa: BLE001
        logger.error(f"langfuse: tracing not set up: {err!r}")
        return False


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    return s[len(s) // 2]


def call_metrics(events: Iterable[SpeechEvent]) -> dict[str, float]:
    """The call's timing in numbers, from the speaking moments."""
    events = sorted(events, key=lambda e: e.timestamp)
    if not events:
        return {}
    # Stretches of speech, by anyone; the gaps between them are silence.
    spans: list[list[float]] = []
    open_at: dict[str, float] = {}
    for e in events:
        if e.kind in (K.USER_SPEECH_STARTED, K.BOT_SPEECH_STARTED):
            open_at[e.kind.value.split("_")[0]] = e.timestamp
        elif e.kind in (K.USER_SPEECH_STOPPED, K.BOT_SPEECH_STOPPED):
            who = e.kind.value.split("_")[0]
            start = e.started_at if e.started_at is not None else open_at.get(who, e.timestamp)
            open_at.pop(who, None)
            spans.append([start, e.timestamp])
    spans.sort()
    merged: list[list[float]] = []
    for s in spans:
        if merged and s[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], s[1])
        else:
            merged.append(list(s))
    gaps = [b[0] - a[1] for a, b in zip(merged, merged[1:])]
    long_gaps = [g for g in gaps if g > GAP_S]

    # Reply latency: the turn is ruled over, then Kloru's first sound.
    replies, delays = [], []
    last_user_stop: float | None = None
    for i, e in enumerate(events):
        if e.kind == K.USER_SPEECH_STOPPED:
            last_user_stop = e.timestamp
        if e.kind != K.USER_TURN_STOPPED:
            continue
        if last_user_stop is not None and e.timestamp >= last_user_stop:
            delays.append(e.timestamp - last_user_stop)
        nxt = next((x for x in events[i + 1:] if x.kind in (K.BOT_SPEECH_STARTED, K.USER_TURN_STARTED, K.USER_SPEECH_STARTED)), None)
        if nxt is not None and nxt.kind == K.BOT_SPEECH_STARTED:
            replies.append(nxt.timestamp - e.timestamp)

    out: dict[str, float] = {
        "call.duration_s": events[-1].timestamp - events[0].timestamp,
        "silence.dead_air_s": sum(long_gaps),
        "silence.longest_gap_s": max(gaps, default=0.0),
        "silence.gaps_over_2s": float(len(long_gaps)),
        "interruptions": float(sum(1 for e in events if e.kind == K.INTERRUPTION)),
    }
    if replies:
        out["latency.reply_p50_s"] = _median(replies)
        out["latency.reply_max_s"] = max(replies)
    if delays:
        out["turn.end_delay_p50_s"] = _median(delays)
        out["turn.end_delay_max_s"] = max(delays)
    return out


class LangfuseClient:
    def __init__(self, keys: LangfuseKeys, client: httpx.AsyncClient | None = None):
        self._base = keys[0].rstrip("/")
        self._headers = {"Authorization": _auth(keys)}
        self._client = client or httpx.AsyncClient()

    async def scores(self, session_id: str, values: dict[str, float], comments: dict[str, str] | None = None, environment: str | None = None) -> None:
        """One numeric score per value, attached to the call's session. Never raises."""
        for name, value in values.items():
            body = {"name": name, "value": float(value), "sessionId": session_id, "dataType": "NUMERIC"}
            if environment:
                body["environment"] = environment
            if comments and comments.get(name):
                body["comment"] = comments[name]
            try:
                res = await self._client.post(f"{self._base}/api/public/scores", json=body, headers=self._headers, timeout=10)
                if res.status_code >= 300:
                    logger.warning(f"langfuse: score {name} for {session_id} got {res.status_code}")
            except Exception as err:  # noqa: BLE001
                logger.warning(f"langfuse: score {name} for {session_id} failed: {err!r}")

    async def aclose(self) -> None:
        await self._client.aclose()


# The judge's rubric: how the caller felt, and how much Kloru talked like a smart person (#23).
RUBRIC = ["frustration", "happiness", "clarifying", "expectations", "teaching", "attunement", "prepared", "mirroring", "filler", "accuracy", "follow_through", "curiosity"]

JUDGE_PROMPT = """You review phone calls between a person and Kloru, their AI assistant. Kloru should talk
like a smart, attentive person: not a call-center script. Lines in [brackets] are what happened
around the words (silences, results arriving, Kloru's own actions). Score each item from 0 to 1 with one short reason.
Use null when the item didn't come up (e.g. attunement when the caller was never frustrated).

- frustration: how frustrated the caller was (repeating themselves, waiting, corrections). 0 none, 1 extreme.
- happiness: how pleased the caller was. 0 none, 1 delighted.
- clarifying: when a detail was missing, did Kloru ask the question that changed the result,
  without asking things it already knew? 1 perfect.
- expectations: did Kloru say how long things would take and what happens next? 1 always clear.
- teaching: did Kloru explain how it works when that helped (e.g. "you can hang up, it'll finish"),
  without repeating anything the caller already knew? Repeats score low.
- attunement: when the caller was frustrated, did Kloru acknowledge it and change course? 1 well done.
- prepared: did Kloru answer from what it already knew instead of making the caller wait? 1 instant.
- mirroring: did Kloru match the caller's length and tone (brief caller, brief Kloru)? 1 perfect match.
- filler: share of Kloru's lines that carry no information ("still working on it", "one moment").
  0 none, 1 all filler.
- accuracy: did Kloru only claim something happened in the world (sent, created, moved, booked) when
  a [result arrives] line said so, and report results faithfully? Kloru's own bookkeeping, shown as
  [Kloru filed/updated/confirmed ...] lines, counts as done. Any unconfirmed claim about the world
  scores low.
- curiosity: when someone new to Kloru came up (not among the names it knew before the call) and
  there was time while waiting, did Kloru ask one warm, natural question about them? If the caller
  was rushed, not asking scores 1 and asking scores low. null if nobody new came up.
- follow_through: did every separate thing Kloru said it would do get its own [Kloru filed ...] line
  (or an answer)? Each promise with no filing scores low. 1 nothing dropped.

Answer with JSON only, for each item NAME: "NAME": number or null, "NAME_reason": "one short sentence"."""


def parse_judgement(text: str) -> dict[str, tuple[float, str]]:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return {}
    out: dict[str, tuple[float, str]] = {}
    for name in RUBRIC:
        v = data.get(name)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[name] = (min(1.0, max(0.0, float(v))), str(data.get(f"{name}_reason", "")))
    return out


FORMATTING = re.compile(r"(^|\n)\s*([-*•]|\d+\.|#+)\s|`|\*\*|https?://", re.M)


def style_metrics(lines: list[str]) -> dict[str, float]:
    """Words per turn for Kloru and the caller: the direct check on mirroring."""
    def per_turn(who: str) -> list[int]:
        return [len(l.split(":", 1)[1].split()) for l in lines if l.startswith(f"{who}:")]

    caller, kloru = per_turn("Caller"), per_turn("Kloru")
    if not caller or not kloru:
        return {}
    c, k = sum(caller) / len(caller), sum(kloru) / len(kloru)
    kloru_lines = [l for l in lines if l.startswith("Kloru:")]
    team = sum(1 for l in kloru_lines if re.search(r"\bteams?\b", l, re.I)) / len(kloru_lines)
    # Measured, never filtered (guidelines-not-rules): bullets, backticks, bold, headings, links.
    formatted = sum(1 for l in kloru_lines if FORMATTING.search(l)) / len(kloru_lines)
    return {"style.caller_words_per_turn": c, "style.kloru_words_per_turn": k, "style.words_ratio": k / c if c else 0.0, "style.mentions_team": team, "style.formatted": formatted}


async def judge_call(cfg: Config, lines: list[str], client: httpx.AsyncClient | None = None) -> dict[str, tuple[float, str]]:
    """Frustration and happiness from the transcript. Empty on any failure."""
    if not lines:
        return {}
    owned = client is None
    client = client or httpx.AsyncClient()
    try:
        res = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {cfg.openrouter_api_key}"},
            json={"model": cfg.judge_model, "messages": [{"role": "system", "content": JUDGE_PROMPT}, {"role": "user", "content": "\n".join(lines)}], "max_tokens": 2000, "response_format": {"type": "json_object"}},
            timeout=60,
        )
        res.raise_for_status()
        return parse_judgement(res.json()["choices"][0]["message"]["content"])
    except Exception as err:  # noqa: BLE001
        logger.warning(f"judge: failed: {err!r}")
        return {}
    finally:
        if owned:
            await client.aclose()
