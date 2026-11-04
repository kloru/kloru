"""Who may speak on a call, and when: the only thing that starts one of Kloru's replies.

Before this, six things could each run the model on their own (the caller's turn, a tool result,
a finished result, a nudge, the greeting, Pipecat's async-tool handling), and none knew what the
others had started, so the same moment got answered twice (#14). Now everything except the
caller's own turn is an event here, and the model runs only from this state machine:

    IDLE ──offer / owed reply──▶ AWAITING ──reply starts──▶ REPLYING ──last audio──▶ IDLE
      │                              ▲                          │
      └──caller speaks──▶ CALLER ──caller stops (Pipecat replies)┘ (a barge-in also goes to CALLER)

Invariants: at most one reply in flight; the model runs only when something is owed; each owed
item is handed over once. What it couldn't keep (a reply nobody asked for, words that never
became audio, a long wait) is counted in stats for the after-call checks.
"""
import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum

from loguru import logger
from pipecat.frames.frames import Frame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from voice.quiet import QUIET

Push = Callable[[list[dict], bool], Awaitable[None]]


class State(Enum):
    IDLE = "idle"
    CALLER = "caller"
    AWAITING = "awaiting"  # a reply was asked for (by us, or by the caller's turn) and hasn't started
    REPLYING = "replying"  # being written or spoken
    ENDED = "ended"


@dataclass
class Stats:
    replies: int = 0
    unexpected_replies: int = 0
    no_audio: int = 0
    nudges_dropped: int = 0
    longest_owed_wait_s: float = 0.0
    results_after_call: int = 0


