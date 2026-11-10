import asyncio
from dataclasses import replace
from types import SimpleNamespace

from datetime import datetime
from zoneinfo import ZoneInfo

from pipecat.frames.frames import LLMFullResponseStartFrame, LLMTextFrame

from voice.bot import SYSTEM_PROMPT, TOOLS, SpeechTracker, llm_settings, make_tool_handlers, system_prompt, task_result_message, turn_strategies
from voice.config import load_config
from voice.tasks import Task, TaskBoard
from tests.test_config import FULL

CFG = load_config(FULL)


class Results:
    def __init__(self):
        self.calls = []

    async def __call__(self, result, properties=None):
        self.calls.append((result, properties))


def board_with(run=None):
    async def default_run(request, conversation_id):
        await asyncio.sleep(10)

    async def on_done(task):
        pass

    return TaskBoard("CA9", run or default_run, on_done)


async def test_start_task_returns_immediately_with_an_id():
    board = board_with()
    handlers = make_tool_handlers(board)
    results = Results()
    await asyncio.wait_for(handlers["start_task"](SimpleNamespace(arguments={"request": "clean up my inbox", "size": "long"}, result_callback=results)), 0.5)
    (result, _), = results.calls
    assert result == {"task_id": "1", "status": "started", "size": "long"}
    assert board.summary()[0]["request"] == "clean up my inbox"
    await board.cancel_all()


async def test_remember_is_a_quiet_task_and_does_not_trigger_a_reply():
    seen = []

    async def run(request, conversation_id):
        seen.append(request)
        return "Saved."

    board = board_with(run)
    results = Results()
    await make_tool_handlers(board)["remember"](SimpleNamespace(arguments={"fact": "Plans tomorrow every evening"}, result_callback=results))
    await asyncio.sleep(0)
    (result, props), = results.calls
    assert result == {"saved": True}
    assert props.run_llm is False
    assert board.summary() == []  # quiet tasks are not listed to the owner
    assert "Plans tomorrow every evening" in seen[0] and "durable memory" in seen[0]


async def test_list_tasks_reports_board():
    board = board_with()
    board.start("check calendar")
    results = Results()
    await make_tool_handlers(board)["list_tasks"](SimpleNamespace(arguments={}, result_callback=results))
    assert results.calls[0][0] == {"tasks": board.summary()}
    await board.cancel_all()


def test_task_result_message_names_the_request():
    msg = task_result_message(Task(id="2", request="check calendar", size="quick", quiet=False, status="done", result="Lunch at noon."))
    assert "check calendar" in msg and "Lunch at noon." in msg


def test_tools_and_prompt():
    assert {t.name for t in TOOLS.standard_tools} == {"start_task", "list_tasks", "remember"}
    for rule in ("start_task", "remember", "never", "question"):
        assert rule in SYSTEM_PROMPT


def test_turn_strategies_use_configured_silence_fallback():
    strategies = turn_strategies(replace(CFG, turn_stop_secs=0.8))
    (stop,) = strategies.stop
    assert stop._turn_analyzer.params.stop_secs == 0.8


class Owed:
    def __init__(self):
        self.calls: list[tuple[str, bool]] = []

    async def __call__(self, call_id, needs_reply):
        self.calls.append((call_id, needs_reply))


async def test_start_task_never_runs_the_model_and_owes_nothing_when_the_model_spoke():
    board, results, owed = board_with(), Results(), Owed()
    await make_tool_handlers(board, spoke=lambda _id: True, owe=owed)["start_task"](SimpleNamespace(tool_call_id="c1", arguments={"request": "check calendar", "size": "quick"}, result_callback=results))
    (_, props), = results.calls
    assert props.run_llm is False
    assert owed.calls == [("c1", False)]
    await board.cancel_all()


async def test_start_task_owes_the_caller_words_when_the_model_was_silent():
    board, results, owed = board_with(), Results(), Owed()
    await make_tool_handlers(board, spoke=lambda _id: False, owe=owed)["start_task"](SimpleNamespace(tool_call_id="c1", arguments={"request": "check calendar", "size": "quick"}, result_callback=results))
    (_, props), = results.calls
    assert props.run_llm is False
    assert owed.calls == [("c1", True)]
    await board.cancel_all()


