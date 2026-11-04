"""Play one bench scenario: a simulated caller against the real front desk, in simulated time.

The talking model gets the production system prompt, tools and message formats (<info>/<events>
merges, KeepAlive nudges). Time is simulated: speech takes time in proportion to its words, filed
requests come back after the scenario's delay, and silences run the production KeepAlive. The
result is a transcript the judge can read ([bracketed] lines are what happened around the words)
and the same timing scores live calls get.
"""
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime

from pipecat.observers.speaking_observer import SpeechEvent, SpeechEventKind as K

from voice.bench.scenarios import HOUSEHOLD, Scenario, StubResult
from voice.bot import DESK_TOOLS, system_prompt
from voice.desk import merge_message
from voice.quiet import count_repeats
from voice.keepalive import KeepAlive
from voice.observability import call_metrics, style_metrics

# A chat model: (messages, tools) -> {"content": str | None, "tool_calls": [{"id", "name", "arguments": dict}]}
Chat = Callable[[list[dict], list[dict] | None], Awaitable[dict]]

WORDS_PER_S = 2.6
TURN_GAP_S = 0.6
WAIT_LIMIT_S = 25.0
STEP_S = 0.5
MAX_SIM_S = 300.0

TOOLS = [{"type": "function", "function": t.to_default_dict()} for t in DESK_TOOLS.standard_tools]


def caller_prompt(sc: Scenario) -> str:
    return (
        "You are role-playing a person on a phone call with Kloru, their AI assistant. Stay in character.\n"
        f"Who you are: {sc.persona}\nWhat you want: {sc.goal}\n"
        "Reply with only what you say next: one short spoken line, the way you'd really talk. Show feelings "
        "naturally if the call is slow, repetitive or great. If you're waiting and have nothing to say, reply "
        "exactly [wait]. When your goal is met, or you'd give up, reply exactly [hang up]."
    )


@dataclass
class Episode:
    scenario: str
    lines: list[str] = field(default_factory=list)
    filed: list[str] = field(default_factory=list)
    events: list[SpeechEvent] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)
    seconds: float = 0.0


