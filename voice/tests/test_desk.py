import asyncio
import json

import httpx
import pytest

from voice.config import load_config
from voice.desk import DeskClient
from tests.test_config import FULL

CFG = load_config({**FULL, "VOICE_DESK": "on"})


def transport(log, inbox_batches=None):
    batches = list(inbox_batches or [])

    async def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        log.append((request.method, request.url.path, dict(request.url.params), body))
        assert request.headers["authorization"] == "Bearer chat"
        path = request.url.path
        if path == "/desk/calls":
            return httpx.Response(200, json={"call": {"id": "2026-10-28T1803Z-1-CA1"}, "pending": 1, "brief": "Caller: Evan\nPeople: Maya: daughter, 3"})
        if path.endswith("/turns"):
            await asyncio.sleep(0.01)
            return httpx.Response(200, json={"n": 1})
        if path == "/desk/issues":
            assert request.url.params["call"] == "2026-10-28T1803Z-1-CA1"  # only this caller's issues
            return httpx.Response(200, json={"issues": [{"id": 7, "status": "in_progress", "request": "check Wednesday"}]})
        if path.endswith("/issues"):
            return httpx.Response(200, json={"issue": {"id": 7, "status": "open"}})
        if path.endswith("/confirm"):
            return httpx.Response(409, json={"error": "issue 7 isn't waiting for a yes"})
        if path.endswith("/inbox"):
            if batches:
                return httpx.Response(200, json={"items": batches.pop(0), "ended": False})
            await asyncio.sleep(0.05)
            return httpx.Response(200, json={"items": [], "ended": True})
        if path == "/desk/issues":
            return httpx.Response(200, json={"issues": [{"id": 7, "status": "in_progress", "request": "check Wednesday"}]})
        return httpx.Response(200, json={"ok": True})

    return httpx.MockTransport(handle)


async def test_start_file_comment_confirm_and_end():
    log = []
    desk = DeskClient(CFG, client=httpx.AsyncClient(transport=transport(log)))
    assert await desk.start("CA1", "+14155550190") == 1
    assert desk.call_id == "2026-10-28T1803Z-1-CA1"
    issue = await desk.file_issue("Check Wednesday")
    assert issue["id"] == 7
    await desk.comment(7, "never mind")
    assert await desk.confirm(7, "ab12cd34") == "issue 7 isn't waiting for a yes"
    await desk.ack(3)
    assert (await desk.list_issues())[0]["request"] == "check Wednesday"
    await desk.end()
    paths = [(m, p) for m, p, _, _ in log]
    assert ("POST", "/desk/calls") in paths
    assert ("POST", "/desk/calls/2026-10-28T1803Z-1-CA1/issues") in paths
    assert ("POST", "/desk/issues/7/comments") in paths
    assert ("POST", "/desk/calls/2026-10-28T1803Z-1-CA1/end") in paths
    assert [b for _, p, _, b in log if p.endswith("/confirm")] == [{"call": "2026-10-28T1803Z-1-CA1", "draft": "ab12cd34"}]
    assert [b for _, p, _, b in log if p.endswith("/ack")] == [{"seq": 3}]
    assert log[0][3] == {"callSid": "CA1", "phone": "+14155550190", "channel": "voice"}


async def test_turns_are_posted_in_order_and_before_an_issue_is_filed():
    log = []
    desk = DeskClient(CFG, client=httpx.AsyncClient(transport=transport(log)))
    await desk.start("CA1", "+1")
    desk.add_turn("caller", "Create an event Wednesday")
    desk.add_turn("kloru", "Sure", interrupted=True)
    desk.add_turn("caller", "at 3")
    await desk.file_issue("Create an event Wednesday at 3")
    kinds = [(p.rsplit("/", 1)[-1], b) for _, p, _, b in log[1:]]
    assert kinds == [
        ("turns", {"role": "caller", "text": "Create an event Wednesday"}),
        ("turns", {"role": "kloru", "text": "Sure", "interrupted": True}),
        ("turns", {"role": "caller", "text": "at 3"}),
        ("issues", {"request": "Create an event Wednesday at 3"}),
    ]
    await desk.close()


async def test_follow_delivers_merges_in_order_and_acknowledges_them():
    log = []
    got = []
    batches = [[{"seq": 1, "kind": "info", "text": "From an earlier call: done", "issue": 3}], [{"seq": 2, "kind": "events", "text": "Created Coffee", "issue": 4}]]
    desk = DeskClient(CFG, client=httpx.AsyncClient(transport=transport(log, batches)))
    await desk.start("CA1", "+1")

    async def on_merge(item):
        got.append(item)

    await asyncio.wait_for(desk.follow(on_merge), timeout=2)
    assert [g["seq"] for g in got] == [1, 2]
    afters = [q.get("after") for m, p, q, _ in log if p.endswith("/inbox")]
    assert afters[:3] == ["0", "1", "2"]


