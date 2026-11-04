from pipecat.frames.frames import LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame
from pipecat.processors.frame_processor import FrameDirection

from voice.quiet import QuietFilter


async def run(filt, chunks):
    out = []

    async def push(frame, direction=FrameDirection.DOWNSTREAM):
        out.append(frame)

    filt.push_frame = push
    for f in [LLMFullResponseStartFrame(), *[LLMTextFrame(c) for c in chunks], LLMFullResponseEndFrame()]:
        await filt.process_frame(f, FrameDirection.DOWNSTREAM)
    return "".join(f.text for f in out if isinstance(f, LLMTextFrame)), out


async def test_a_quiet_reply_never_reaches_the_voice():
    text, out = await run(QuietFilter(), ["[", "quiet", "]"])
    assert text == ""
    assert any(isinstance(f, LLMFullResponseEndFrame) for f in out)


async def test_a_normal_reply_passes_through_in_order():
    text, _ = await run(QuietFilter(), ["I found ", "one invite."])
    assert text == "I found one invite."


async def test_a_reply_that_only_starts_like_quiet_is_kept():
    text, _ = await run(QuietFilter(), ["[", "q", "uick note] hi"])
    assert text == "[quick note] hi"
    text, _ = await run(QuietFilter(), [" [quiet] "])
    assert text == ""


from pipecat.frames.frames import UserStartedSpeakingFrame

from voice.quiet import RepeatFilter


async def say(filt, out, chunks):
    async def push(frame, direction=FrameDirection.DOWNSTREAM):
        out.append(frame)

    filt.push_frame = push
    start = len(out)
    for f in [LLMFullResponseStartFrame(), *[LLMTextFrame(c) for c in chunks], LLMFullResponseEndFrame()]:
        await filt.process_frame(f, FrameDirection.DOWNSTREAM)
    return "".join(f.text for f in out[start:] if isinstance(f, LLMTextFrame))




async def test_once_the_caller_speaks_a_sentence_may_be_said_again():
    filt, out = RepeatFilter(), []
    await say(filt, out, ["Got it."])
    await filt.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    assert await say(filt, out, ["Got it."]) == "Got it."


async def test_a_long_sentence_still_streams_without_waiting_for_the_reply_to_end():
    filt, out = RepeatFilter(), []

    async def push(frame, direction=FrameDirection.DOWNSTREAM):
        out.append(frame)

    filt.push_frame = push
    await filt.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    for c in ["Tomorrow you have drop-off at 8. ", "Then the interview"]:
        await filt.process_frame(LLMTextFrame(c), FrameDirection.DOWNSTREAM)
    assert "".join(f.text for f in out if isinstance(f, LLMTextFrame)) == "Tomorrow you have drop-off at 8. "


async def test_blocked_repeats_are_counted_for_the_after_call_checks():
    filt, out = RepeatFilter(), []
    await say(filt, out, ["Checking now."])
    await say(filt, out, ["Checking now."])
    assert filt.dropped == 1








async def test_repeats_are_counted_for_the_checks_but_never_dropped():
    # Whether to repeat is the model's call (guidelines-not-rules); the after-call checks measure it.
    filt, out = RepeatFilter(), []
    await say(filt, out, ["Checking now."])
    assert await say(filt, out, ["Checking now. Anything else?"]) == "Checking now. Anything else?"
    assert filt.dropped == 1


def test_the_bench_counts_repeats_the_same_way():
    from voice.quiet import count_repeats

    said: set[str] = set()
    assert count_repeats("What day works for dinner with Sam?\n\nWhat day works for dinner with Sam?", said) == 1