class Turns:
    def __init__(
        self,
        push: Push,
        after_call: Callable[[str], Awaitable[None]] | None = None,
        on_pushed: Callable[[list[str]], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        reply_grace_s: float = 4.0,
        audio_grace_s: float = 6.0,
        speech_limit_s: float = 60.0,
    ):
        self._push, self._after_call, self._on_pushed, self._clock = push, after_call, on_pushed, clock
        self._reply_grace, self._audio_grace, self._speech_limit = reply_grace_s, audio_grace_s, speech_limit_s
        self.state = State.IDLE
        self.stats = Stats()
        self._owed: list[tuple[str, float]] = []
        self._owe_reply: float | None = None  # since when a silent tool call has owed the caller words
        self._answered_tools: set[str] = set()
        self._text = ""
        self._reply_done = False
        self._audio = False
        self._timer: asyncio.Task | None = None

    async def begin(self, messages: list[dict]) -> None:
        """The greeting: the first reply, asked for here like every other."""
        self._go(State.AWAITING)
        self._arm(self._reply_grace, self._reply_never_came)
        await self._push(messages, True)

    # The caller --------------------------------------------------------------------

    async def caller_started(self) -> None:
        if self.state is State.ENDED:
            return
        self._go(State.CALLER)

    async def caller_stopped(self) -> None:
        if self.state is State.ENDED:
            return
        # Pipecat answers the caller's turn itself; anything owed waits for that reply to finish.
        self._go(State.AWAITING)
        self._arm(self._reply_grace, self._reply_never_came)

    # Kloru's replies (seen after the [quiet] and repeat filters) ------------------------

    def reply_started(self) -> None:
        if self.state in (State.ENDED, State.CALLER):
            return
        if self.state is not State.AWAITING:
            self.stats.unexpected_replies += 1
            logger.warning(f"turns: a reply started from {self.state.value}; nothing here asked for it")
        self.stats.replies += 1
        self._text, self._reply_done, self._audio = "", False, False
        self._go(State.REPLYING)

    def reply_text(self, text: str) -> None:
        if self.state is State.REPLYING:
            self._text += text

    async def reply_ended(self) -> None:
        if self.state is not State.REPLYING:
            return
        self._reply_done = True
        spoke = self._text.strip() and self._text.strip().lower() != QUIET
        if not spoke:
            await self._idle()
        elif not self._audio:
            self._arm(self._audio_grace, self._audio_never_came)
        else:
            self._arm(self._speech_limit, self._speech_never_ended)

    def bot_started(self) -> None:
        if self.state is State.REPLYING:
            self._audio = True
            if self._reply_done:  # a lost end-of-speech must not hold results forever
                self._arm(self._speech_limit, self._speech_never_ended)
            else:
                self._disarm()

    async def bot_stopped(self) -> None:
        if self.state is State.REPLYING and self._reply_done:
            await self._idle()

    # What Kloru owes the caller ------------------------------------------------------------

    async def tool_result(self, tool_call_id: str, needs_reply: bool) -> None:
        """A tool finished. Only a call made without a word to the caller (or one whose result must
        be read out) owes a reply; tool results never run the model themselves."""
        if not needs_reply or tool_call_id in self._answered_tools or self.state is State.ENDED:
            return
        self._answered_tools.add(tool_call_id)
        if self._owe_reply is None:
            self._owe_reply = self._clock()
        await self._flush()

    async def offer(self, content: str) -> None:
        """A finished result. Owed to the caller until it has been handed to the model once."""
        if self.state is State.ENDED:
            self.stats.results_after_call += 1
            if self._after_call:
                await self._after_call(content)
            return
        self._owed.append((content, self._clock()))
        await self._flush()

    async def nudge(self, content: str) -> None:
        """A chance to fill silence. Only into real silence with nothing owed; never saved for later."""
        if self.state is not State.IDLE or self._owed or self._owe_reply is not None:
            self.stats.nudges_dropped += 1
            return
        await self._hand_over([content])

    async def ended(self) -> None:
        self._disarm()
        self.state = State.ENDED
        owed, self._owed = self._owed, []
        for content, _ in owed:
            await self.offer(content)

    # Inside ----------------------------------------------------------------------------

    async def _flush(self) -> None:
        if self.state is not State.IDLE or not (self._owed or self._owe_reply is not None):
            return
        now = self._clock()
        since = [t for _, t in self._owed] + ([self._owe_reply] if self._owe_reply is not None else [])
        self.stats.longest_owed_wait_s = max(self.stats.longest_owed_wait_s, now - min(since))
        contents = [c for c, _ in self._owed]
        self._owed, self._owe_reply = [], None
        await self._hand_over(contents)

    async def _hand_over(self, contents: list[str]) -> None:
        self._go(State.AWAITING)
        self._arm(self._reply_grace, self._reply_never_came)
        await self._push([{"role": "developer", "content": c} for c in contents], True)
        if self._on_pushed and contents:
            self._on_pushed(contents)

    async def _idle(self) -> None:
        self._disarm()
        self._go(State.IDLE)
        await self._flush()

    async def _reply_never_came(self) -> None:
        if self.state is State.AWAITING:
            await self._idle()

    async def _speech_never_ended(self) -> None:
        if self.state is State.REPLYING:
            logger.warning("turns: no end of speech heard; taking the floor back")
            await self._idle()

    async def _audio_never_came(self) -> None:
        if self.state is State.REPLYING and not self._audio:
            self.stats.no_audio += 1
            logger.error(f"turns: a reply never became audio: {self._text[:80]!r}")
            await self._idle()

    def _go(self, state: State) -> None:
        if state is not State.AWAITING:
            self._disarm()
        if state is not self.state:
            logger.debug(f"turns: {self.state.value} -> {state.value}")
        self.state = state

    def _arm(self, seconds: float, then: Callable[[], Awaitable[None]]) -> None:
        self._disarm()

        async def fire():
            await asyncio.sleep(seconds)
            self._timer = None
            await then()

        self._timer = asyncio.create_task(fire())

    def _disarm(self) -> None:
        if self._timer and not self._timer.done() and self._timer is not asyncio.current_task():
            self._timer.cancel()
        self._timer = None


class ReplyTap(FrameProcessor):
    """Sits just before the voice: tells Turns when each reply starts, what it says, and when it ends."""

    def __init__(self, turns: Turns, **kwargs):
        super().__init__(**kwargs)
        self._turns = turns

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._turns.reply_started()
        elif isinstance(frame, LLMTextFrame):
            self._turns.reply_text(frame.text)
        elif isinstance(frame, LLMFullResponseEndFrame):
            await self._turns.reply_ended()
        await self.push_frame(frame, direction)
