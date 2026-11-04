"""Replay a call through the real pipeline, with a scripted caller and a fake voice.

The bench simulates timing on its own, so it can't see what the pipeline does (who starts a reply,
what reaches the voice, in what order). A replay runs build_call, the same wiring as a phone call:
the caller's lines arrive the way Deepgram Flux delivers them, sentences "play" for as long as
they'd take to say, results come back from a replay desk on a delay, and the after-call checks
run at the end. The model can be the real one (python -m voice.replay) or scripted (tests).

    uv run python -m voice.replay                  # every built-in script, real voice model
    uv run python -m voice.replay --only calendar  # one of them
    uv run python -m voice.replay --from /path/to/transcript.jsonl
"""
import argparse
import asyncio
import json
import os
import re
import time
from dataclasses import dataclass, field, replace
from datetime import datetime
from zoneinfo import ZoneInfo

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMTextFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    StartFrame,
    STTMetadataFrame,
    TranscriptionFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies
from pipecat.utils.time import time_now_iso8601

from voice.checks import Failure
from voice.config import Config
from voice.turns import State

WORDS_PER_S = 2.6
_SENTENCE = re.compile(r".*?[.!?]+[\"”’)]*\s+", re.S)


# The script -----------------------------------------------------------------------------


@dataclass
class Say:
    """A caller line. By default the caller waits for Kloru to finish and pause_s of quiet;
    barge=True says it pause_s after their previous line, whatever Kloru is doing."""

    text: str
    pause_s: float = 1.0
    barge: bool = False


@dataclass
class Result:
    """What the desk sends back for a filed request containing `match` (None: any), after_s later."""

    text: str
    after_s: float = 3.0
    kind: str = "info"
    match: str | None = None


@dataclass
class Script:
    name: str
    caller: list[Say]
    results: list[Result] = field(default_factory=list)
    brief: str = ""
    linger_s: float = 4.0  # quiet after the last line and the last result, before hanging up


# Fakes ----------------------------------------------------------------------------------


class Wire(FrameProcessor):
    """Passes every frame on: where the phone call has an STT service or an audio output."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


class Caller(FrameProcessor):
    """The caller's side of the line, delivered the way Deepgram Flux delivers it."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, StartFrame):
            # Flux recommends external turn strategies: its own start/end-of-turn decide the turn.
            await self.push_frame(STTMetadataFrame(service_name="replay", ttfs_p99_latency=0.3, user_turn_strategies=ExternalUserTurnStrategies()))

    async def say(self, text: str, speed: float) -> None:
        await self.broadcast_frame(ProposedUserStartedSpeakingFrame)
        await asyncio.sleep(max(0.4, len(text.split()) / WORDS_PER_S) / speed)
        await self.push_frame(TranscriptionFrame(text, "caller", time_now_iso8601(), finalized=True))
        await self.broadcast_frame(ProposedUserStoppedSpeakingFrame)


class Voice(FrameProcessor):
    """Stands in for the TTS and the phone: each sentence plays for as long as it takes to say."""

    def __init__(self, speed: float = 1.0, **kwargs):
        super().__init__(**kwargs)
        self._speed = speed
        self._partial = ""
        self.speaking = False
        self.last_sound = time.monotonic()
        self.spoken: list[str] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMTextFrame):
            self._partial += frame.text
            while m := _SENTENCE.match(self._partial):
                self._partial = self._partial[m.end():]
                await self._play(m.group(0))
        elif isinstance(frame, LLMFullResponseEndFrame):
            rest, self._partial = self._partial, ""
            if rest.strip():
                await self._play(rest)
            await self._stop()
            await self.push_frame(frame, direction)
        elif isinstance(frame, InterruptionFrame):
            self._partial = ""
            await self._stop()
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    async def _play(self, sentence: str) -> None:
        if not self.speaking:
            self.speaking = True
            await self.broadcast_frame(BotStartedSpeakingFrame)
        self.spoken.append(sentence.strip())
        await self.push_frame(TTSTextFrame(sentence, text_type="sentence"))
        await asyncio.sleep(max(0.3, len(sentence.split()) / WORDS_PER_S) / self._speed)
        self.last_sound = time.monotonic()

    async def _stop(self) -> None:
        if self.speaking:
            self.speaking = False
            self.last_sound = time.monotonic()
            await self.broadcast_frame(BotStoppedSpeakingFrame)


