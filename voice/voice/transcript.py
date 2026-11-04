"""Every call's transcript, one JSON line per event, written as the call happens.

<dir>/<YYYY-MM-DD>/<CallSid>.jsonl holds what the caller said, what Kloru said (and whether it
was cut off), and each background task's request and result, including results that arrive
after the caller hangs up. Text only; audio is never kept. Kept 90 days. The website's Admin
page reads these files.
"""
import json
import re
import shutil
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from loguru import logger

KEEP = timedelta(days=90)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Transcript:
    def __init__(self, root: str | Path, call_sid: str, caller: str, clock: Callable[[], datetime] = _now):
        self._clock = clock
        safe = re.sub(r"[^A-Za-z0-9_-]", "", call_sid) or "unknown"
        self.path = Path(root) / clock().astimezone(timezone.utc).strftime("%Y-%m-%d") / f"{safe}.jsonl"
        self._write("call_started", call_sid=call_sid, **{"from": caller})

    def caller(self, text: str) -> None:
        self._write("caller", text=text)

    def kloru(self, text: str, interrupted: bool) -> None:
        self._write("kloru", text=text, interrupted=interrupted)

    def task_started(self, task: int, request: str, size: str) -> None:
        self._write("task_started", task=task, request=request, size=size)

    def task_finished(self, task: int, status: str, result: str, after_call: bool = False) -> None:
        self._write("task_finished", task=task, status=status, result=result, **({"after_call": True} if after_call else {}))

    def ended(self) -> None:
        self._write("call_ended")

    def _write(self, kind: str, **fields) -> None:
        """Never raises: a full disk must not drop the call."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a") as f:
                f.write(json.dumps({"at": _stamp(self._clock()), "kind": kind, **fields}) + "\n")
        except Exception as err:  # noqa: BLE001
            logger.error(f"transcript: could not write {kind} to {self.path}: {err}")


def prune_transcripts(root: str | Path, now: datetime | None = None) -> None:
    """Delete day directories older than 90 days. Never raises."""
    cutoff = ((now or _now()) - KEEP).date()
    try:
        for d in Path(root).iterdir():
            try:
                if d.is_dir() and date.fromisoformat(d.name) < cutoff:
                    shutil.rmtree(d)
            except ValueError:
                continue
    except FileNotFoundError:
        return
    except Exception as err:  # noqa: BLE001
        logger.error(f"transcript: could not prune {root}: {err}")
