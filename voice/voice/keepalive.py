"""No unexplained silence on a call (issue #5).

While the team works on something the caller asked for, nobody may sit in silence: after a short
quiet stretch Kloru may say something new and useful (or decline with [quiet]); never a restated
plan or a bare "still working". Nudges are rare and capped per wait. With nothing pending, a long quiet stretch gets one check-in.
Nudges go through Turns, which drops any that would land on someone talking or on something owed.
"""
import asyncio
import time
from collections.abc import Awaitable, Callable

from pipecat.observers.speaking_observer import SpeechEvent, SpeechEventKind as K


# Kloru already gave a time estimate when it filed, so quiet is fine for a while; restating the
# plan to fill it made a caller feel talked down to. Nudges are rare and may be declined ([quiet]).
FIRST_AFTER_S = 12.0
EVERY_S = 20.0
MAX_PER_WAIT = 2
IDLE_AFTER_S = 10.0

_STARTS = {K.USER_SPEECH_STARTED: "user", K.BOT_SPEECH_STARTED: "bot"}
_STOPS = {K.USER_SPEECH_STOPPED: "user", K.BOT_SPEECH_STOPPED: "bot"}


def waiting_message(requests: list[str], seconds: int) -> str:
    """A chance to say something useful while work runs, never a restated plan (#5)."""
    return (
        f"(Nothing back yet on: {'; '.join(requests)} ({seconds} seconds). Speak only if it's new and useful, "
        "like a question that would improve the result or one thing you could offer them. Otherwise reply with just [quiet].)"
    )


IDLE_MESSAGE = "(The caller has been quiet for a while. If they might want anything else, briefly ask; if they're waiting on something, reply with just [quiet].)"


class KeepAlive:
    def __init__(self, nudge: Callable[[str], Awaitable[None]], clock: Callable[[], float] = time.monotonic):
        self._nudge, self._clock = nudge, clock
        self._pending: dict[int, tuple[str, float]] = {}
        self._speaking: set[str] = set()
        self._last_activity = clock()
        self._last_nudge: float | None = None
        self._nudges = 0
        self._idle_checked = False
        self._stopped = False
        self._task: asyncio.Task | None = None

    # Inputs ----------------------------------------------------------------------

    def observe(self, event: SpeechEvent) -> None:
        now = self._clock()
        if event.kind in _STARTS:
            self._speaking.add(_STARTS[event.kind])
            self._last_activity = now
            if event.kind == K.USER_SPEECH_STARTED:
                self._idle_checked = False
        elif event.kind in _STOPS:
            self._speaking.discard(_STOPS[event.kind])
            self._last_activity = now

    def filed(self, issue: int, request: str) -> None:
        self._pending[issue] = (request, self._clock())
        self._nudges, self._last_nudge = 0, None

    def resolved(self, issue: int) -> None:
        # A result arriving is activity: Kloru is about to pass it on.
        self._last_activity = self._clock()
        self._pending.pop(issue, None)
        if not self._pending:
            self._nudges, self._last_nudge = 0, None

    # Loop ------------------------------------------------------------------------

    async def tick(self) -> None:
        if self._stopped or self._speaking:
            return
        now = self._clock()
        quiet = now - self._last_activity
        if self._pending:
            if self._nudges >= MAX_PER_WAIT or quiet < FIRST_AFTER_S:
                return
            if self._last_nudge is not None and now - self._last_nudge < EVERY_S:
                return
            since = min(t for _, t in self._pending.values())
            self._nudges += 1
            self._last_nudge = now
            await self._nudge(waiting_message([r for r, _ in self._pending.values()], int(now - since)))
        elif not self._idle_checked and quiet >= IDLE_AFTER_S:
            self._idle_checked = True
            await self._nudge(IDLE_MESSAGE)

    def start(self, every_s: float = 0.5) -> None:
        async def loop():
            while not self._stopped:
                await asyncio.sleep(every_s)
                await self.tick()

        self._task = asyncio.create_task(loop())

    def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
