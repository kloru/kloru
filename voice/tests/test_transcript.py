import json
from datetime import datetime, timedelta, timezone

from voice.transcript import Transcript, prune_transcripts

T0 = datetime(2026, 10, 27, 22, 42, 33, tzinfo=timezone.utc)


def read(path):
    return [json.loads(l) for l in path.read_text().splitlines()]


def test_turns_and_task_events_are_written_as_they_happen(tmp_path):
    t = Transcript(tmp_path, "CA1", "+14155550190", clock=lambda: T0)
    t.caller("What's on my calendar Wednesday?")
    t.task_started(1, "Check all of the owner's calendars for Wednesday, October 28, 2026.", "quick")
    t.kloru("Let me look.", interrupted=False)
    t.task_finished(1, "done", "Four events: drop-off at 8...")
    t.kloru("You've got four things", interrupted=True)
    t.ended()
    path = tmp_path / "2026-10-27" / "CA1.jsonl"
    got = read(path)
    assert got[0] == {"at": "2026-10-27T22:42:33Z", "kind": "call_started", "call_sid": "CA1", "from": "+14155550190"}
    assert [e["kind"] for e in got] == ["call_started", "caller", "task_started", "kloru", "task_finished", "kloru", "call_ended"]
    assert got[1]["text"] == "What's on my calendar Wednesday?"
    assert got[2] == {"at": "2026-10-27T22:42:33Z", "kind": "task_started", "task": 1, "request": "Check all of the owner's calendars for Wednesday, October 28, 2026.", "size": "quick"}
    assert got[4]["status"] == "done" and got[4]["result"].startswith("Four events")
    assert got[5]["interrupted"] is True


def test_results_after_hangup_land_in_the_same_transcript(tmp_path):
    t = Transcript(tmp_path, "CA1", "+14155550190", clock=lambda: T0)
    t.ended()
    t.task_finished(2, "done", "No one is named for drop-off.", after_call=True)
    assert read(tmp_path / "2026-10-27" / "CA1.jsonl")[-1]["after_call"] is True


def test_a_broken_disk_never_breaks_a_call(tmp_path):
    (tmp_path / "2026-10-27").write_text("a file where the directory should be")
    t = Transcript(tmp_path, "CA1", "+14155550190", clock=lambda: T0)
    t.caller("hello")  # no exception


def test_call_sids_cannot_escape_the_directory(tmp_path):
    t = Transcript(tmp_path, "../../etc/x", "+1", clock=lambda: T0)
    t.caller("hi")
    assert not (tmp_path.parent.parent / "etc").exists()
    assert list((tmp_path / "2026-10-27").iterdir())[0].name == "etcx.jsonl"


def test_days_older_than_90_are_pruned(tmp_path):
    for day in ("2026-07-01", "2026-10-01", "not-a-date"):
        (tmp_path / day).mkdir()
        (tmp_path / day / "CA1.jsonl").write_text("{}\n")
    prune_transcripts(tmp_path, now=T0)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["2026-10-01", "not-a-date"]