class ReplayDesk:
    """The desk's side, as the voice service sees it: filed requests come back as scripted."""

    def __init__(self, results: list[Result], brief: str, speed: float):
        self._results, self.brief, self._speed = list(results), brief, speed
        self._queue: asyncio.Queue = asyncio.Queue()
        self._seq = 0
        self.filed: list[str] = []
        self.pending = 0
        self.phone = ""

    async def start(self, call_sid: str, phone: str) -> int:
        self.phone = phone
        return 1

    async def waiting(self) -> list[dict]:
        return []

    async def ack(self, seq: int) -> None:
        pass

    def add_turn(self, role: str, text: str, interrupted: bool = False) -> None:
        pass

    async def file_issue(self, request: str) -> dict:
        self.filed.append(request)
        n = len(self.filed)
        matched = [r for r in self._results if r.match is None or r.match.lower() in request.lower()]
        for r in matched:
            self._results.remove(r)
            self.pending += 1
            asyncio.get_running_loop().call_later(r.after_s / self._speed, self._queue.put_nowait, (n, r))
        return {"id": n}

    async def comment(self, issue: int, text: str) -> None:
        pass

    async def confirm(self, issue: int, draft: str) -> str | None:
        return None

    async def list_issues(self) -> list[dict]:
        return [{"id": i + 1, "status": "in_progress", "request": r} for i, r in enumerate(self.filed)]

    async def note(self, text: str) -> None:
        pass

    async def follow(self, on_merge, after: int = 0) -> None:
        while True:
            n, r = await self._queue.get()
            self._seq += 1
            self.pending -= 1
            await on_merge({"seq": self._seq, "kind": r.kind, "text": r.text, "issue": n})

    async def end(self) -> None:
        pass


# Running one --------------------------------------------------------------------------------


@dataclass
class Outcome:
    script: str
    lines: list[str]
    failures: list[Failure]
    replies: int
    seconds: float
    caller: str = ""  # whom the desk opened the call as


def replay_config(cfg: Config) -> Config:
    """Nothing leaves the machine: no Langfuse, call log, transcripts or GitHub issues."""
    return replace(cfg, langfuse=None, call_log_path=None, transcripts_dir=None, prefs_path=None, desk_enabled=True)


async def replay(script: Script, cfg: Config, llm, speed: float = 1.0, max_s: float = 240.0, caller: str | None = None) -> Outcome:
    from voice.bot import build_call  # bot imports this module's siblings; keep the import cycle out

    os.environ.pop("GITHUB_TOKEN", None)
    cfg = replay_config(cfg)
    who = caller
    caller, voice = Caller(), Voice(speed)
    desk = ReplayDesk(script.results, script.brief, speed)
    call = await build_call(cfg, f"replay-{script.name}", llm=llm, stt=Wire(), tts=voice, audio_in=caller, audio_out=Wire(), desk=desk, **({"caller": who} if who else {}))
    began = time.monotonic()
    running = asyncio.create_task(call.runner.run())
    await asyncio.sleep(0.5)  # the pipeline starts
    await call.start()

    def quiet_for(s: float) -> bool:
        return not voice.speaking and call.turns.state is State.IDLE and time.monotonic() - voice.last_sound >= s / speed

    async def until(ok, cap_s: float) -> None:
        deadline = time.monotonic() + cap_s / speed
        while not ok() and time.monotonic() < deadline:
            await asyncio.sleep(0.05)

    await until(lambda: quiet_for(0.5), 20)  # the greeting
    for line in script.caller:
        if line.barge:
            await asyncio.sleep(line.pause_s / speed)
        else:
            await until(lambda: quiet_for(line.pause_s), 30)
        if time.monotonic() - began > max_s:
            break
        await caller.say(line.text, speed)
    await until(lambda: desk.pending == 0 and quiet_for(script.linger_s), 90)
    await call.end()
    failures = await call.checked[0] if call.checked else []
    running.cancel()
    return Outcome(script.name, list(call.said), failures, call.turns.stats.replies, time.monotonic() - began, desk.phone)


