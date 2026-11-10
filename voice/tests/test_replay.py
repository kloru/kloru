"""Replays through build_call, the phone call's own wiring, with a scripted model."""
from dataclasses import replace

from pipecat.services.llm_service import FunctionCallFromLLM

from tests.test_bot import CFG
from voice.bot import VoiceLLM, llm_settings
from voice.replay import Result, Say, Script, replay


class Scripted(VoiceLLM):
    """Answers by what it was just given: the greeting, a caller line, or a result."""

    def __init__(self, files_with_words: bool = True, **kw):
        super().__init__(**kw)
        self.files_with_words = files_with_words
        self.replies = 0

    async def _process_context(self, context):
        self.replies += 1
        last = context.get_messages()[-1]
        content = str(last.get("content") or "")
        if last.get("role") == "user":
            if self.files_with_words:
                await self._push_llm_text("I'm checking your calendar for tomorrow. About 30 seconds.")
            await self.run_function_calls([FunctionCallFromLLM(context=context, tool_call_id=f"t{self.replies}", function_name="file_issue", arguments={"request": content})])
        elif "<info" in content:
            await self._push_llm_text("Tomorrow you have drop-off at 8.")
        elif "Greet" in content:
            await self._push_llm_text("Hi Ezra, what's on your mind?")
        elif "file_issue" in str(context.get_messages()[-2:]) or last.get("role") == "tool":
            await self._push_llm_text("I'm on it.")
        else:
            await self._push_llm_text("[quiet]")


def scripted(**kw) -> Scripted:
    cfg = type("C", (), {"voice_model": "m", "voice_reasoning_effort": "minimal"})()
    return Scripted(api_key="x", settings=llm_settings(cfg, "sys"), **kw)


SCRIPT = Script("t", caller=[Say("What's on tomorrow?")], results=[Result("Drop-off at 8.", after_s=1.5)], linger_s=1.0)


async def test_a_replayed_call_passes_its_checks_and_says_each_thing_once():
    llm = scripted()
    o = await replay(SCRIPT, replace(CFG, desk_enabled=True), llm, speed=4.0)
    kloru = [l for l in o.lines if l.startswith("Kloru:")]
    assert o.failures == []
    assert sum("checking your calendar" in l for l in kloru) == 1
    assert any("drop-off at 8" in l for l in kloru)
    assert llm.replies == 3  # the greeting, the request, the result: nothing else


async def test_a_silent_filing_in_a_replay_gets_one_follow_up():
    llm = scripted(files_with_words=False)
    o = await replay(SCRIPT, replace(CFG, desk_enabled=True), llm, speed=4.0)
    assert o.failures == []
    assert llm.replies == 4  # the greeting, the silent filing, its one follow-up, the result


async def test_a_members_call_opens_on_the_desk_as_her_not_the_owner():
    o = await replay(SCRIPT, replace(CFG, desk_enabled=True), scripted(), speed=4.0, caller="+14155550191")
    assert o.caller == "+14155550191"
    o = await replay(SCRIPT, replace(CFG, desk_enabled=True), scripted(), speed=4.0)
    assert o.caller == CFG.owner_phone
