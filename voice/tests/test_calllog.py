import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from voice.app import create_app
from voice.calllog import CallLog
from voice.config import load_config
from tests.test_app import CFG, no_call, post
from tests.test_config import FULL

T0 = datetime(2026, 10, 27, 20, 0, tzinfo=timezone.utc)


def lines(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def test_every_webhook_outcome_is_recorded(tmp_path):
    log = CallLog(tmp_path / "calls.jsonl", clock=lambda: T0)
    c = TestClient(create_app(CFG, no_call, call_log=log))
    post(c, {"From": "+14155550100", "CallSid": "CA1", "StirVerstat": "TN-Validation-Passed-A"})
    post(c, {"From": "+14155550100", "CallSid": "CA2", "StirVerstat": "TN-Validation-Passed-C"})
    post(c, {"From": "+1 999-555-0000", "CallSid": "CA3", "StirVerstat": "TN-Validation-Passed-A"})
    c.post("/twilio/voice", data={"From": "+14155550100", "CallSid": "CA4"}, headers={"Fly-Client-IP": "203.0.113.9"})
    got = lines(tmp_path / "calls.jsonl")
    assert [(e["call_sid"], e["outcome"]) for e in got] == [
        ("CA1", "connected"), ("CA2", "hung_up_attestation"), ("CA3", "refused_unknown"), ("CA4", "bad_signature")]
    assert got[0] == {"at": "2026-10-27T20:00:00Z", "call_sid": "CA1", "from": "+14155550100", "verstat": "TN-Validation-Passed-A", "outcome": "connected"}
    assert got[2]["from"] == "+19995550000"
    assert got[3]["ip"] == "203.0.113.9"


def test_entries_older_than_90_days_are_pruned(tmp_path):
    path = tmp_path / "calls.jsonl"
    old = {"at": "2026-07-01T00:00:00Z", "call_sid": "OLD", "outcome": "connected"}
    recent = {"at": "2026-10-01T00:00:00Z", "call_sid": "NEW", "outcome": "connected"}
    path.write_text(json.dumps(old) + "\n" + "not json\n" + json.dumps(recent) + "\n")
    now = [T0]
    log = CallLog(path, clock=lambda: now[0])
    assert [e["call_sid"] for e in lines(path)] == ["NEW"]
    now[0] = T0 + timedelta(days=70)
    log.record({"call_sid": "LATER", "outcome": "connected"})
    assert [e["call_sid"] for e in lines(path)] == ["LATER"]


def test_a_broken_log_never_breaks_a_call(tmp_path):
    log = CallLog(tmp_path / "no-such-dir" / "x" / "calls.jsonl", clock=lambda: T0)
    (tmp_path / "no-such-dir").write_text("a file, not a directory")
    r = post(TestClient(create_app(CFG, no_call, call_log=log)), {"From": "+14155550100", "CallSid": "CA1", "StirVerstat": "TN-Validation-Passed-A"})
    assert "<Stream" in r.text


def test_config_reads_the_log_path():
    assert load_config(FULL).call_log_path is None
    assert load_config({**FULL, "CALL_LOG_PATH": "/data/voice/calls.jsonl"}).call_log_path == "/data/voice/calls.jsonl"
