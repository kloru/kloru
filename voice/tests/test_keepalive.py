from pipecat.observers.speaking_observer import SpeechEvent, SpeechEventKind as K

from voice.keepalive import KeepAlive


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


async def run(ka, clock, until, step=0.5):
    while clock.t < until:
        clock.t += step
        await ka.tick()


def make():
    clock, said = Clock(), []

    async def nudge(text):
        said.append((clock.t, text))

    return KeepAlive(nudge, clock=clock), clock, said


async def test_silence_while_work_runs_gets_a_status_or_question_soon():
    ka, clock, said = make()
    ka.observe(SpeechEvent(kind=K.BOT_SPEECH_STOPPED, timestamp=0))
    ka.filed(7, "check today's unread emails")
    await run(ka, clock, 11.5)
    assert said == []
    await run(ka, clock, 12.5)
    assert len(said) == 1
    t, text = said[0]
    assert 12.0 <= t <= 12.5
    assert "check today's unread emails" in text
    assert "seconds" in text


async def test_nudges_are_spaced_and_capped_per_wait():
    ka, clock, said = make()
    ka.filed(1, "research flights")
    await run(ka, clock, 300)
    times = [t for t, _ in said]
    assert len(times) == 2
    assert all(b - a >= 20 for a, b in zip(times, times[1:]))


async def test_no_nudge_while_anyone_is_speaking_and_speech_resets_the_wait():
    ka, clock, said = make()
    ka.filed(1, "x")
    ka.observe(SpeechEvent(kind=K.USER_SPEECH_STARTED, timestamp=0))
    await run(ka, clock, 10)
    assert said == []
    ka.observe(SpeechEvent(kind=K.USER_SPEECH_STOPPED, timestamp=10))
    await run(ka, clock, 21.5)
    assert said == []
    await run(ka, clock, 22.5)
    assert len(said) == 1


async def test_a_result_ends_the_wait():
    ka, clock, said = make()
    ka.filed(1, "x")
    ka.resolved(1)
    await run(ka, clock, 9)
    assert said == []


async def test_a_quiet_caller_with_nothing_pending_gets_one_check_in():
    ka, clock, said = make()
    ka.observe(SpeechEvent(kind=K.BOT_SPEECH_STOPPED, timestamp=0))
    await run(ka, clock, 60)
    assert len(said) == 1
    assert said[0][0] >= 10
    assert "anything else" in said[0][1].lower()
    ka.observe(SpeechEvent(kind=K.USER_SPEECH_STARTED, timestamp=60))
    ka.observe(SpeechEvent(kind=K.USER_SPEECH_STOPPED, timestamp=61))
    ka.observe(SpeechEvent(kind=K.BOT_SPEECH_STARTED, timestamp=62))
    ka.observe(SpeechEvent(kind=K.BOT_SPEECH_STOPPED, timestamp=63))
    clock.t = 63
    await run(ka, clock, 80)
    assert len(said) == 2


async def test_stopped_keepalive_says_nothing():
    ka, clock, said = make()
    ka.filed(1, "x")
    ka.stop()
    await run(ka, clock, 30)
    assert said == []


def test_the_waiting_nudge_asks_for_a_smart_move_not_a_status():
    from voice.keepalive import waiting_message

    text = waiting_message(["go through today's unread email"], 12)
    assert "go through today's unread email" in text and "12 seconds" in text
    assert "[quiet]" in text and "question that would improve" in text
    assert len(text.split()) <= 60


async def test_a_result_arriving_counts_as_activity_so_no_check_in_lands_on_top_of_it():
    ka, clock, said = make()
    ka.filed(1, "x")
    clock.t = 11.0
    ka.resolved(1)  # the result arrives; Kloru is about to pass it on
    await run(ka, clock, 20.5)
    assert said == []
    await run(ka, clock, 21.5)
    assert len(said) == 1 and "anything else" in said[0][1].lower()


def test_the_idle_check_in_may_be_declined():
    from voice.keepalive import IDLE_MESSAGE

    assert "[quiet]" in IDLE_MESSAGE


