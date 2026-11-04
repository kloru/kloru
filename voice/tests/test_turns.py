import asyncio

from voice.turns import Turns


class Pushes:
    def __init__(self):
        self.calls: list[list[str]] = []

    async def __call__(self, messages, run_llm):
        assert run_llm
        self.calls.append([m["content"] for m in messages])


def make(**kw):
    push = Pushes()
    acked: list[str] = []
    after: list[str] = []

    async def after_call(c):
        after.append(c)

    t = Turns(push, after_call=after_call, on_pushed=acked.extend, reply_grace_s=0.05, audio_grace_s=0.05, **kw)
    return t, push, acked, after


async def reply(t: Turns, text: str = "Sure thing.", audio: bool = True):
    """One reply from start to its last word of audio."""
    t.reply_started()
    if text:
        t.reply_text(text)
    await t.reply_ended()
    if audio and text:
        t.bot_started()
        await t.bot_stopped()


async def settle(s: float = 0.12):
    await asyncio.sleep(s)


async def test_a_result_while_the_caller_talks_waits_for_them_and_for_kloru_to_answer():
    t, push, acked, _ = make()
    await t.caller_started()
    await t.offer("<info>3 events</info>")
    await t.caller_stopped()
    assert push.calls == []  # Pipecat's own reply to the caller comes first
    await reply(t, "Let me look.")
    assert push.calls == [["<info>3 events</info>"]]
    assert acked == ["<info>3 events</info>"]


async def test_results_that_pile_up_go_to_the_model_in_one_reply():
    t, push, _, _ = make()
    t.reply_started()
    await t.offer("<info>a</info>")
    await t.offer("<events>b</events>")
    t.reply_text("Okay.")
    await t.reply_ended()
    t.bot_started()
    await t.bot_stopped()
    assert push.calls == [["<info>a</info>", "<events>b</events>"]]


async def test_a_reply_that_spoke_and_filed_gets_no_second_reply():
    # Call CA393c42…: "I'm checking your calendar…" said twice, the second from a re-run after filing.
    t, push, _, _ = make()
    t.reply_started()
    t.reply_text("I'm checking your calendar for tomorrow.")
    await t.reply_ended()
    await t.tool_result("call_1", needs_reply=False)
    t.bot_started()
    await t.bot_stopped()
    await settle()
    assert push.calls == []


async def test_a_reply_that_only_filed_gets_exactly_one_reply_once_quiet():
    t, push, _, _ = make()
    t.reply_started()
    await t.reply_ended()
    await t.tool_result("call_1", needs_reply=True)
    await t.tool_result("call_1", needs_reply=True)  # a duplicate callback must not double it
    assert push.calls == [[]]


async def test_only_one_reply_is_ever_in_flight():
    t, push, _, _ = make()
    await t.offer("<info>a</info>")
    assert push.calls == [["<info>a</info>"]]
    await t.offer("<info>b</info>")  # the first push hasn't been answered yet
    assert push.calls == [["<info>a</info>"]]
    await reply(t, "A came back.")
    assert push.calls == [["<info>a</info>"], ["<info>b</info>"]]


async def test_a_reply_nobody_asked_for_is_recorded():
    t, _, _, _ = make()
    await reply(t, "Hello?")
    assert t.stats.unexpected_replies == 1


async def test_a_nudge_is_spoken_only_into_real_silence():
    t, push, _, _ = make()
    t.reply_started()
    await t.nudge("(nothing back yet)")
    assert push.calls == []
    assert t.stats.nudges_dropped == 1
    t.reply_text("Hi.")
    await t.reply_ended()
    t.bot_started()
    await t.bot_stopped()
    assert push.calls == []  # a dropped nudge isn't saved up for later
    await t.nudge("(nothing back yet)")
    assert push.calls == [["(nothing back yet)"]]


async def test_a_reply_that_never_reaches_the_speaker_is_caught_and_does_not_wedge_the_call():
    # The Cartesia 402: words written, no audio. The call must keep working and the check must see it.
    t, push, _, _ = make()
    await t.offer("<info>a</info>")
    t.reply_started()
    t.reply_text("Hi Evan.")
    await t.reply_ended()
    await t.offer("<info>b</info>")
    await settle()
    assert t.stats.no_audio == 1
    assert push.calls == [["<info>a</info>"], ["<info>b</info>"]]


async def test_quiet_is_not_missing_audio():
    t, push, _, _ = make()
    await t.offer("(nudge)")
    t.reply_started()
    t.reply_text("[quiet]")
    await t.reply_ended()
    await settle()
    assert t.stats.no_audio == 0
    await t.offer("<info>x</info>")
    assert push.calls[-1] == ["<info>x</info>"]


async def test_when_the_expected_reply_never_starts_owed_results_still_go_out():
    t, push, _, _ = make()
    await t.caller_started()
    await t.offer("<info>a</info>")
    await t.caller_stopped()
    await settle()
    assert push.calls == [["<info>a</info>"]]


async def test_a_barge_in_hands_the_floor_to_the_caller():
    t, push, _, _ = make()
    t.reply_started()
    t.reply_text("Tomorrow you have")
    await t.caller_started()
    await t.offer("<info>a</info>")
    await t.reply_ended()  # the cut-off reply's end arrives late
    t.bot_started()
    await t.bot_stopped()
    assert push.calls == []
    await t.caller_stopped()
    await reply(t, "Sure.")
    assert push.calls == [["<info>a</info>"]]


async def test_after_hang_up_held_results_go_to_after_call():
    t, push, _, after = make()
    await t.caller_started()
    await t.offer("<info>a</info>")
    await t.ended()
    await t.offer("<info>b</info>")
    assert after == ["<info>a</info>", "<info>b</info>"]
    assert push.calls == []


async def test_the_longest_wait_of_a_result_is_measured():
    now = [0.0]
    t, _, _, _ = make(clock=lambda: now[0])
    await t.caller_started()
    await t.offer("<info>a</info>")
    now[0] = 30.0
    await t.caller_stopped()
    t.reply_started()
    await t.reply_ended()
    assert t.stats.longest_owed_wait_s == 30.0


async def test_the_greeting_is_a_reply_the_machine_asked_for():
    t, push, acked, _ = make()
    await t.begin([{"role": "developer", "content": "Greet the caller."}])
    assert push.calls == [["Greet the caller."]]
    assert acked == []  # the greeting isn't a result to acknowledge
    await reply(t, "Hi Evan.")
    assert t.stats.unexpected_replies == 0


async def test_the_tap_reports_each_reply_it_passes_to_the_voice():
    from pipecat.frames.frames import LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame
    from pipecat.processors.frame_processor import FrameDirection

    from voice.turns import ReplyTap

    t, _, _, _ = make()
    tap, out = ReplyTap(t), []

    async def push(frame, direction=FrameDirection.DOWNSTREAM):
        out.append(frame)

    tap.push_frame = push
    for f in [LLMFullResponseStartFrame(), LLMTextFrame("[quiet]"), LLMFullResponseEndFrame()]:
        await tap.process_frame(f, FrameDirection.DOWNSTREAM)
    assert len(out) == 3
    assert t.stats.replies == 1 and t.state.value == "idle"


async def test_a_lost_end_of_speech_cannot_hold_results_forever():
    t, push, _, _ = make(speech_limit_s=0.05)
    await t.offer("<info>a</info>")
    t.reply_started()
    t.reply_text("A long answer.")
    t.bot_started()
    await t.reply_ended()
    await t.offer("<info>b</info>")
    await settle()  # bot_stopped never comes
    assert push.calls == [["<info>a</info>"], ["<info>b</info>"]]
