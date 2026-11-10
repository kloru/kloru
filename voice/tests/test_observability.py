import base64
import json

import httpx
import pytest
from pipecat.observers.speaking_observer import SpeechEvent, SpeechEventKind as K

from voice.config import load_config
from voice.observability import RUBRIC, LangfuseClient, call_metrics, judge_call, langfuse_otlp, parse_judgement, style_metrics
from tests.test_config import FULL

LF = {**FULL, "LANGFUSE_PUBLIC_KEY": "pk-lf-1", "LANGFUSE_SECRET_KEY": "sk-lf-2", "LANGFUSE_BASE_URL": "https://us.cloud.langfuse.com"}


def ev(kind, t, started=None):
    return SpeechEvent(kind=kind, timestamp=t, started_at=started)


def test_config_reads_langfuse_and_judge_model():
    assert load_config(FULL).langfuse is None
    cfg = load_config(LF)
    assert cfg.langfuse == ("https://us.cloud.langfuse.com", "pk-lf-1", "sk-lf-2")
    assert cfg.judge_model == "openai/gpt-6.1-terra"


def test_otlp_endpoint_and_auth():
    url, headers = langfuse_otlp(load_config(LF).langfuse)
    assert url == "https://us.cloud.langfuse.com/api/public/otel/v1/traces"
    assert headers == {"Authorization": "Basic " + base64.b64encode(b"pk-lf-1:sk-lf-2").decode()}


def test_call_metrics_measure_silence_reply_latency_and_end_of_turn_delay():
    events = [
        ev(K.BOT_SPEECH_STARTED, 0.0), ev(K.BOT_SPEECH_STOPPED, 2.0, 0.0),
        ev(K.USER_SPEECH_STARTED, 3.0), ev(K.USER_SPEECH_STOPPED, 5.0, 3.0), ev(K.USER_TURN_STOPPED, 5.8),
        ev(K.BOT_SPEECH_STARTED, 7.0), ev(K.BOT_SPEECH_STOPPED, 9.0, 7.0),
        # 41 seconds of nobody talking while work runs
        ev(K.BOT_SPEECH_STARTED, 50.0), ev(K.INTERRUPTION, 51.0),
        ev(K.USER_SPEECH_STARTED, 51.0), ev(K.BOT_SPEECH_STOPPED, 51.2, 50.0),
        ev(K.USER_SPEECH_STOPPED, 53.0, 51.0), ev(K.USER_TURN_STOPPED, 56.0),
        ev(K.BOT_SPEECH_STARTED, 60.0), ev(K.BOT_SPEECH_STOPPED, 61.0, 60.0),
    ]
    m = call_metrics(events)
    assert m["silence.longest_gap_s"] == pytest.approx(41.0)
    assert m["silence.gaps_over_2s"] == 2
    assert m["silence.dead_air_s"] == pytest.approx(41.0 + 7.0)
    assert m["latency.reply_max_s"] == pytest.approx(4.0)
    assert m["latency.reply_p50_s"] == pytest.approx(4.0)
    assert m["turn.end_delay_max_s"] == pytest.approx(3.0)
    assert m["turn.end_delay_p50_s"] == pytest.approx(3.0)
    assert m["interruptions"] == 1
    assert m["call.duration_s"] == pytest.approx(61.0)


def test_call_metrics_on_an_empty_call():
    assert call_metrics([]) == {}


