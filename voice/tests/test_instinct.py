import json
import httpx
from voice.config import load_config
from voice.instinct import STILL_WORKING, UNREACHABLE, ask_instinct
from tests.test_config import FULL

CFG = load_config(FULL)


def client_with(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_posts_to_chat_with_token_and_call_conversation():
    seen = {}

    def handler(req: httpx.Request):
        seen["url"] = str(req.url)
        seen["auth"] = req.headers["authorization"]
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"response": "Done, lunch is on your calendar."})

    out = await ask_instinct("add lunch", "voice:CA123", CFG, client_with(handler))
    assert out == "Done, lunch is on your calendar."
    assert seen["url"] == "http://127.0.0.1:8080/chat"
    assert seen["auth"] == "Bearer chat"
    assert seen["body"] == {"message": "add lunch", "conversation_id": "voice:CA123", "source": "voice"}


async def test_unauthorized_is_spoken_not_silent():
    out = await ask_instinct("x", "CA1", CFG, client_with(lambda r: httpx.Response(401, json={"error": "unauthorized"})))
    assert out == UNREACHABLE


async def test_empty_reply_is_spoken():
    out = await ask_instinct("x", "CA1", CFG, client_with(lambda r: httpx.Response(200, json={"response": "  "})))
    assert out == UNREACHABLE


async def test_timeout_says_still_working():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    out = await ask_instinct("x", "CA1", CFG, client_with(handler))
    assert out == STILL_WORKING


async def test_connection_refused_is_unreachable():
    def handler(req):
        raise httpx.ConnectError("refused", request=req)

    assert await ask_instinct("x", "CA1", CFG, client_with(handler)) == UNREACHABLE
