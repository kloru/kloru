"""Mirror the caller (#28): a fact for the talking model when its replies run long for this caller.

Not a rule in code (guidelines-not-rules skill): the model hears how briefly the caller talks and
decides. Said once, after a few turns, and again only if it drifts back.
"""
import re

MIN_CALLER_TURNS = 2
RATIO = 1.8  # Kloru's words per turn over the caller's before it's worth a word
BRIEF_CALLER = 14  # only for callers who talk briefly; a chatty caller sets their own pace


def words(text: str) -> int:
    return len(re.findall(r"[\w']+", text))


class StyleMeter:
    def __init__(self):
        self.caller: list[int] = []
        self.kloru: list[int] = []
        self._noted_at: int | None = None

    def caller_said(self, text: str) -> None:
        if text.strip():
            self.caller.append(words(text))

    def kloru_said(self, text: str) -> None:
        if text.strip():
            self.kloru.append(words(text))

    def note(self) -> str | None:
        """A note for the model, when Kloru's recent replies run long for a brief caller; else None."""
        if len(self.caller) < MIN_CALLER_TURNS or len(self.kloru) < 2:
            return None
        caller = sum(self.caller[-6:]) / len(self.caller[-6:])
        kloru = sum(self.kloru[-4:]) / len(self.kloru[-4:])
        if caller > BRIEF_CALLER or kloru < max(RATIO * caller, caller + 8):
            return None
        if self._noted_at is not None and len(self.kloru) - self._noted_at < 4:
            return None
        self._noted_at = len(self.kloru)
        return f"(Style: the caller talks in about {round(caller)} words a turn; your replies average {round(kloru)}. Match them.)"