def test_speech_tracker_resets_per_response():
    t = SpeechTracker()
    t.observe(LLMFullResponseStartFrame())
    t.observe(LLMTextFrame("[quiet]"))
    assert not t.spoke  # declining to speak isn't speech
    t.observe(LLMFullResponseStartFrame())
    assert not t.spoke
    t.observe(LLMTextFrame(" "))
    assert not t.spoke
    t.observe(LLMTextFrame("Sure, checking."))
    assert t.spoke
    t.observe(LLMFullResponseStartFrame())
    assert not t.spoke


def test_system_prompt_states_the_owners_local_time():
    now = datetime(2026, 10, 26, 11, 5, tzinfo=ZoneInfo("America/Los_Angeles"))
    p = system_prompt(now)
    assert p.startswith(SYSTEM_PROMPT)
    assert "Monday, October 26, 2026" in p and "11:05 AM" in p and "America/Los_Angeles" in p


def test_prompt_speaks_before_calling_start_task_and_checks_every_calendar():
    assert "say a few spoken words" in SYSTEM_PROMPT
    assert "all of the owner's calendars" in SYSTEM_PROMPT


def test_llm_settings_turn_reasoning_down():
    s = llm_settings(CFG, "prompt")
    assert s.model == CFG.voice_model and s.system_instruction == "prompt"
    assert s.extra == {"extra_body": {"reasoning": {"effort": "minimal"}}}
    assert llm_settings(replace(CFG, voice_reasoning_effort="low"), "p").extra["extra_body"]["reasoning"]["effort"] == "low"


def test_deepgram_opts_out_of_model_improvement():
    from voice.bot import make_stt

    stt = make_stt(replace(CFG, stt="nova"))
    assert stt._build_connect_kwargs()["mip_opt_out"] == "true"


def test_flux_is_the_default_and_takes_over_turn_detection():
    from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
    from voice.bot import make_stt, user_params

    assert CFG.stt == "flux"
    stt = make_stt(CFG)
    assert isinstance(stt, DeepgramFluxSTTService)
    assert stt._mip_opt_out is True
    assert stt._settings.model == "flux-general-en"
    # No turn strategy of ours: Flux's own start/end-of-turn events decide turns.
    params = user_params(CFG)
    assert params.user_turn_strategies is None
    assert params.vad_analyzer is not None  # kept for the speech timing scores only


def test_nova_keeps_the_silence_based_turn_strategy():
    from voice.bot import user_params

    params = user_params(replace(CFG, stt="nova"))
    assert params.user_turn_strategies is not None


def test_config_reads_the_stt_switch():
    assert load_config({**FULL, "VOICE_STT": "nova"}).stt == "nova"
    assert load_config({**FULL, "VOICE_STT": "bogus"}).stt == "flux"


class FakeDesk:
    def __init__(self):
        self.filed, self.comments, self.confirmed = [], [], []
        self.confirm_error = None

    async def file_issue(self, request):
        self.filed.append(request)
        return {"id": len(self.filed), "status": "open"}

    async def comment(self, issue, text):
        self.comments.append((issue, text))

    async def confirm(self, issue, draft):
        self.confirmed.append((issue, draft))
        return self.confirm_error

    async def list_issues(self):
        return [{"id": 1, "kind": "work", "status": "in_progress", "request": "check Wednesday", "spec": "long spec"}]

    notes: list = []

    async def note(self, text):
        self.notes = [*self.notes, text]