class _Run:
    def __init__(self, sc: Scenario, talker: Chat, caller: Chat, now: datetime, brief: bool):
        self.sc, self.talker, self.caller = sc, talker, caller
        self.t = 0.0
        self.ep = Episode(sc.id)
        system = system_prompt(now, desk=True)
        if brief and sc.known:
            system += f"\n\nWhat you already know (from memory):\n{sc.known}"
            names = next((l for l in sc.known.splitlines() if l.startswith("Known names:")), sc.known.splitlines()[-1])
            # The judge sees what the scenario added to the household brief, so an answer from it isn't marked made up.
            extra = sc.known[len(HOUSEHOLD):].strip() if sc.known.startswith(HOUSEHOLD) else ""
            self.ep.lines.append(f"[What Kloru knew before the call: {names}{chr(10) + extra if extra else ''}]")
        self.kloru_msgs: list[dict] = [{"role": "system", "content": system}]
        self.caller_msgs: list[dict] = [{"role": "system", "content": caller_prompt(sc)}]
        self.pending: dict[int, list[tuple[float, StubResult]]] = {}
        self.requests: dict[int, str] = {}
        self.next_issue = 1
        self.talker_s: list[float] = []  # real seconds per talking-model call: silence on a live call
        self.nudges: list[str] = []
        # Repeats are the model's call; the bench counts them, as production's after-call checks do.
        self.said: set[str] = set()
        self.repeats = 0
        self.keepalive = KeepAlive(self._nudge, clock=lambda: self.t)

    async def _nudge(self, text: str) -> None:
        self.nudges.append(text)

    # Speech ----------------------------------------------------------------------

    def _speak(self, who: str, text: str) -> None:
        start = self.t
        dur = max(0.6, len(text.split()) / WORDS_PER_S)
        kinds = (K.USER_SPEECH_STARTED, K.USER_SPEECH_STOPPED) if who == "Caller" else (K.BOT_SPEECH_STARTED, K.BOT_SPEECH_STOPPED)
        began = SpeechEvent(kind=kinds[0], timestamp=start)
        self.ep.events.append(began)
        self.keepalive.observe(began)
        # The clock reaches the end of the speech before its end is observed, as it would live.
        self.t = start + dur
        ended = SpeechEvent(kind=kinds[1], timestamp=self.t, started_at=start)
        self.ep.events.append(ended)
        self.keepalive.observe(ended)
        if who == "Caller":
            self.said.clear()
            self.ep.events.append(SpeechEvent(kind=K.USER_TURN_STOPPED, timestamp=self.t + 0.3))
        self.t += TURN_GAP_S
        self.ep.lines.append(f"{who}: {text}")

    def _note(self, text: str) -> None:
        self.ep.lines.append(f"[{text}]")
        self.caller_msgs.append({"role": "user", "content": f"[{text}]"} if not text.startswith("result") else {"role": "user", "content": "[a moment passes]"})

    # The talking model -------------------------------------------------------------

    async def _kloru(self, msg: dict) -> None:
        self.kloru_msgs.append(msg)
        spoken: list[str] = []
        for _ in range(3):
            began = time.monotonic()
            reply = await self.talker(self.kloru_msgs, TOOLS)
            self.talker_s.append(time.monotonic() - began)
            content = (reply.get("content") or "").strip()
            if content.lower() == "[quiet]":
                content = ""  # production's QuietFilter drops it before the voice
            calls = reply.get("tool_calls") or []
            assistant: dict = {"role": "assistant", "content": content or None}
            if calls:
                assistant["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c.get("arguments") or {})}} for c in calls]
            self.kloru_msgs.append(assistant)
            if content:
                self.repeats += count_repeats(content, self.said)
            if content:
                spoken.append(content)
            for c in calls:
                self.kloru_msgs.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(self._tool(c["name"], c.get("arguments") or {}))})
            # Production skips a second pass when the reply already spoke.
            if not calls or content:
                break
        if spoken:
            text = " ".join(spoken)
            self._speak("Kloru", text)
            self.caller_msgs.append({"role": "user", "content": text})

    def _tool(self, name: str, args: dict) -> dict:
        if name == "file_issue":
            req = str(args.get("request", ""))
            n, self.next_issue = self.next_issue, self.next_issue + 1
            # One request can ask for several things; each matching result comes back on its own delay.
            matched = [r for r in self.sc.results if r.match and r.match in req.lower()] or [self.sc.default]
            self.pending[n] = [(self.t + r.delay_s, r) for r in matched]
            self.requests[n] = req
            self.ep.filed.append(req)
            self.keepalive.filed(n, req)
            self.ep.lines.append(f"[Kloru filed issue {n}: {req}]")
            return {"issue": n, "status": "filed"}
        if name == "update_issue":
            n = int(args.get("issue", 0))
            self.ep.lines.append(f"[Kloru updated issue {n}: {args.get('text', '')}]")
            text = str(args.get("text", "")).lower()
            # Only a real cancellation cancels: "do not delete anything" is a change, not a cancel.
            if any(w in text for w in ("never mind", "nevermind", "cancel the", "cancel this", "cancel it", "forget it", "forget about it", "don't do it", "stop the")):
                self.pending.pop(n, None)
                self.keepalive.resolved(n)
            return {"issue": n, "updated": True}
        if name == "confirm":
            n = int(args.get("issue", 0))
            self.ep.lines.append(f"[Kloru confirmed issue {n}]")
            self.pending[n] = [(self.t + 8, StubResult("", 8, "events", "Sent."))]
            self.requests[n] = "confirmed send"
            self.keepalive.filed(n, "sending the confirmed draft")
            return {"issue": n, "confirmed": True}
        if name == "list_issues":
            return {"issues": [{"issue": n, "status": "in_progress", "request": self.requests.get(n, "")} for n in self.pending]}
        return {"saved": True}

    # Time ------------------------------------------------------------------------------

    async def _deliver_due(self) -> bool:
        due = sorted((at, n, r) for n, items in self.pending.items() for at, r in items if at <= self.t)
        if not due:
            return False
        for at, n, result in due:
            self.pending[n] = [(a, r) for a, r in self.pending[n] if (a, r) != (at, result)]
            if not self.pending[n]:
                self.pending.pop(n)
                self.keepalive.resolved(n)
            self._note(f"result arrives: {result.text}")
            await self._kloru({"role": "developer", "content": merge_message({"seq": n, "kind": result.kind, "text": result.text, "issue": n})})
        return True

    async def _wait(self) -> None:
        """The caller is waiting: run the clock until a result or a nudge, or the wait limit."""
        start = self.t
        while self.t - start < WAIT_LIMIT_S:
            self.t += STEP_S
            if await self._deliver_due():
                return
            await self.keepalive.tick()
            if self.nudges:
                text = self.nudges.pop(0)
                self._note(f"{self.t - start:.0f} seconds of silence")
                await self._kloru({"role": "developer", "content": text})
                return
        self._note(f"{WAIT_LIMIT_S:.0f} seconds of silence")

    async def play(self) -> Episode:
        self._speak("Caller", self.sc.opening)
        self.caller_msgs.append({"role": "assistant", "content": self.sc.opening})
        await self._kloru({"role": "user", "content": self.sc.opening})
        for _ in range(self.sc.max_turns):
            if self.t > MAX_SIM_S:
                break
            await self._deliver_due()
            line = ((await self.caller(self.caller_msgs, None)).get("content") or "").strip()
            if not line or "[hang up]" in line.lower():
                break
            if line.lower().startswith("[wait"):
                self.caller_msgs.append({"role": "assistant", "content": "[wait]"})
                await self._wait()
                continue
            self._speak("Caller", line)
            self.caller_msgs.append({"role": "assistant", "content": line})
            await self._kloru({"role": "user", "content": line})
        self.ep.seconds = self.t
        spoken = [l for l in self.ep.lines if not l.startswith("[")]
        self.ep.metrics = call_metrics(self.ep.events) | style_metrics(spoken) | {"talker.repeats": float(self.repeats)}
        if self.talker_s:
            ordered = sorted(self.talker_s)
            self.ep.metrics["talker.latency_p50_s"] = ordered[len(ordered) // 2]
            self.ep.metrics["talker.latency_max_s"] = ordered[-1]
        return self.ep


async def run_scenario(sc: Scenario, talker: Chat, caller: Chat, now: datetime, brief: bool = True) -> Episode:
    return await _Run(sc, talker, caller, now, brief).play()
