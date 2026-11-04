"""One phone call: Twilio audio in, Deepgram, the voice model with background-task tools, Cartesia, audio out."""
import asyncio
import os
from dataclasses import dataclass, field
from collections.abc import Awaitable, Callable
from datetime import datetime
from zoneinfo import ZoneInfo

from loguru import logger
from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import Frame, FunctionCallResultProperties, LLMFullResponseStartFrame, LLMMessagesAppendFrame, LLMTextFrame
from pipecat.observers.speaking_observer import SpeakingObserver, SpeechEventKind
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from voice.checks import CallFacts, ErrorTally, Failure, alert, check_scores, run_checks
from voice.config import Config
from voice.desk import DeskClient, merge_message
from voice.keepalive import KeepAlive
from voice.quiet import QUIET, QuietFilter, RepeatFilter
from voice.observability import LangfuseClient, call_metrics, judge_call, style_metrics
from voice.instinct import ask_instinct
from voice.tasks import Task, TaskBoard
from voice.turns import ReplyTap, Turns
from voice.prefs import transcripts_allowed
from voice.style import StyleMeter
from voice.transcript import Transcript

SYSTEM_PROMPT = """You are the owner's personal assistant on a live phone call. Sound like a sharp, warm
human assistant: short spoken sentences, contractions, no lists, no markdown, no symbols.

How you work:
- A team works in the background for you. Anything that needs the owner's data or a real action
  (calendar, email, contacts, reminders, research, anything on their accounts) goes to start_task.
  start_task returns at once; you never wait for the work.
- In the same reply, first say a few spoken words (a short acknowledgement plus, when useful, one
  question), then call start_task. Never call start_task without speaking in that reply.
- Use size "quick" for lookups (usually 5 to 20 seconds) and "long" for bigger jobs such as inbox
  cleanup or research, which can take minutes and keep running after the call.
- Write each request with exact dates (from the current time below), never relative words alone.
  For calendar lookups, ask for all of the owner's calendars, not just the primary one.
- Never leave dead air while work runs. Ask one useful question at a time: what they are trying to
  get done, what matters about it, how they like things done. If a request sounds recurring, offer
  to make it automatic, for example a nightly text with tomorrow's schedule.
- For a long task, ask whether they want to be told when it is done, and whether there is anything
  else meanwhile.
- When a message says a background task finished, give the owner the result at a natural moment,
  in one or two sentences, tied to what they said meanwhile. Finish the current thought first.
- Never invent results, times or facts. If something is not back yet, say it is still coming.
- When the owner reveals something durable about themselves (routines, preferences, people,
  goals), call remember with one short fact. Do not announce it.
- If asked what is running, use list_tasks. Before the owner hangs up, mention anything still running."""



DESK_PROMPT = """You are Kloru, the owner's assistant on a phone call. Speak in first person.
- Sharp and warm: short sentences, said once, matching their length and pace.
- Speak, don't format: a list becomes sentences ("Friday: three things…"), links go by text, no ids.
- For their accounts or actions, speak, then file_issue each request, even mid-task; update_issue only changes or cancels that one.
- Say once how long: lookups seconds, bigger jobs a minute or two.
- <info> is learned, <events> is done: pass on only what's new; claim done only after <events>.
- A result needing their yes: say it plainly; confirm after a clear yes; never ask twice.
- While it runs, ask what would change the result (bars or bonbons?); pass answers via update_issue. Never restate the plan. Nothing new? Reply just [quiet].
- If useful, say once they can hang up; you'll send the rest.
- If they're frustrated, say so and offer: "give me everything; I'll follow up."
- While waiting, offer one of "Things you could offer" or to make a chore automatic ("want this nightly?"); ask someone new one warm question unless rushed.
- Their own guidelines win over these."""


def system_prompt(now: datetime, desk: bool = False) -> str:
    base = DESK_PROMPT if desk else SYSTEM_PROMPT
    return f"{base}\n\nRight now it is {now:%A, %B} {now.day}, {now:%Y, %-I:%M %p} in {now.tzinfo}."


def llm_settings(cfg: Config, prompt: str) -> OpenRouterLLMService.Settings:
    # Luna reasons before speaking unless told not to; at minimal effort the first word comes ~1.5 s sooner.
    return OpenRouterLLMService.Settings(
        model=cfg.voice_model,
        system_instruction=prompt,
        extra={"extra_body": {"reasoning": {"effort": cfg.voice_reasoning_effort}}},
    )