async def test_desk_tools_file_update_confirm_and_list():
    from voice.bot import DESK_TOOLS, make_desk_handlers

    names = [t.name for t in DESK_TOOLS.standard_tools]
    assert names == ["file_issue", "update_issue", "confirm", "list_issues", "remember"]
    desk, results = FakeDesk(), []

    async def cb(result, properties=None):
        results.append((result, properties))

    board = TaskBoard("CA1", lambda r, c: asyncio.sleep(0, "ok"), lambda t: asyncio.sleep(0))
    h = make_desk_handlers(desk, board, spoke=lambda _id: True)
    await h["file_issue"](SimpleNamespace(arguments={"request": "Create an event Wednesday at 3"}, result_callback=cb))
    assert desk.filed == ["Create an event Wednesday at 3"]
    assert results[-1][0] == {"issue": 1, "status": "filed"}
    assert results[-1][1].run_llm is False
    await h["update_issue"](SimpleNamespace(arguments={"issue": 1, "text": "never mind"}, result_callback=cb))
    assert desk.comments == [(1, "never mind")]
    await h["confirm"](SimpleNamespace(arguments={"issue": 2, "draft": "ab12cd34"}, result_callback=cb))
    assert results[-1][0] == {"issue": 2, "confirmed": True}
    assert desk.confirmed == [(2, "ab12cd34")]
    desk.confirm_error = "issue 3 isn't waiting for a yes"
    await h["confirm"](SimpleNamespace(arguments={"issue": 3, "draft": "zz"}, result_callback=cb))
    assert results[-1][0] == {"issue": 3, "confirmed": False, "why": "issue 3 isn't waiting for a yes"}
    await h["list_issues"](SimpleNamespace(arguments={}, result_callback=cb))
    assert results[-1][0] == {"issues": [{"issue": 1, "status": "in_progress", "request": "check Wednesday"}]}


async def test_desk_tool_failures_are_told_to_the_model_not_raised():
    from voice.bot import make_desk_handlers

    class Down(FakeDesk):
        async def file_issue(self, request):
            raise RuntimeError("agent down")

    results = []

    async def cb(result, properties=None):
        results.append(result)

    board = TaskBoard("CA1", lambda r, c: asyncio.sleep(0, "ok"), lambda t: asyncio.sleep(0))
    await make_desk_handlers(Down(), board)["file_issue"](SimpleNamespace(arguments={"request": "x"}, result_callback=cb))
    from voice.bot import UNREACHABLE

    assert results == [{"filed": False, "why": UNREACHABLE}]


def test_desk_prompt_is_the_front_desk():
    from voice.bot import DESK_PROMPT

    for must in ["file_issue", "update_issue", "<info>", "<events>", "claim done only after <events>", "confirm", "restate the plan", "While it runs, ask what would change the result"]:
        assert must in DESK_PROMPT


async def test_filing_an_issue_tells_the_keepalive():
    from voice.bot import make_desk_handlers

    filed, results = [], []

    async def cb(result, properties=None):
        results.append(result)

    board = TaskBoard("CA1", lambda r, c: asyncio.sleep(0, "ok"), lambda t: asyncio.sleep(0))
    h = make_desk_handlers(FakeDesk(), board, on_filed=lambda n, req: filed.append((n, req)))
    await h["file_issue"](SimpleNamespace(arguments={"request": "Check today's email"}, result_callback=cb))
    assert filed == [(1, "Check today's email")]


def test_desk_prompt_sets_expectations_mirrors_and_attunes():
    from voice.bot import DESK_PROMPT

    for must in ["lookups seconds", "a minute or two", "even mid-task", "Things you could offer", "matching their length", "frustrated", "give me everything", "[quiet]", "only what's new", "hang up", "said once", "a list becomes sentences", "links go by text", "never ask twice", "Their own guidelines win"]:
        assert must in DESK_PROMPT, must
    assert len(DESK_PROMPT.split()) <= 200  # prompt-editing skill: short and simple


async def test_desk_actions_are_reported_for_the_transcript():
    from voice.bot import make_desk_handlers

    actions = []

    async def cb(result, properties=None):
        pass

    board = TaskBoard("CA1", lambda r, c: asyncio.sleep(0, "ok"), lambda t: asyncio.sleep(0))
    h = make_desk_handlers(FakeDesk(), board, on_action=actions.append)
    await h["file_issue"](SimpleNamespace(arguments={"request": "Check email"}, result_callback=cb))
    await h["update_issue"](SimpleNamespace(arguments={"issue": 1, "text": "only unread"}, result_callback=cb))
    await h["confirm"](SimpleNamespace(arguments={"issue": 1, "draft": "d1"}, result_callback=cb))
    assert actions == ["Kloru filed issue 1: Check email", "Kloru updated issue 1: only unread", "Kloru confirmed issue 1"]


def test_kloru_speaks_as_itself_never_about_a_team():
    from voice.bot import DESK_PROMPT, DESK_TOOLS
    from voice.keepalive import IDLE_MESSAGE, waiting_message

    assert "first person" in DESK_PROMPT
    for text in [DESK_PROMPT, waiting_message(["x"], 5), IDLE_MESSAGE, *(f"{t.name} {t.description}" for t in DESK_TOOLS.standard_tools)]:
        assert "team" not in text.lower(), text


