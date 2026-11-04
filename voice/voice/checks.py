"""After every call: did it work? Checks the things a caller notices before we do.

Each failure is logged as an error, scored in Langfuse (check.<name> = 0), appended to
alerts.jsonl on the volume, and, with GITHUB_TOKEN and GITHUB_REPO set, filed as a GitHub issue.
So a silent call or a doubled reply is reported by the system, not found by the owner.
"""
import json
import os
from dataclasses import asdict, dataclass, field

import httpx
from loguru import logger
from pipecat.frames.frames import ErrorFrame
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.observers.speaking_observer import SpeechEvent, SpeechEventKind as K

from voice.turns import Stats

SLOW_RESULT_S = 20.0  # a result owed this long without being handed over
SLOW_REPLY_S = 8.0  # the caller stopped talking and heard nothing this long


@dataclass
class Failure:
    name: str
    detail: str


@dataclass
class CallFacts:
    turns: Stats
    repeats_blocked: int
    errors: list[str]
    events: list[SpeechEvent]
    caller_spoke: bool
    metrics: dict[str, float] = field(default_factory=dict)


CHECKS = ["voice_errors", "no_audio", "double_reply", "repeat_blocked", "slow_result", "slow_reply"]


def run_checks(f: CallFacts) -> list[Failure]:
    out: list[Failure] = []
    if f.errors:
        out.append(Failure("voice_errors", "; ".join(dict.fromkeys(f.errors[:5]))))
    heard = any(e.kind == K.BOT_SPEECH_STARTED for e in f.events)
    if f.turns.no_audio or (f.caller_spoke and f.turns.replies and not heard):
        out.append(Failure("no_audio", f"{f.turns.no_audio or f.turns.replies} replies written that the caller never heard"))
    if f.turns.unexpected_replies:
        out.append(Failure("double_reply", f"{f.turns.unexpected_replies} replies started that nothing asked for"))
    if f.repeats_blocked:
        out.append(Failure("repeat_blocked", f"{f.repeats_blocked} sentences said twice before the caller spoke"))
    if f.turns.longest_owed_wait_s > SLOW_RESULT_S:
        out.append(Failure("slow_result", f"a result waited {f.turns.longest_owed_wait_s:.0f} s to be passed on"))
    if f.metrics.get("latency.reply_max_s", 0.0) > SLOW_REPLY_S:
        out.append(Failure("slow_reply", f"the caller waited {f.metrics['latency.reply_max_s']:.1f} s for a reply"))
    return out


class ErrorTally(BaseObserver):
    """Every ErrorFrame in the pipeline (TTS refusals, STT drops, model errors), once each."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.errors: list[str] = []
        self._seen: set[int] = set()

    def record(self, source: str, frame: ErrorFrame) -> None:
        if frame.id in self._seen:
            return
        self._seen.add(frame.id)
        self.errors.append(f"{source}: {frame.error}")

    async def on_push_frame(self, data: FramePushed):
        if isinstance(data.frame, ErrorFrame):
            self.record(str(data.source), data.frame)


async def alert(call_sid: str, failures: list[Failure], path: str | None, client: httpx.AsyncClient | None = None) -> None:
    if not failures:
        return
    for f in failures:
        logger.error(f"call {call_sid}: check {f.name} failed: {f.detail}")
    if path:
        try:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "a") as fh:
                fh.write(json.dumps({"call_sid": call_sid, "failures": [asdict(f) for f in failures]}) + "\n")
        except OSError as err:
            logger.error(f"checks: could not write {path}: {err!r}")
    token, repo = os.environ.get("GITHUB_TOKEN", "").strip(), os.environ.get("GITHUB_REPO", "").strip()
    if token and repo:
        body = "\n".join(f"- **{f.name}**: {f.detail}" for f in failures)
        own = client is None
        client = client or httpx.AsyncClient(timeout=10)
        try:
            await client.post(
                f"https://api.github.com/repos/{repo}/issues",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                json={"title": f"Call check failed: {', '.join(f.name for f in failures)}", "body": f"Call `{call_sid}`\n\n{body}", "labels": ["call-check"]},
            )
        except httpx.HTTPError as err:
            logger.error(f"checks: could not file a GitHub issue: {err!r}")
        finally:
            if own:
                await client.aclose()


def check_scores(failures: list[Failure]) -> tuple[dict[str, float], dict[str, str]]:
    """Langfuse scores: check.<name> is 1 when it passed, 0 with the reason when it failed."""
    failed = {f.name: f.detail for f in failures}
    return {f"check.{n}": 0.0 if n in failed else 1.0 for n in CHECKS}, {f"check.{n}": d for n, d in failed.items()}