class SpeechTracker:
    """Whether the current LLM response has said anything yet ([quiet] isn't speech)."""

    def __init__(self):
        self._text = ""

    @property
    def spoke(self) -> bool:
        said = self._text.strip()
        return bool(said) and said.lower() != QUIET

    def observe(self, frame: Frame) -> None:
        if isinstance(frame, LLMFullResponseStartFrame):
            self._text = ""
        elif isinstance(frame, LLMTextFrame):
            self._text += frame.text


class VoiceLLM(OpenRouterLLMService):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.speech = SpeechTracker()
        # Whether the reply that made each tool call had spoken by then: decided while that reply
        # is still the current one, so a later reply can't change the answer.
        self.spoke_by_call: dict[str, bool] = {}

    async def push_frame(self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM):
        self.speech.observe(frame)
        await super().push_frame(frame, direction)

    async def run_function_calls(self, function_calls):
        for call in function_calls:
            self.spoke_by_call[call.tool_call_id] = self.speech.spoke
        await super().run_function_calls(function_calls)


TOOLS = ToolsSchema(
    standard_tools=[
        FunctionSchema(
            name="start_task",
            description="Start background work on the owner's agent (calendar, email, apps, memory, research). Returns immediately with a task id; the result arrives later as a message.",
            properties={
                "request": {"type": "string", "description": "The task in one clear sentence, with dates and times exactly as the owner said them."},
                "size": {"type": "string", "enum": ["quick", "long"], "description": "quick for lookups, long for multi-step jobs."},
            },
            required=["request", "size"],
        ),
        FunctionSchema(name="list_tasks", description="List background tasks started on this call and their status.", properties={}, required=[]),
        FunctionSchema(
            name="remember",
            description="Save one durable fact about the owner (routine, preference, person, goal) for future conversations.",
            properties={"fact": {"type": "string", "description": "One short fact."}},
            required=["fact"],
        ),
    ]
)


_REMEMBER = FunctionSchema(
    name="remember",
    description="Save one durable fact about the owner (routine, preference, person, goal) for future conversations.",
    properties={"fact": {"type": "string", "description": "One short fact."}},
    required=["fact"],
)

DESK_TOOLS = ToolsSchema(
    standard_tools=[
        FunctionSchema(
            name="file_issue",
            description="Start background work on a request. Returns at once with an issue number; results come back later as <info> or <events>.",
            properties={"request": {"type": "string", "description": "What the caller wants, in their words, with every detail that matters."}},
            required=["request"],
        ),
        FunctionSchema(
            name="update_issue",
            description="Add a detail to, change, or cancel an issue already filed.",
            properties={"issue": {"type": "integer", "description": "The issue number."}, "text": {"type": "string", "description": "What changed, in the caller's words."}},
            required=["issue", "text"],
        ),
        FunctionSchema(
            name="confirm",
            description="The caller said yes to the draft an <info> asked about. Only after a clear yes.",
            properties={
                "issue": {"type": "integer", "description": "The issue number from the <info>."},
                "draft": {"type": "string", "description": "The draft id from that same <info>, so the yes covers exactly what they heard."},
            },
            required=["issue", "draft"],
        ),
        FunctionSchema(name="list_issues", description="What you are working on right now.", properties={}, required=[]),
        _REMEMBER,
    ]
)

UNREACHABLE = "That couldn't be started just now. Tell the caller in first person and offer to try again."


Spoke = Callable[[str], bool]
Owe = Callable[[str, bool], Awaitable[None]]
NO_RUN = FunctionCallResultProperties(run_llm=False)


async def _nothing_owed(_call_id: str, _needs_reply: bool) -> None:
    pass


def _call_id(params) -> str:
    return getattr(params, "tool_call_id", "") or ""