async def test_follow_survives_a_failing_agent():
    calls = {"n": 0}

    async def handle(request):
        if request.url.path == "/desk/calls":
            return httpx.Response(200, json={"call": {"id": "c"}, "pending": 0})
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, json={"error": "boom"})
        if calls["n"] == 2:
            return httpx.Response(200, json={"items": [{"seq": 1, "kind": "info", "text": "ok"}], "ended": False})
        return httpx.Response(200, json={"items": [], "ended": True})

    got = []
    desk = DeskClient(CFG, client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), retry_s=0.01)
    await desk.start("CA1", "+1")

    async def on_merge(item):
        got.append(item["text"])

    await asyncio.wait_for(desk.follow(on_merge), timeout=2)
    assert got == ["ok"]


def test_merge_messages_are_tagged_for_the_talking_model():
    from voice.desk import merge_message

    assert merge_message({"seq": 1, "kind": "info", "text": "Dentist at 11:30", "issue": 3}) == '<info issue="3">Dentist at 11:30</info>'
    assert merge_message({"seq": 1, "kind": "info", "text": "Send it?", "issue": 3, "draft": "ab12cd34"}) == '<info issue="3" draft="ab12cd34">Send it?</info>'
    assert merge_message({"seq": 2, "kind": "events", "text": "Sent to Sam"}) == "<events>Sent to Sam</events>"


def test_config_reads_the_desk_switch():
    assert not load_config(FULL).desk_enabled
    assert load_config({**FULL, "VOICE_DESK": "on"}).desk_enabled


async def test_calls_fail_fast_when_the_desk_never_opened():
    from voice.desk import DeskUnavailable

    desk = DeskClient(CFG, client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    with pytest.raises(Exception):
        await desk.start("CA1", "+1")
    desk.add_turn("caller", "hello")
    with pytest.raises(DeskUnavailable):
        await asyncio.wait_for(desk.file_issue("x"), timeout=1)
    with pytest.raises(DeskUnavailable):
        await asyncio.wait_for(desk.comment(1, "x"), timeout=1)


async def test_a_bad_merge_handler_does_not_stop_following():
    batches = [[{"seq": 1, "kind": "info", "text": "boom"}, {"seq": 2, "kind": "info", "text": "fine"}]]
    desk = DeskClient(CFG, client=httpx.AsyncClient(transport=transport([], batches)))
    await desk.start("CA1", "+1")
    got = []

    async def on_merge(item):
        if item["text"] == "boom":
            raise RuntimeError("bad")
        got.append(item["text"])

    await asyncio.wait_for(desk.follow(on_merge), timeout=2)
    assert got == ["fine"]


async def test_waiting_results_can_be_taken_at_once_and_following_starts_after_them():
    log = []
    batches = [[{"seq": 1, "kind": "info", "text": "From an earlier call: one email", "issue": 3}], [{"seq": 2, "kind": "events", "text": "Deleted it", "issue": 4}]]
    desk = DeskClient(CFG, client=httpx.AsyncClient(transport=transport(log, batches)))
    await desk.start("CA1", "+1")
    waiting = await desk.waiting()
    assert [w["seq"] for w in waiting] == [1]
    got = []

    async def on_merge(item):
        got.append(item["seq"])

    await asyncio.wait_for(desk.follow(on_merge, after=1), timeout=2)
    assert got == [2]
    polls = [(q.get("after"), q.get("wait")) for _, p, q, _ in log if p.endswith("/inbox")]
    assert polls[0] == ("0", "0")
    assert polls[1][0] == "1"


def test_one_greeting_carries_results_waiting_from_earlier_calls():
    from voice.bot import greeting_for

    plain = greeting_for([])
    assert "Greet the caller" in plain
    text = greeting_for([{"seq": 1, "kind": "info", "text": "From an earlier call: one email from Credit Karma", "issue": 3}])
    assert "one email from Credit Karma" in text and '<info issue="3">' in text
    assert "one reply" in text


async def test_start_keeps_the_brief_and_notes_go_to_the_call():
    log = []
    desk = DeskClient(CFG, client=httpx.AsyncClient(transport=transport(log)))
    await desk.start("CA1", "+14155550190")
    assert "Maya" in desk.brief
    await desk.note("Maya is allergic to peanuts")
    assert ("POST", "/desk/calls/2026-10-28T1803Z-1-CA1/notes", {}, {"text": "Maya is allergic to peanuts"}) in log