# Scripts ------------------------------------------------------------------------------------

BRIEF = "Caller: Evan. Lives in Oakland\nPeople: Maya: Evan's daughter, 3, at day care | Cara: Evan's wife\nKnown names: Maya, Cara"

SCRIPTS = [
    # Call CA393c42…: one lookup, a question while it runs, the result arriving mid-wait.
    Script(
        "calendar",
        caller=[Say("Can you give me an overview of what I've got going on tomorrow?"), Say("How are you gonna tell me if I hang up?", pause_s=2.0), Say("Okay. Perfect, have a good one.", pause_s=3.0)],
        results=[Result("Tomorrow: daycare drop-off at 8 AM, the Andromeda interview 2:30 to 3 PM, daycare pickup at 4:30 PM.", after_s=12.0)],
        brief=BRIEF,
    ),
    # Two requests in one breath, results landing while the caller is still talking.
    Script(
        "two_asks_barge",
        caller=[Say("Check my email for anything from Cara, and add pickup at 4:30 tomorrow to my calendar."), Say("Oh and Maya has a dentist thing Friday, I think.", pause_s=2.5, barge=True), Say("Thanks, that's all.", pause_s=2.0)],
        results=[Result("One email from Cara this morning: dinner at her parents' Saturday at 6.", after_s=4.0, match="email"), Result("Added: Maya pickup, tomorrow 4:30 PM.", after_s=5.0, kind="events", match="calendar")],
        brief=BRIEF,
    ),
    # A long wait with nothing to say: nudges must not turn into restated plans or repeats.
    Script(
        "long_wait",
        caller=[Say("Research the best pediatric dentists near Rockridge for Maya."), Say("Great, thanks.", pause_s=26.0)],
        results=[Result("Top pick: Rockridge Kids Dental, 4.9 stars, takes new patients, 0.6 miles away.", after_s=28.0)],
        brief=BRIEF,
    ),
]


def script_from_transcript(path: str) -> Script:
    """A recorded call (/data/voice/transcripts/…jsonl) as a script: the caller's lines with their
    pauses, and each result coming back as long after its filing as it did."""
    rows = [json.loads(l) for l in open(path) if l.strip()]
    stamp = lambda r: datetime.fromisoformat(r["at"].replace("Z", "+00:00")).timestamp()  # noqa: E731
    caller, results, last = [], [], None
    first_caller = next((stamp(r) for r in rows if r["kind"] == "caller"), None)
    for r in rows:
        if r["kind"] == "caller":
            caller.append(Say(r["text"], pause_s=min(4.0, max(0.5, stamp(r) - last)) if last else 1.0))
            last = stamp(r)
        elif r["kind"] == "kloru":
            last = stamp(r)
        elif r["kind"] == "task_finished" and first_caller is not None:
            results.append(Result(r.get("result", ""), after_s=max(2.0, stamp(r) - first_caller), kind=r.get("status", "info") if r.get("status") in ("info", "events") else "info"))
    return Script(os.path.basename(path).split(".")[0], caller, results, brief=BRIEF)


def _print(o: Outcome) -> None:
    print(f"\n=== {o.script}  ({o.seconds:.0f} s, {o.replies} replies)")
    for line in o.lines:
        print(f"  {line}")
    print("  checks: " + ("all passed" if not o.failures else "; ".join(f"{f.name}: {f.detail}" for f in o.failures)))


async def _main() -> int:
    from dotenv import load_dotenv

    from voice.bot import VoiceLLM, llm_settings, system_prompt
    from voice.config import load_config

    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--from", dest="path")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()
    load_dotenv()
    logger.remove()
    logger.add(lambda m: print(m, end=""), level="WARNING")
    cfg = load_config(os.environ)
    scripts = [script_from_transcript(args.path)] if args.path else [s for s in SCRIPTS if not args.only or s.name == args.only]
    failed = 0
    for s in scripts:
        llm = VoiceLLM(api_key=cfg.openrouter_api_key, settings=llm_settings(cfg, system_prompt(datetime.now(ZoneInfo(cfg.owner_timezone)), desk=True)))
        o = await replay(s, cfg, llm, speed=args.speed)
        _print(o)
        failed += bool(o.failures)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