async def test_scores_are_posted_to_the_call_session():
    seen = []

    async def handle(req):
        seen.append((req.url.path, req.headers["authorization"], json.loads(req.content)))
        return httpx.Response(200, json={"id": "s1"})

    lf = LangfuseClient(load_config(LF).langfuse, client=httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    await lf.scores("CA1", {"silence.longest_gap_s": 41.0, "interruptions": 1}, comments={"interruptions": "one barge-in"})
    assert [p for p, _, _ in seen] == ["/api/public/scores", "/api/public/scores"]
    assert seen[0][1].startswith("Basic ")
    assert seen[0][2] == {"name": "silence.longest_gap_s", "value": 41.0, "sessionId": "CA1", "dataType": "NUMERIC"}
    assert seen[1][2]["comment"] == "one barge-in"


async def test_score_failures_never_raise():
    lf = LangfuseClient(load_config(LF).langfuse, client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    await lf.scores("CA1", {"x": 1.0})


def test_parse_judgement_clamps_and_tolerates_noise():
    assert parse_judgement('Sure! {"frustration": 0.7, "happiness": 1.4, "frustration_reason": "asked twice", "happiness_reason": "got it done"}') == {
        "frustration": (0.7, "asked twice"),
        "happiness": (1.0, "got it done"),
    }
    assert parse_judgement("no json here") == {}
    assert parse_judgement('{"frustration": "high"}') == {}


async def test_judge_call_asks_the_model_and_parses():
    async def handle(req):
        body = json.loads(req.content)
        assert body["model"] == "openai/gpt-6.1-terra"
        # Nine scores with reasons don't fit in a small budget; a cut-off answer scores nothing.
        assert body["max_tokens"] >= 1500
        assert body["response_format"] == {"type": "json_object"}
        assert "Caller: Did you put the event" in body["messages"][-1]["content"]
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"frustration": 0.4, "happiness": 0.6, "frustration_reason": "r1", "happiness_reason": "r2"}'}}]})

    cfg = load_config(LF)
    out = await judge_call(cfg, ["Caller: Did you put the event", "Kloru: Not yet"], client=httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    assert out == {"frustration": (0.4, "r1"), "happiness": (0.6, "r2")}


def test_the_rubric_covers_the_smart_person_traits():
    assert RUBRIC == ["frustration", "happiness", "clarifying", "expectations", "teaching", "attunement", "prepared", "mirroring", "filler", "accuracy", "follow_through", "curiosity"]


def test_parse_judgement_reads_every_rubric_score_and_skips_not_applicable():
    text = json.dumps({
        "frustration": 0.2, "frustration_reason": "calm",
        "clarifying": 0.9, "clarifying_reason": "asked which calendar",
        "attunement": None, "attunement_reason": "caller was never frustrated",
        "filler": 0.5, "filler_reason": "two of four lines were 'still working'",
    })
    got = parse_judgement(text)
    assert got["clarifying"] == (0.9, "asked which calendar")
    assert got["filler"] == (0.5, "two of four lines were 'still working'")
    assert "attunement" not in got


def test_style_metrics_compare_kloru_and_caller_words_per_turn():
    lines = ["Caller: email", "Kloru: Sure, I'll pull up today's unread email now and go through it with you.", "Caller: thanks", "Kloru: Okay."]
    m = style_metrics(lines)
    assert m["style.caller_words_per_turn"] == 1.0
    assert m["style.kloru_words_per_turn"] == 7.5
    assert m["style.words_ratio"] == 7.5
    assert style_metrics(["Kloru: hi"]) == {}


async def test_scores_can_be_tagged_with_an_environment():
    seen = []

    async def handle(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"id": "s1"})

    lf = LangfuseClient(load_config(LF).langfuse, client=httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    await lf.scores("bench-1-x", {"clarifying": 0.5}, environment="bench")
    assert seen[0]["environment"] == "bench"


def test_style_metrics_count_lines_that_mention_a_team():
    lines = ["Caller: email", "Kloru: I'm checking now.", "Caller: ok", "Kloru: The team is still on it.", "[Kloru filed issue 1: email]"]
    assert style_metrics(lines)["style.mentions_team"] == 0.5


def test_style_metrics_count_lines_with_formatting_a_caller_cant_hear():
    lines = [
        "Caller: read me Friday",
        "Kloru: Friday, October 30:\n- 7 AM: W14\n- 8 AM: Drop off Nora",
        "Kloru: You may mean Docker's `sbx` sandbox command.",
        "Kloru: Friday you have three things: your shift at 7, drop-off at 8, and the party at 4.",
        "Kloru: It's on a page; the link is https://kloru.com/a/x",
    ]
    assert style_metrics(lines)["style.formatted"] == 0.75