def make_desk_handlers(desk, board: TaskBoard, spoke: Spoke = lambda _id: False, owe: Owe = _nothing_owed, on_filed=lambda issue, request: None, on_action=lambda text: None) -> dict:
    """The front desk's tools. Failures go back to the model as results, never into the call.

    No tool result runs the model (Turns decides that): each says whether the caller is owed
    words, which is when the reply that called it said nothing, or the result must be read out."""

    async def done(params, result: dict, needs_reply: bool) -> None:
        await params.result_callback(result, properties=NO_RUN)
        await owe(_call_id(params), needs_reply)

    def silent(params) -> bool:
        return not spoke(_call_id(params))

    async def file_issue(params):
        try:
            issue = await desk.file_issue(params.arguments["request"])
        except Exception as err:  # noqa: BLE001
            logger.error(f"desk: file_issue failed: {err!r}")
            await done(params, {"filed": False, "why": UNREACHABLE}, True)
            return
        on_filed(issue["id"], params.arguments["request"])
        on_action(f"Kloru filed issue {issue['id']}: {params.arguments['request']}")
        await done(params, {"issue": issue["id"], "status": "filed"}, silent(params))

    async def update_issue(params):
        try:
            await desk.comment(int(params.arguments["issue"]), params.arguments["text"])
        except Exception as err:  # noqa: BLE001
            logger.error(f"desk: update_issue failed: {err!r}")
            await done(params, {"updated": False, "why": UNREACHABLE}, True)
            return
        on_action(f"Kloru updated issue {int(params.arguments['issue'])}: {params.arguments['text']}")
        await done(params, {"issue": int(params.arguments["issue"]), "updated": True}, silent(params))

    async def confirm(params):
        n = int(params.arguments["issue"])
        try:
            why = await desk.confirm(n, str(params.arguments.get("draft", "")))
        except Exception as err:  # noqa: BLE001
            logger.error(f"desk: confirm failed: {err!r}")
            await done(params, {"issue": n, "confirmed": False, "why": UNREACHABLE}, True)
            return
        if why is None:
            on_action(f"Kloru confirmed issue {n}")
            await done(params, {"issue": n, "confirmed": True}, silent(params))
        else:
            await done(params, {"issue": n, "confirmed": False, "why": why}, True)

    async def list_issues(params):
        try:
            issues = await desk.list_issues()
        except Exception as err:  # noqa: BLE001
            logger.error(f"desk: list_issues failed: {err!r}")
            await done(params, {"issues": [], "why": UNREACHABLE}, True)
            return
        await done(params, {"issues": [{"issue": i["id"], "status": i["status"], "request": i["request"]} for i in issues]}, True)

    async def remember(params):
        try:
            await desk.note(params.arguments["fact"])
        except Exception as err:  # noqa: BLE001 - losing a note must not break the call
            logger.error(f"desk: note failed: {err!r}")
        await done(params, {"saved": True}, False)

    return {"file_issue": file_issue, "update_issue": update_issue, "confirm": confirm, "list_issues": list_issues, "remember": remember}


def task_result_message(task: Task) -> str:
    if task.status == "failed":
        return f"Background task {task.id} ({task.request}) failed: {task.result}. Tell the owner briefly at the next natural moment."
    return f"Background task {task.id} finished. Request: {task.request}. Result: {task.result} Tell the owner at the next natural moment."


def make_tool_handlers(board: TaskBoard, spoke: Spoke = lambda _id: False, owe: Owe = _nothing_owed) -> dict:
    """Without the desk: one-sentence tasks. Same rule as the desk: no result runs the model."""

    async def start_task(params):
        size = params.arguments.get("size") if params.arguments.get("size") in ("quick", "long") else "quick"
        task = board.start(params.arguments["request"], size=size)
        await params.result_callback({"task_id": task.id, "status": "started", "size": size}, properties=NO_RUN)
        await owe(_call_id(params), not spoke(_call_id(params)))

    async def list_tasks(params):
        await params.result_callback({"tasks": board.summary()}, properties=NO_RUN)
        await owe(_call_id(params), True)

    async def remember(params):
        board.start(f"Save this to durable memory about the owner, then reply only 'Saved.': {params.arguments['fact']}", quiet=True)
        await params.result_callback({"saved": True}, properties=NO_RUN)

    return {"start_task": start_task, "list_tasks": list_tasks, "remember": remember}


