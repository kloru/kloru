import json
from datetime import datetime
from zoneinfo import ZoneInfo

from voice.bench.harness import Episode, run_scenario
from voice.bench.report import aggregate, regressions
from voice.bench.scenarios import SCENARIOS, Scenario, StubResult

NOW = datetime(2026, 10, 28, 9, 0, tzinfo=ZoneInfo("America/Los_Angeles"))


def scripted(replies):
    """A fake chat model that returns the scripted replies in order and records what it saw."""
    seen = []

    async def chat(messages, tools=None):
        seen.append({"messages": [dict(m) for m in messages], "tools": tools})
        return replies.pop(0) if replies else {"content": "[hang up]"}

    chat.seen = seen
    return chat


def say(text):
    return {"content": text, "tool_calls": []}


def file(request, text="On it."):
    return {"content": text, "tool_calls": [{"id": "t1", "name": "file_issue", "arguments": {"request": request}}]}


SC = Scenario(
    id="unit",
    persona="A busy parent who speaks briefly.",
    goal="Find out what's on tomorrow, then hang up.",
    opening="What's on tomorrow?",
    results=[StubResult(match="tomorrow", delay_s=30, kind="info", text="Dentist at 11:30.")],
)


async def test_a_filed_request_comes_back_after_its_delay_and_silences_get_keepalive_nudges():
    talker = scripted([
        file("What's on the owner's calendar tomorrow?", "Let me check."),
        say("Do you want the kids' calendars too?"),  # keepalive nudge reply
        say("You've got the dentist at 11:30."),     # result reply
        say("Bye!"),
    ])
    caller = scripted([{"content": "[wait]"}, {"content": "[wait]"}, {"content": "[wait]"}, {"content": "Thanks."}, {"content": "[hang up]"}])
    ep = await run_scenario(SC, talker, caller, NOW)
    assert isinstance(ep, Episode)
    text = "\n".join(ep.lines)
    assert ep.lines[0].startswith("[What Kloru knew before the call: Known names: Cleo")
    assert ep.lines[1] == "Caller: What's on tomorrow?"
    assert "Kloru: Let me check." in text
    assert "Kloru: Do you want the kids' calendars too?" in text
    assert "Kloru: You've got the dentist at 11:30." in text
    assert "[result arrives:" in text
    assert ep.filed == ["What's on the owner's calendar tomorrow?"]
    # The talking model saw the real front-desk prompt, the real tools, and a real keepalive nudge.
    first = talker.seen[0]
    assert "Their own guidelines win" in first["messages"][0]["content"]
    assert [t["function"]["name"] for t in first["tools"]] == ["file_issue", "update_issue", "confirm", "list_issues", "remember"]
    nudge_turn = talker.seen[1]["messages"][-1]
    assert nudge_turn["role"] == "developer" and "Nothing back yet" in nudge_turn["content"]
    result_turn = talker.seen[2]["messages"][-1]
    assert result_turn["content"].startswith('<info issue="1">Dentist at 11:30.')
    assert ep.metrics["silence.longest_gap_s"] < 25


async def test_a_reply_with_only_a_tool_call_gets_a_second_pass_to_speak():
    talker = scripted([{"content": "", "tool_calls": [{"id": "t1", "name": "file_issue", "arguments": {"request": "tomorrow"}}]}, say("Checking now."), say("ok")])
    caller = scripted([{"content": "[hang up]"}])
    ep = await run_scenario(SC, talker, caller, NOW)
    assert "Kloru: Checking now." in ep.lines
    assert talker.seen[1]["messages"][-1]["role"] == "tool"


async def test_never_mind_cancels_the_pending_result():
    talker = scripted([file("tomorrow"), {"content": "Okay, cancelled.", "tool_calls": [{"id": "t2", "name": "update_issue", "arguments": {"issue": 1, "text": "never mind"}}]}])
    caller = scripted([{"content": "Actually never mind."}, {"content": "[wait]"}, {"content": "[wait]"}, {"content": "[wait]"}, {"content": "[hang up]"}])
    ep = await run_scenario(SC, talker, caller, NOW)
    assert not any("[result arrives" in l for l in ep.lines)


async def test_the_brief_is_given_unless_turned_off():
    sc = Scenario(id="b", persona="p", goal="g", opening="hi", results=[], known="Tomorrow: dentist 11:30.")
    for brief, expect in ((False, False), (True, True)):
        talker = scripted([say("Hi")])
        await run_scenario(sc, talker, scripted([{"content": "[hang up]"}]), NOW, brief=brief)
        assert ("dentist 11:30" in talker.seen[0]["messages"][0]["content"]) is expect


async def test_the_caller_sees_the_conversation_from_their_side():
    talker = scripted([say("Hi Ezra, what can I do?")])
    caller = scripted([{"content": "[hang up]"}])
    await run_scenario(SC, talker, caller, NOW)
    msgs = caller.seen[0]["messages"]
    assert "busy parent" in msgs[0]["content"] and "[hang up]" in msgs[0]["content"]
    assert msgs[1] == {"role": "assistant", "content": "What's on tomorrow?"}
    assert msgs[2] == {"role": "user", "content": "Hi Ezra, what can I do?"}


