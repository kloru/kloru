"""Environment for the voice service. Fails fast and names every missing key."""
import re
from collections.abc import Mapping
from dataclasses import dataclass

REQUIRED = (
    "OWNER_PHONE", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "PUBLIC_URL",
    "INSTINCT_CHAT_TOKEN", "OPENROUTER_API_KEY", "DEEPGRAM_API_KEY",
    "CARTESIA_API_KEY", "CARTESIA_VOICE_ID",
)


def normalize_phone(s: str) -> str:
    """E.164 without formatting: keep a leading + and the digits."""
    s = s.strip()
    return ("+" if s.startswith("+") else "") + re.sub(r"\D", "", s)


@dataclass(frozen=True)
class Config:
    owner_phone: str
    twilio_account_sid: str
    twilio_auth_token: str
    public_url: str
    instinct_url: str
    instinct_chat_token: str
    instinct_timeout_s: float
    openrouter_api_key: str
    voice_model: str
    deepgram_api_key: str
    cartesia_api_key: str
    cartesia_voice_id: str
    turn_stop_secs: float
    voice_reasoning_effort: str
    owner_timezone: str
    require_attestation: bool
    call_log_path: str | None
    transcripts_dir: str | None
    prefs_path: str | None
    desk_enabled: bool
    langfuse: tuple[str, str, str] | None
    judge_model: str
    stt: str
    flux_eot_timeout_ms: int
    # Start the reply at Flux's predicted end of turn; it's discarded if the caller keeps talking.
    eager_eot: bool
    vad_min_volume: float


def _langfuse(env: Mapping[str, str]) -> tuple[str, str, str] | None:
    keys = [env.get(k, "").strip().strip('"') for k in ("LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")]
    return (keys[0] or "https://us.cloud.langfuse.com", keys[1], keys[2]) if keys[1] and keys[2] else None


def load_config(env: Mapping[str, str]) -> Config:
    missing = [k for k in REQUIRED if not env.get(k)]
    if missing:
        raise RuntimeError(f"voice: missing env {', '.join(missing)}")
    return Config(
        owner_phone=normalize_phone(env["OWNER_PHONE"]),
        twilio_account_sid=env["TWILIO_ACCOUNT_SID"],
        twilio_auth_token=env["TWILIO_AUTH_TOKEN"],
        public_url=env["PUBLIC_URL"].rstrip("/"),
        instinct_url=env.get("INSTINCT_URL", "http://127.0.0.1:8080").rstrip("/"),
        instinct_chat_token=env["INSTINCT_CHAT_TOKEN"],
        instinct_timeout_s=float(env.get("INSTINCT_TIMEOUT_S", "30")),
        openrouter_api_key=env["OPENROUTER_API_KEY"],
        voice_model=env.get("VOICE_MODEL", "openai/gpt-6-luna"),
        deepgram_api_key=env["DEEPGRAM_API_KEY"],
        cartesia_api_key=env["CARTESIA_API_KEY"],
        cartesia_voice_id=env["CARTESIA_VOICE_ID"],
        turn_stop_secs=float(env.get("TURN_STOP_SECS", "1.0")),
        voice_reasoning_effort=env.get("VOICE_REASONING_EFFORT", "minimal"),
        owner_timezone=env.get("OWNER_TIMEZONE", "America/Los_Angeles"),
        # Off only to get back in if the owner's carrier stops attesting calls.
        call_log_path=env.get("CALL_LOG_PATH", "").strip() or None,
        transcripts_dir=env.get("TRANSCRIPTS_DIR", "").strip() or None,
        prefs_path=env.get("VOICE_PREFS_PATH", "").strip() or None,
        # The desk (issues, PM, engineers, ops) instead of one-sentence tasks. Off: today's path.
        desk_enabled=env.get("VOICE_DESK", "off").strip().lower() in ("on", "true", "1", "yes"),
        langfuse=_langfuse(env),
        judge_model=env.get("KLORU_JUDGE_MODEL", "openai/gpt-6.1-terra"),
        # flux: Deepgram Flux decides turns from the caller's words. nova: Nova + local VAD/smart-turn.
        stt="nova" if env.get("VOICE_STT", "flux").strip().lower() == "nova" else "flux",
        flux_eot_timeout_ms=int(env.get("FLUX_EOT_TIMEOUT_MS", "3000")),
        eager_eot=env.get("VOICE_EAGER_EOT", "off").strip().lower() in ("on", "true", "1", "yes"),
        vad_min_volume=float(env.get("VAD_MIN_VOLUME", "0.7")),
        require_attestation=env.get("VOICE_REQUIRE_ATTESTATION", "on").strip().lower() not in ("off", "false", "0", "no"),
    )