def make_stt(cfg: Config):
    """Deepgram Flux by default: it ends the caller's turn from their words, not from room silence.

    Background noise that isn't words can't hold a turn open, and Flux owns barge-in too. Every
    request opts out of Deepgram's model improvement program (call audio isn't kept to train
    models; see /privacy). VOICE_STT=nova returns to Nova with local VAD + smart-turn.
    """
    if cfg.stt == "nova":
        return DeepgramSTTService(api_key=cfg.deepgram_api_key, mip_opt_out=True)
    return DeepgramFluxSTTService(
        api_key=cfg.deepgram_api_key,
        mip_opt_out=True,
        # Start answering at Flux's predicted end of turn (VOICE_EAGER_EOT); Pipecat holds that reply
        # until the turn is confirmed, drops it if they keep talking, and never runs its tool calls.
        enable_eager_end_of_turn=cfg.eager_eot,
        settings=DeepgramFluxSTTService.Settings(
            model="flux-general-en",
            # A turn ends at the latest this long after the caller's last word, whatever Flux thinks.
            eot_timeout_ms=cfg.flux_eot_timeout_ms,
            keyterm=["Kloru"],
        ),
    )


def user_params(cfg: Config) -> LLMUserAggregatorParams:
    """With Flux, no turn strategy of ours: the service's recommended strategies take over.

    The VAD stays for the speech timing scores (end-of-turn delay, silence) only; its volume floor
    keeps quieter background sound from counting as the caller speaking.
    """
    vad = SileroVADAnalyzer(params=VADParams(min_volume=cfg.vad_min_volume))
    if cfg.stt == "nova":
        return LLMUserAggregatorParams(vad_analyzer=vad, user_turn_strategies=turn_strategies(cfg))
    return LLMUserAggregatorParams(vad_analyzer=vad)


def turn_strategies(cfg: Config) -> UserTurnStrategies:
    """Pipecat's defaults, but the smart-turn silence fallback is cfg.turn_stop_secs, not 3 s.

    When the smart-turn model calls a pause "incomplete", this fallback is how long the
    caller hears nothing before the agent replies anyway.
    """
    analyzer = LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=cfg.turn_stop_secs))
    return UserTurnStrategies(stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=analyzer)])


GREETING = "Greet the caller warmly in a few words and ask what is on their mind."


def opening_messages(brief: str, greeting: str) -> list[dict]:
    """What Kloru knows goes in before the greeting, so the first words aren't blind."""
    known = [{"role": "developer", "content": f"What you already know (from memory):\n{brief}"}] if brief else []
    return [*known, {"role": "developer", "content": greeting}]


def greeting_for(waiting: list[dict]) -> str:
    """One opening reply, carrying any results that were waiting, so Kloru never greets twice."""
    if not waiting:
        return GREETING
    results = "\n".join(merge_message(m) for m in waiting)
    return f"Greet the caller warmly in a few words, then pass these results on, in one reply:\n{results}"


async def check_call(cfg: Config, call_sid: str, facts: CallFacts, lines: list[str]) -> list[Failure]:
    """After hang-up: the checks (always), then the call's numbers and the judge's read to Langfuse."""
    metrics = call_metrics(facts.events) | style_metrics(lines)
    facts.metrics = metrics
    failures = run_checks(facts)
    await alert(call_sid, failures, alerts_path(cfg))
    if not cfg.langfuse:
        return failures
    lf = LangfuseClient(cfg.langfuse)
    try:
        values, comments = check_scores(failures)
        await lf.scores(call_sid, metrics | values, comments=comments)
        judged = await judge_call(cfg, lines)
        if judged:
            await lf.scores(call_sid, {k: v for k, (v, _) in judged.items()}, comments={k: why for k, (_, why) in judged.items()})
        logger.info(f"call {call_sid}: {len(failures)} check(s) failed, {len(facts.events)} speech events, judged={bool(judged)}")
    except Exception as err:  # noqa: BLE001
        logger.error(f"call {call_sid}: report failed: {err!r}")
    finally:
        await lf.aclose()
    return failures


def alerts_path(cfg: Config) -> str | None:
    """alerts.jsonl next to the call log, on the volume."""
    return os.path.join(os.path.dirname(cfg.call_log_path), "alerts.jsonl") if cfg.call_log_path else None


@dataclass
class CallParts:
    """One call's pipeline and wiring, apart from where its audio comes from and goes to."""

    start: Callable[[], Awaitable[None]]  # the caller connected
    end: Callable[[], Awaitable[None]]  # the caller hung up
    runner: WorkerRunner
    turns: Turns
    said: list[str]
    checked: list[asyncio.Task] = field(default_factory=list)  # the after-call checks, once ended


