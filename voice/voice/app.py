"""HTTP surface: Twilio's signed voice webhook and the media stream WebSocket."""
import secrets
import time
from urllib.parse import quote
from collections.abc import Awaitable, Callable
from xml.sax.saxutils import quoteattr

import httpx
from fastapi import FastAPI, Request, Response, WebSocket
from loguru import logger
from pipecat.runner.utils import parse_telephony_websocket
from twilio.request_validator import RequestValidator

from voice.calllog import CallLog
from voice.config import Config, normalize_phone
from voice.transcript import prune_transcripts

REJECT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this line is private.</Say><Hangup/></Response>'

HANGUP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'

# STIR/SHAKEN: Twilio passes the originating carrier's verdict on the caller ID. Only "A"
# (the carrier knows the customer and that they may use this number) is hard to spoof.
FULL_ATTESTATION = "TN-Validation-Passed-A"

RunCall = Callable[[WebSocket, str, str, Config, str], Awaitable[None]]
IsMember = Callable[[str], Awaitable[bool]]


def agent_members(cfg: Config) -> IsMember:
    """Asks the agent whether a number belongs to a family member (GET /desk/callers/<phone>)."""

    async def check(phone: str) -> bool:
        async with httpx.AsyncClient() as c:
            r = await c.get(f"{cfg.instinct_url}/desk/callers/{quote(phone, safe='')}", headers={"Authorization": f"Bearer {cfg.instinct_chat_token}"}, timeout=3)
            r.raise_for_status()
            return bool(r.json().get("allowed"))

    return check


class StreamTokens:
    """One-time tokens: only a call the signed webhook accepted may open a stream."""

    def __init__(self, ttl_s: float = 60, clock: Callable[[], float] = time.monotonic):
        self._ttl, self._clock, self._live = ttl_s, clock, {}

    def mint(self, call_sid: str, caller: str) -> str:
        token = secrets.token_urlsafe(24)
        self._live[token] = (call_sid, caller, self._clock() + self._ttl)
        return token

    def redeem(self, token: str, call_sid: str) -> str | None:
        """The caller the webhook admitted, or None for a forged, reused, stale or other call's token."""
        entry = self._live.pop(token, None)
        if entry is None or entry[0] != call_sid or self._clock() > entry[2]:
            return None
        return entry[1]


def xml(body: str) -> Response:
    return Response(content=body, media_type="application/xml")


def create_app(cfg: Config, run_call: RunCall, call_log: CallLog | None = None, members: IsMember | None = None) -> FastAPI:
    app = FastAPI()
    is_member = members or agent_members(cfg)

    async def allowed(caller: str) -> bool:
        """The owner always, without waiting on the agent; anyone else only if the agent says they're family."""
        if caller == cfg.owner_phone:
            return True
        if not cfg.desk_enabled:  # without the desk, a call reaches the owner's own chat: owner only
            return False
        try:
            return await is_member(caller)
        except Exception as err:  # noqa: BLE001 - fail closed for everyone but the owner
            logger.error(f"can't check caller {caller}: {err!r}")
            return False
    if call_log is None and cfg.call_log_path:
        call_log = CallLog(cfg.call_log_path)
    if cfg.transcripts_dir:
        prune_transcripts(cfg.transcripts_dir)

    def note(form: dict, outcome: str, **extra: str) -> None:
        if call_log:
            call_log.record({"call_sid": form.get("CallSid", ""), "from": normalize_phone(form.get("From", "")), "verstat": form.get("StirVerstat", ""), "outcome": outcome, **extra})
    validator = RequestValidator(cfg.twilio_auth_token)
    tokens = StreamTokens()
    voice_url = f"{cfg.public_url}/twilio/voice"
    stream_url = cfg.public_url.replace("https://", "wss://", 1) + "/twilio/stream"

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.post("/twilio/voice")
    async def voice(request: Request):
        form = {k: str(v) for k, v in (await request.form()).items()}
        if not validator.validate(voice_url, form, request.headers.get("X-Twilio-Signature", "")):
            logger.warning(f"rejected unsigned or mis-signed webhook; signed URL must be {voice_url} (check PUBLIC_URL)")
            note(form, "bad_signature", ip=request.headers.get("Fly-Client-IP") or (request.client.host if request.client else ""))
            return Response(status_code=403)
        caller = normalize_phone(form.get("From", ""))
        if not await allowed(caller):
            logger.info(f"refused call from {caller}")
            note(form, "refused_unknown")
            return xml(REJECT_TWIML)
        verstat = form.get("StirVerstat", "")
        if cfg.require_attestation and verstat != FULL_ATTESTATION:
            logger.warning(f"hung up on family-number call {form.get('CallSid', '')}: caller ID attestation {verstat or 'missing'}")
            note(form, "hung_up_attestation")
            return xml(HANGUP_TWIML)
        note(form, "connected")
        token = tokens.mint(form.get("CallSid", ""), caller)
        return xml(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>'
            f'<Stream url={quoteattr(stream_url)}><Parameter name="token" value={quoteattr(token)}/></Stream>'
            "</Connect></Response>"
        )

    @app.websocket("/twilio/stream")
    async def stream(ws: WebSocket):
        await ws.accept()
        _, call = await parse_telephony_websocket(ws)
        caller = tokens.redeem(str(call.body.get("token", "")), call.call_id or "")
        if caller is None:
            logger.warning(f"stream without a valid token for {call.call_id}; closing")
            await ws.close(code=1008)
            return
        await run_call(ws, call.stream_id, call.call_id, cfg, caller)

    return app
