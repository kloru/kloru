import json

from pipecat.frames.frames import ErrorFrame
from pipecat.observers.speaking_observer import SpeechEvent, SpeechEventKind as K

from voice.checks import CallFacts, ErrorTally, alert, run_checks
from voice.turns import Stats


def facts(**kw) -> CallFacts:
    base = dict(turns=Stats(replies=2), repeats_blocked=0, errors=[], events=[SpeechEvent(kind=K.BOT_SPEECH_STARTED, timestamp=1.0)], caller_spoke=True, metrics={})
    return CallFacts(**(base | kw))


def names(failures) -> list[str]:
    return [f.name for f in failures]


def test_a_clean_call_passes_every_check():
    assert run_checks(facts()) == []


def test_the_silent_call_from_the_voice_provider_402_fails_loudly():
    # Call CA84bd0d…: Cartesia refused every request; Kloru wrote words, the caller heard nothing.
    f = run_checks(facts(turns=Stats(replies=2, no_audio=2), errors=["CartesiaTTSService#1: server rejected WebSocket connection: HTTP 402"], events=[]))
    assert names(f) == ["voice_errors", "no_audio"]
    assert "HTTP 402" in f[0].detail


def test_a_reply_nobody_asked_for_and_a_blocked_repeat_are_both_caught():
    # Call CA393c42…: a second reply to the same moment repeated the first.
    f = run_checks(facts(turns=Stats(replies=3, unexpected_replies=1), repeats_blocked=2))
    assert names(f) == ["double_reply", "repeat_blocked"]


def test_a_result_that_waited_too_long_and_a_slow_reply_fail():
    f = run_checks(facts(turns=Stats(replies=2, longest_owed_wait_s=31.0), metrics={"latency.reply_max_s": 9.5}))
    assert names(f) == ["slow_result", "slow_reply"]


def test_a_hang_up_before_speaking_is_not_a_failure():
    assert run_checks(facts(caller_spoke=False, events=[], turns=Stats())) == []


def test_errors_are_tallied_once_per_frame():
    tally = ErrorTally()
    frame = ErrorFrame(error="HTTP 402")
    for _ in range(3):  # the same frame seen at each hop
        tally.record("CartesiaTTSService#1", frame)
    tally.record("CartesiaTTSService#1", ErrorFrame(error="HTTP 402"))
    assert tally.errors == ["CartesiaTTSService#1: HTTP 402"] * 2  # two refusals, each counted once


async def test_alerts_land_in_a_file_the_next_session_can_read(tmp_path):
    path = tmp_path / "alerts.jsonl"
    failures = run_checks(facts(turns=Stats(replies=1, no_audio=1)))
    await alert("CA1", failures, str(path))
    (line,) = path.read_text().splitlines()
    rec = json.loads(line)
    assert rec["call_sid"] == "CA1" and rec["failures"][0]["name"] == "no_audio"


def test_full_logs_are_kept_on_the_volume_next_to_the_call_log():
    from dataclasses import replace

    from tests.test_bot import CFG
    from voice.main import log_path

    assert log_path(replace(CFG, call_log_path="/data/voice/calls.jsonl")) == "/data/voice/logs/voice.log"
    assert log_path(replace(CFG, call_log_path=None)) is None