async def build_call(cfg: Config, call_sid: str, *, llm: "VoiceLLM", stt, tts, audio_in, audio_out, desk=None, observers: list | None = None, caller: str | None = None) -> CallParts:
    """Everything between the caller's audio and Kloru's: the same for a phone call and a replay."""
    caller = caller or cfg.owner_phone  # the owner, or the family member the webhook admitted
    context = LLMContext(tools=DESK_TOOLS if cfg.desk_enabled else TOOLS)
    user_agg, assistant_agg = LLMContextAggregatorPair(context, user_params=user_params(cfg))

    # "Help improve Kloru for everyone" (website Settings): transcripts, traces and the judge need it on.
    improve = transcripts_allowed(cfg.prefs_path, caller)
    keep = cfg.transcripts_dir and improve
    said: list[str] = []  # for the judge
    transcript = Transcript(cfg.transcripts_dir, call_sid, caller) if keep else None
    call_over = False
    caller_spoke = False
    worker: PipelineWorker | None = None

    async def push(messages, run_llm):
        await worker.queue_frames([LLMMessagesAppendFrame(messages=messages, run_llm=run_llm)])

    async def after_call(content):
        # The call is over: note the result where the next conversation will see it.
        await ask_instinct(f"Note in today's journal (not durable memory): a task the owner started on a phone call finished after the call ended. {content}", f"voice:{call_sid}:after", cfg)

    # With the desk, a merge counts as delivered once it reaches the model; anything still held
    # at hang-up is never acknowledged, so the desk carries it into this phone's next call.
    seq_of: dict[str, int] = {}

    def handed_over(contents: list[str]) -> None:
        for content in contents:
            seq = seq_of.pop(content, None)
            if seq is not None and desk:
                asyncio.create_task(desk.ack(seq))

    # The only thing that starts Kloru's replies (besides the caller's own turn): see voice/turns.py.
    turns = Turns(push, after_call=None if desk else after_call, on_pushed=handed_over if desk else None)
    repeats = RepeatFilter()
    errors = ErrorTally()
    pipeline = Pipeline([audio_in, stt, user_agg, llm, QuietFilter(), repeats, ReplyTap(turns), tts, audio_out, assistant_agg])
    speaking = SpeakingObserver()
    speech_events: list = []
    # No unexplained silence (#5): while filed work runs, Kloru may fill a quiet stretch, but only
    # into real silence with nothing owed (Turns drops the nudge otherwise).
    keepalive = KeepAlive(turns.nudge)
    style = StyleMeter()  # #28: a word to the model when its replies run long for this caller

    @speaking.event_handler("on_speech_event")
    async def on_speech_event(_observer, event):
        speech_events.append(event)
        keepalive.observe(event)
        if event.kind == SpeechEventKind.BOT_SPEECH_STARTED:
            turns.bot_started()
        elif event.kind == SpeechEventKind.BOT_SPEECH_STOPPED:
            await turns.bot_stopped()

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000),
        observers=[speaking, errors, *(observers or [])],
        enable_tracing=bool(cfg.langfuse) and improve,
        conversation_id=call_sid,
        additional_span_attributes={"langfuse.session.id": call_sid, "session.id": call_sid, "langfuse.trace.name": "call"},
    )
    runner = WorkerRunner(handle_sigint=False, force_gc=True)
    await runner.add_workers(worker)

    async def on_done(task):
        if transcript:
            transcript.task_finished(int(task.id), task.status, task.result or "", after_call=call_over)
        if not task.quiet:
            await turns.offer(task_result_message(task))

    def on_start(task):
        if transcript:
            transcript.task_started(int(task.id), task.request, "memory" if task.quiet else task.size)

    board = TaskBoard(call_sid, lambda request, conversation_id: ask_instinct(request, conversation_id, cfg), on_done, on_start)
    follower: asyncio.Task | None = None
    spoke = lambda call_id: llm.spoke_by_call.get(call_id, False)  # noqa: E731
    if desk:
        handlers = make_desk_handlers(desk, board, spoke=spoke, owe=turns.tool_result, on_filed=keepalive.filed, on_action=lambda t: said.append(f"[{t}]"))
    else:
        handlers = make_tool_handlers(board, spoke=spoke, owe=turns.tool_result)
    for name, handler in handlers.items():
        llm.register_function(name, handler, cancel_on_interruption=False)

    async def on_merge(item):
        said.append(f"[result arrives: {item.get('text', '')}]")
        # A change told as it happened is progress: its issue is still running.
        if item.get("issue") is not None and not item.get("progress"):
            keepalive.resolved(int(item["issue"]))
        if transcript:
            transcript.task_finished(int(item.get("issue") or 0), item.get("kind", "info"), item.get("text", ""), after_call=call_over)
        content = merge_message(item)
        seq_of[content] = int(item["seq"])
        await turns.offer(content)

    @user_agg.event_handler("on_user_turn_started")
    async def on_user_started(*_):
        await turns.caller_started()

    @user_agg.event_handler("on_user_turn_stopped")
    async def on_user_stopped(_agg, _strategy, message=None):
        nonlocal caller_spoke
        if transcript and message is not None and message.content:
            transcript.caller(message.content)
        if message is not None and message.content:
            caller_spoke = True
            said.append(f"Caller: {message.content}")
            style.caller_said(message.content)
        if desk and message is not None and message.content:
            desk.add_turn("caller", message.content)
        await turns.caller_stopped()

    @assistant_agg.event_handler("on_assistant_turn_stopped")
    async def on_assistant_stopped(_agg, message=None):
        if transcript and message is not None and message.content:
            transcript.kloru(message.content, interrupted=message.interrupted)
        if message is not None and message.content:
            said.append(f"Kloru: {message.content}{' (cut off)' if message.interrupted else ''}")
            style.kloru_said(message.content)
            if note := style.note():
                await push([{"role": "developer", "content": note}], False)
        if desk and message is not None and message.content:
            desk.add_turn("kloru", message.content, interrupted=message.interrupted)

    async def start():
        nonlocal follower
        greeting, brief = GREETING, ""
        if desk:
            try:
                await desk.start(call_sid, caller)
                brief = desk.brief
                # Results waiting from earlier calls go into the greeting itself, not a second reply.
                waiting = await desk.waiting()
                greeting = greeting_for(waiting)
                after = max((int(m["seq"]) for m in waiting), default=0)
                if after:
                    asyncio.create_task(desk.ack(after))
                follower = asyncio.create_task(desk.follow(on_merge, after=after))
            except Exception as err:  # noqa: BLE001 - the call still works; filing will report it couldn't start
                logger.error(f"desk: could not open call {call_sid}: {err!r}")
        await turns.begin(opening_messages(brief, greeting))
        keepalive.start()

    checked: list[asyncio.Task] = []

    async def end():
        logger.info(f"call {call_sid} ended; {len([t for t in board.summary() if t['status'] == 'running'])} task(s) still running")
        nonlocal call_over
        call_over = True
        keepalive.stop()
        if transcript:
            transcript.ended()
        if desk:
            if follower:
                follower.cancel()
            await desk.end()  # issues keep running on the desk; late merges reach the next call
        await turns.ended()  # tasks keep running; their results go to after_call
        facts = CallFacts(turns=turns.stats, repeats_blocked=repeats.dropped, errors=list(errors.errors), events=list(speech_events), caller_spoke=caller_spoke)
        checked.append(asyncio.create_task(check_call(cfg, call_sid, facts, list(said) if improve else [])))
        await runner.cancel()

    return CallParts(start=start, end=end, runner=runner, turns=turns, said=said, checked=checked)


async def run_call(ws, stream_sid: str, call_sid: str, cfg: Config, caller: str) -> None:
    logger.info(f"call {call_sid} connected")
    transport = FastAPIWebsocketTransport(
        websocket=ws,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=TwilioFrameSerializer(
                stream_sid=stream_sid,
                call_sid=call_sid,
                account_sid=cfg.twilio_account_sid,
                auth_token=cfg.twilio_auth_token,
            ),
        ),
    )
    llm = VoiceLLM(api_key=cfg.openrouter_api_key, settings=llm_settings(cfg, system_prompt(datetime.now(ZoneInfo(cfg.owner_timezone)), desk=cfg.desk_enabled)))
    tts = CartesiaTTSService(api_key=cfg.cartesia_api_key, settings=CartesiaTTSService.Settings(voice=cfg.cartesia_voice_id))
    desk = DeskClient(cfg) if cfg.desk_enabled else None
    call = await build_call(cfg, call_sid, llm=llm, stt=make_stt(cfg), tts=tts, audio_in=transport.input(), audio_out=transport.output(), desk=desk, caller=caller)

    @transport.event_handler("on_client_connected")
    async def on_connected(_transport, _client):
        await call.start()

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(_transport, _client):
        await call.end()

    await call.runner.run()
