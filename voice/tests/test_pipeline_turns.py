"""The real Pipecat pipeline with a scripted model: Turns is the only thing that starts a reply."""
import asyncio

from pipecat.frames.frames import LLMMessagesAppendFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.services.llm_service import FunctionCallFromLLM
from pipecat.tests.utils import SleepFrame, run_test

from voice.bot import DESK_TOOLS, VoiceLLM, llm_settings, make_desk_handlers
from voice.quiet import QuietFilter, RepeatFilter
from voice.tasks import TaskBoard
from voice.turns import ReplyTap, Turns


class Desk:
    async def file_issue(self, request):
        return {"id": 1}


class Scripted(VoiceLLM):
    """Reply 1 is the script's first entry, and so on; every reply after the script is "EXTRA"."""

    def __init__(self, script, **kw):
        super().__init__(**kw)
        self.script, self.replies = script, 0

    async def _process_context(self, context):
        self.replies += 1
        text, tool = self.script[self.replies - 1] if self.replies <= len(self.script) else ("EXTRA", False)
        if text:
            await self._push_llm_text(text)
        if tool:
            await self.run_function_calls([FunctionCallFromLLM(context=context, tool_call_id=f"t{self.replies}", function_name="file_issue", arguments={"request": "calendar"})])


async def play(script):
    cfg = type("C", (), {"voice_model": "m", "voice_reasoning_effort": "minimal"})()
    llm = Scripted(script, api_key="x", settings=llm_settings(cfg, "sys"))
    holder = {}

    async def push(messages, run_llm):
        await holder["user"].queue_frame(LLMMessagesAppendFrame(messages=messages, run_llm=run_llm))

    turns = Turns(push, reply_grace_s=0.2, audio_grace_s=0.2)
    board = TaskBoard("CA1", lambda r, c: asyncio.sleep(0, "ok"), lambda t: asyncio.sleep(0))
    handlers = make_desk_handlers(Desk(), board, spoke=lambda i: llm.spoke_by_call.get(i, False), owe=turns.tool_result)
    for name, h in handlers.items():
        llm.register_function(name, h, cancel_on_interruption=False)
    user, assistant = LLMContextAggregatorPair(LLMContext(tools=DESK_TOOLS))
    pipeline = Pipeline([user, llm, QuietFilter(), RepeatFilter(), ReplyTap(turns), assistant])
    holder["user"] = user

    first = LLMMessagesAppendFrame(messages=[{"role": "user", "content": "What's on tomorrow?"}], run_llm=True)
    turns.state = turns.state.AWAITING  # the caller's turn just ended: Pipecat replies to it
    await run_test(pipeline, frames_to_send=[first, SleepFrame(sleep=1.0)])
    return llm, turns


async def test_a_reply_that_speaks_and_files_is_the_only_reply():
    llm, turns = await play([("I'm checking your calendar. About 30 seconds.", True)])
    assert llm.replies == 1
    assert turns.stats.unexpected_replies == 0


async def test_a_reply_that_only_files_gets_exactly_one_follow_up():
    llm, turns = await play([("", True), ("I'm checking your calendar.", False)])
    assert llm.replies == 2
    assert turns.stats.unexpected_replies == 0