def test_the_pipeline_drops_quiet_replies_before_the_voice():
    import inspect
    from voice import bot

    src = next(l for l in inspect.getsource(bot.build_call).splitlines() if "Pipeline([" in l)
    assert "QuietFilter()" in src and src.index("llm,") < src.index("QuietFilter()") < src.index("tts,")


async def test_desk_remember_is_a_note_on_the_call_not_a_background_task():
    from voice.bot import make_desk_handlers

    desk, results, started = FakeDesk(), [], []

    async def cb(result, properties=None):
        results.append((result, properties))

    board = TaskBoard("CA1", lambda r, c: asyncio.sleep(0, "ok"), lambda t: asyncio.sleep(0))
    board.start = lambda *a, **k: started.append(a)
    await make_desk_handlers(desk, board)["remember"](SimpleNamespace(arguments={"fact": "Nora is allergic to peanuts"}, result_callback=cb))
    assert desk.notes == ["Nora is allergic to peanuts"]
    assert started == []
    assert results[-1][1].run_llm is False


def test_opening_context_puts_the_brief_before_the_greeting():
    from voice.bot import GREETING, opening_messages

    msgs = opening_messages("Caller: Ezra\nPeople: Nora: daughter, 3", GREETING)
    assert "Nora" in msgs[0]["content"] and msgs[-1]["content"] == GREETING
    assert opening_messages("", GREETING) == [{"role": "developer", "content": GREETING}]


def test_desk_prompt_is_curious_about_new_people_only_while_waiting():
    from voice.bot import DESK_PROMPT

    assert "warm question" in DESK_PROMPT


async def test_no_desk_tool_result_ever_runs_the_model_and_only_some_owe_words():
    from voice.bot import make_desk_handlers

    desk, props, owed = FakeDesk(), [], Owed()

    async def cb(result, properties=None):
        props.append(properties)

    board = TaskBoard("CA1", lambda r, c: asyncio.sleep(0, "ok"), lambda t: asyncio.sleep(0))
    h = make_desk_handlers(desk, board, spoke=lambda call_id: call_id == "spoke", owe=owed)
    await h["file_issue"](SimpleNamespace(tool_call_id="spoke", arguments={"request": "a"}, result_callback=cb))
    await h["file_issue"](SimpleNamespace(tool_call_id="silent", arguments={"request": "b"}, result_callback=cb))
    await h["list_issues"](SimpleNamespace(tool_call_id="spoke", arguments={}, result_callback=cb))
    desk.confirm_error = "not waiting for a yes"
    await h["confirm"](SimpleNamespace(tool_call_id="spoke", arguments={"issue": 1, "draft": "x"}, result_callback=cb))
    await h["remember"](SimpleNamespace(tool_call_id="silent", arguments={"fact": "f"}, result_callback=cb))
    assert all(p is not None and p.run_llm is False for p in props)
    assert owed.calls == [("spoke", False), ("silent", True), ("spoke", True), ("spoke", True), ("silent", False)]


def test_the_pipeline_reports_replies_to_turns_after_the_filters_and_before_the_voice():
    import inspect
    from voice import bot

    src = next(l for l in inspect.getsource(bot.build_call).splitlines() if "Pipeline([" in l)
    assert src.index("QuietFilter()") < src.index("repeats,") < src.index("ReplyTap(turns)") < src.index("tts,")
    assert "LLMRunFrame" not in inspect.getsource(bot.build_call)  # the greeting goes through Turns too


def test_eager_end_of_turn_starts_the_reply_at_flux_s_prediction_when_on():
    from dataclasses import replace
    from voice.bot import make_stt
    from voice.config import load_config
    from tests.test_config import FULL

    assert load_config({**FULL, "VOICE_EAGER_EOT": "on"}).eager_eot is True
    assert load_config(FULL).eager_eot is False
    on = make_stt(replace(CFG, eager_eot=True))
    assert on._settings.eager_eot_threshold == 0.5  # Flux only predicts with a threshold set
    off = make_stt(replace(CFG, eager_eot=False))
    assert not off._settings.eager_eot_threshold