def test_scenarios_are_well_formed():
    ids = [s.id for s in SCENARIOS]
    assert len(ids) >= 10 and len(set(ids)) == len(ids)
    for s in SCENARIOS:
        assert s.persona and s.goal and s.opening


def test_aggregate_and_regressions():
    runs = [{"clarifying": 0.8, "filler": 0.2, "silence.longest_gap_s": 6.0}, {"clarifying": 0.6, "filler": 0.4}]
    agg = aggregate(runs)
    assert agg["clarifying"] == 0.7 and agg["filler"] == 0.30000000000000004 or abs(agg["filler"] - 0.3) < 1e-9
    base = {"clarifying": 0.85, "filler": 0.1, "silence.longest_gap_s": 5.0, "happiness": 0.5}
    found = regressions(agg, base)
    assert any(r.startswith("clarifying") for r in found)
    assert any(r.startswith("filler") for r in found)
    assert not any(r.startswith("silence") for r in found)
    assert regressions(base, base) == []


async def test_silence_is_counted_from_when_kloru_stops_speaking():
    talker = scripted([file("tomorrow", "I'll check your calendar now, that usually takes about thirty seconds to come back."), say("Which calendars?"), say("ok")])
    caller = scripted([{"content": "[wait]"}, {"content": "[hang up]"}])
    ep = await run_scenario(SC, talker, caller, NOW)
    silence = next(l for l in ep.lines if "seconds of silence" in l)
    assert silence in ("[11 seconds of silence]", "[12 seconds of silence]")


def test_regressions_compare_only_scenarios_scored_in_both_runs():
    from voice.bench.report import regressions_by_scenario

    base = {"a": {"prepared": 1.0, "filler": 0.3}, "b": {"prepared": 0.2}}
    now = {"a": {"prepared": 1.0, "filler": 0.0}, "b": {"prepared": 0.4}, "c": {"prepared": 0.0}}
    assert regressions_by_scenario(now, base) == []
    worse = regressions_by_scenario({"a": {"prepared": 0.5}, "b": {"prepared": 0.2}}, base)
    assert worse and worse[0].startswith("prepared")


async def test_kloru_s_own_actions_are_shown_to_the_judge():
    talker = scripted([file("tomorrow", "Checking."), {"content": "Noted.", "tool_calls": [{"id": "t2", "name": "update_issue", "arguments": {"issue": 1, "text": "include the kids"}}]}])
    caller = scripted([{"content": "Include the kids."}, {"content": "[hang up]"}])
    ep = await run_scenario(SC, talker, caller, NOW)
    assert "[Kloru filed issue 1: tomorrow]" in ep.lines
    assert "[Kloru updated issue 1: include the kids]" in ep.lines


async def test_the_talking_model_s_real_response_time_is_measured():
    import asyncio as aio

    async def slow(messages, tools=None):
        await aio.sleep(0.05)
        return {"content": "Hi.", "tool_calls": []}

    ep = await run_scenario(SC, slow, scripted([{"content": "[hang up]"}]), NOW)
    assert ep.metrics["talker.latency_p50_s"] >= 0.04
    assert ep.metrics["talker.latency_max_s"] >= ep.metrics["talker.latency_p50_s"]


def test_repeats_average_per_scenario():
    from voice.bench.report import average_repeats

    reps = {"a": [{"clarifying": 0.6, "filler": 0.2}, {"clarifying": 0.8}], "b": [{"filler": 0.1}]}
    assert average_repeats(reps) == {"a": {"clarifying": 0.7, "filler": 0.2}, "b": {"filler": 0.1}}


async def test_a_quiet_reply_is_silence_on_the_bench_too():
    talker = scripted([file("tomorrow", "About 30 seconds."), say("[quiet]"), say("Dentist at 11:30.")])
    caller = scripted([{"content": "[wait]"}, {"content": "[wait]"}, {"content": "[hang up]"}])
    ep = await run_scenario(SC, talker, caller, NOW)
    assert not any("[quiet]" in l for l in ep.lines)


async def test_one_request_asking_for_two_things_gets_both_results():
    sc = Scenario(id="two", persona="p", goal="g", opening="Schedule and weather?", results=[
        StubResult("weather", 5, "info", "Sunny."), StubResult("schedule", 8, "info", "Dentist 11:30."),
    ])
    talker = scripted([file("schedule and weather tomorrow", "Checking."), say("Sunny tomorrow."), say("And the dentist at 11:30.")])
    caller = scripted([{"content": "[wait]"}, {"content": "[wait]"}, {"content": "[hang up]"}])
    ep = await run_scenario(sc, talker, caller, NOW)
    arrived = [l for l in ep.lines if l.startswith("[result arrives")]
    assert arrived == ["[result arrives: Sunny.]", "[result arrives: Dentist 11:30.]"]


def test_response_times_never_count_as_regressions():
    from voice.bench.report import regressions

    assert regressions({"talker.latency_max_s": 3.6, "talker.latency_p50_s": 2.0}, {"talker.latency_max_s": 3.9, "talker.latency_p50_s": 2.4}) == []
