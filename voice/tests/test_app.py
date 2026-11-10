import re
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from twilio.request_validator import RequestValidator

from voice.app import HANGUP_TWIML, REJECT_TWIML, StreamTokens, create_app
from voice.config import load_config
from tests.test_config import FULL

CFG = load_config(FULL)
URL = "https://x.trycloudflare.com/twilio/voice"


async def no_call(ws, stream_sid, call_sid, cfg, caller):
    raise AssertionError("must not run")


def post(client, form, sign_url=URL, token="tok"):
    sig = RequestValidator(token).compute_signature(sign_url, form)
    return client.post("/twilio/voice", data=form, headers={"X-Twilio-Signature": sig})


def test_unsigned_request_is_403():
    c = TestClient(create_app(CFG, no_call))
    assert c.post("/twilio/voice", data={"From": "+14155550100"}).status_code == 403


def test_signature_for_other_url_is_403():
    c = TestClient(create_app(CFG, no_call))
    r = post(c, {"From": "+14155550100", "CallSid": "CA1"}, sign_url="https://old.trycloudflare.com/twilio/voice")
    assert r.status_code == 403


def test_stranger_is_rejected():
    c = TestClient(create_app(CFG, no_call))
    r = post(c, {"From": "+19995550000", "CallSid": "CA1"})
    assert r.status_code == 200
    assert r.text == REJECT_TWIML


def test_owner_gets_stream_with_one_time_token():
    c = TestClient(create_app(CFG, no_call))
    r = post(c, {"From": "+14155550100", "CallSid": "CA1", "StirVerstat": "TN-Validation-Passed-A"})
    assert r.headers["content-type"].startswith("application/xml")
    assert '<Stream url="wss://x.trycloudflare.com/twilio/stream">' in r.text
    assert re.search(r'<Parameter name="token" value="[A-Za-z0-9_-]{20,}"', r.text)


def test_tokens_are_single_use_and_bound_to_call():
    t = StreamTokens()
    tok = t.mint("CA1", "+14155550191")
    assert t.redeem(tok, "CA2") is None
    tok = t.mint("CA1", "+14155550191")
    assert t.redeem(tok, "CA1") == "+14155550191"
    assert t.redeem(tok, "CA1") is None
    assert t.redeem("forged", "CA1") is None


def test_tokens_expire():
    now = [0.0]
    t = StreamTokens(ttl_s=60, clock=lambda: now[0])
    tok = t.mint("CA1", "+14155550100")
    now[0] = 61
    assert t.redeem(tok, "CA1") is None


def test_stream_without_token_is_closed():
    c = TestClient(create_app(CFG, no_call))
    with c.websocket_connect("/twilio/stream") as ws:
        ws.send_json({"event": "connected", "protocol": "Call", "version": "1.0.0"})
        ws.send_json({"event": "start", "start": {"streamSid": "MZ1", "callSid": "CA1", "customParameters": {"token": "forged"}}})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()


def test_stream_with_minted_token_runs_the_call():
    ran = []

    async def record(ws, stream_sid, call_sid, cfg, caller):
        ran.append((stream_sid, call_sid, caller))
        await ws.close()

    c = TestClient(create_app(CFG, record))
    token = re.search(r'name="token" value="([^"]+)"', post(c, {"From": "+14155550100", "CallSid": "CA7", "StirVerstat": "TN-Validation-Passed-A"}).text).group(1)
    with c.websocket_connect("/twilio/stream") as ws:
        ws.send_json({"event": "connected", "protocol": "Call", "version": "1.0.0"})
        ws.send_json({"event": "start", "start": {"streamSid": "MZ7", "callSid": "CA7", "customParameters": {"token": token}}})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()
    assert ran == [("MZ7", "CA7", "+14155550100")]


@pytest.mark.parametrize("verstat", [None, "", "TN-Validation-Passed-B", "TN-Validation-Passed-C", "TN-Validation-Failed-A", "No-TN-Validation", "TN-Validation-Failed"])
def test_owner_number_without_full_attestation_is_hung_up(verstat):
    c = TestClient(create_app(CFG, no_call))
    form = {"From": "+14155550100", "CallSid": "CA1"}
    if verstat is not None:
        form["StirVerstat"] = verstat
    r = post(c, form)
    assert r.status_code == 200
    assert r.text == HANGUP_TWIML
    assert "<Stream" not in r.text


def test_attestation_check_can_be_switched_off():
    cfg = load_config({**FULL, "VOICE_REQUIRE_ATTESTATION": "off"})
    assert not cfg.require_attestation
    r = post(TestClient(create_app(cfg, no_call)), {"From": "+14155550100", "CallSid": "CA1"})
    assert "<Stream" in r.text
    assert load_config(FULL).require_attestation


CLEO = "+14155550191"
A = "TN-Validation-Passed-A"
DESK = replace(CFG, desk_enabled=True)


def members(*allowed):
    asked = []

    async def check(phone):
        asked.append(phone)
        return phone in allowed

    check.asked = asked
    return check


def test_a_family_member_is_admitted_and_runs_as_herself():
    ran = []

    async def record(ws, stream_sid, call_sid, cfg, caller):
        ran.append(caller)
        await ws.close()

    c = TestClient(create_app(DESK, record, members=members(CLEO)))
    r = post(c, {"From": CLEO, "CallSid": "CA9", "StirVerstat": A})
    token = re.search(r'name="token" value="([^"]+)"', r.text).group(1)
    with c.websocket_connect("/twilio/stream") as ws:
        ws.send_json({"event": "connected", "protocol": "Call", "version": "1.0.0"})
        ws.send_json({"event": "start", "start": {"streamSid": "MZ9", "callSid": "CA9", "customParameters": {"token": token}}})
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()
    assert ran == [CLEO]


def test_someone_the_agent_doesnt_know_is_refused():
    r = post(TestClient(create_app(DESK, no_call, members=members(CLEO))), {"From": "+19995550000", "CallSid": "CA1", "StirVerstat": A})
    assert r.text == REJECT_TWIML


def test_a_member_without_full_attestation_is_hung_up():
    r = post(TestClient(create_app(DESK, no_call, members=members(CLEO))), {"From": CLEO, "CallSid": "CA1", "StirVerstat": "TN-Validation-Passed-B"})
    assert r.text == HANGUP_TWIML


def test_the_owner_never_waits_on_the_agent():
    check = members()
    r = post(TestClient(create_app(DESK, no_call, members=check)), {"From": "+14155550100", "CallSid": "CA1", "StirVerstat": A})
    assert "<Stream" in r.text
    assert check.asked == []


def test_when_the_agent_cant_be_reached_only_the_owner_gets_in():
    async def down(phone):
        raise OSError("connection refused")

    c = TestClient(create_app(DESK, no_call, members=down))
    assert post(c, {"From": CLEO, "CallSid": "CA1", "StirVerstat": A}).text == REJECT_TWIML
    assert "<Stream" in post(c, {"From": "+14155550100", "CallSid": "CA2", "StirVerstat": A}).text


def test_without_the_desk_only_the_owner_gets_in():
    # Off, calls go to the owner's own chat surface: a member or the public must never reach it.
    from dataclasses import replace
    cfg = replace(CFG, desk_enabled=False)
    c = TestClient(create_app(cfg, no_call, members=members(CLEO)))
    assert post(c, {"From": CLEO, "CallSid": "CA1", "StirVerstat": A}).text == REJECT_TWIML
    assert "<Stream" in post(c, {"From": "+14155550100", "CallSid": "CA2", "StirVerstat": A}).text
