"""Lets the talking model choose silence: a reply of just [quiet] never reaches the voice.

The model is told to answer [quiet] when it has nothing new to say (a result it already passed on,
a nudge with nothing useful to add). Text is held only while it could still be "[quiet]"; anything
else streams through unchanged, so normal replies lose no speed.

RepeatFilter only counts: how often Kloru said a sentence again before the caller spoke, for the
after-call checks. Whether to repeat is the model's call (guidelines-not-rules skill).
"""
import re

from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

QUIET = "[quiet]"


class QuietFilter(FrameProcessor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._held: list[LLMTextFrame] = []
        self._passing = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._held, self._passing = [], False
            await self.push_frame(frame, direction)
        elif isinstance(frame, LLMTextFrame) and not self._passing:
            self._held.append(frame)
            so_far = "".join(f.text for f in self._held).strip().lower()
            if not QUIET.startswith(so_far) and so_far != QUIET:
                await self._release(direction)
        elif isinstance(frame, LLMFullResponseEndFrame):
            if "".join(f.text for f in self._held).strip().lower() != QUIET:
                await self._release(direction)
            self._held = []
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    async def _release(self, direction: FrameDirection) -> None:
        self._passing = True
        held, self._held = self._held, []
        for f in held:
            await self.push_frame(f, direction)


_SENTENCE = re.compile(r".*?[.!?]+[\"”’)]*\s+", re.S)


def _key(sentence: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", "", sentence.lower().replace("’", "'")).split())


class RepeatFilter(FrameProcessor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._said: set[str] = set()
        self._partial = ""
        self.dropped = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, (UserStartedSpeakingFrame, InterruptionFrame)):
            self._said.clear()
            self._partial = ""
            await self.push_frame(frame, direction)
        elif isinstance(frame, LLMTextFrame):
            self._partial += frame.text
            while m := _SENTENCE.match(self._partial):
                self._partial = self._partial[m.end():]
                await self._say(m.group(0), direction)
        elif isinstance(frame, LLMFullResponseEndFrame):
            rest, self._partial = self._partial, ""
            if rest.strip():
                await self._say(rest, direction)
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    async def _say(self, sentence: str, direction: FrameDirection) -> None:
        key = _key(sentence)
        if key and key in self._said:
            self.dropped += 1  # measured, never dropped
        self._said.add(key)
        await self.push_frame(LLMTextFrame(sentence), direction)


def count_repeats(text: str, said: set[str]) -> int:
    """How many of a whole reply's sentences were already said (adding the rest to `said`): the
    same measure as RepeatFilter, for places that see a reply at once, like the bench."""
    n = 0
    for sentence in [m.group(0) for m in _SENTENCE.finditer(text + " ")] or [text]:
        key = _key(sentence)
        if key and key in said:
            n += 1
        said.add(key)
    return n
