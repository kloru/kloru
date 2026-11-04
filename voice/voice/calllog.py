"""Who called and what we did about it: one JSON line per voice webhook, kept 90 days.

Audio is never recorded. The website's Admin page reads this file to show attacks (calls
faking the owner's number) and good calls the caller ID check turned away.
"""
import json
import os
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

from loguru import logger

KEEP = timedelta(days=90)
PRUNE_EVERY = timedelta(days=1)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class CallLog:
    def __init__(self, path: str | Path, clock: Callable[[], datetime] = _now):
        self.path, self._clock = Path(path), clock
        self._pruned_at: datetime | None = None
        self._prune()

    def record(self, entry: dict) -> None:
        """Append one entry. Never raises: a full disk must not drop the call."""
        try:
            now = self._clock()
            if self._pruned_at is None or now - self._pruned_at >= PRUNE_EVERY:
                self._prune()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a") as f:
                f.write(json.dumps({"at": _stamp(now), **entry}) + "\n")
        except Exception as err:  # noqa: BLE001
            logger.error(f"call log: could not record {entry.get('call_sid', '')}: {err}")

    def _prune(self) -> None:
        try:
            now = self._clock()
            self._pruned_at = now
            if not self.path.exists():
                return
            cutoff = _stamp(now - KEEP)
            kept = []
            for line in self.path.read_text().splitlines():
                try:
                    if json.loads(line).get("at", "") >= cutoff:
                        kept.append(line)
                except ValueError:
                    continue
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text("".join(l + "\n" for l in kept))
            os.replace(tmp, self.path)
        except Exception as err:  # noqa: BLE001
            logger.error(f"call log: could not prune {self.path}: {err}")
