import pytest
from voice.config import load_config, normalize_phone

FULL = {
    "OWNER_PHONE": "+1 415-555-0100",
    "TWILIO_ACCOUNT_SID": "AC1",
    "TWILIO_AUTH_TOKEN": "tok",
    "PUBLIC_URL": "https://x.trycloudflare.com/",
    "INSTINCT_CHAT_TOKEN": "chat",
    "OPENROUTER_API_KEY": "or",
    "DEEPGRAM_API_KEY": "dg",
    "CARTESIA_API_KEY": "ca",
    "CARTESIA_VOICE_ID": "v1",
}


def test_normalize_phone_strips_formatting():
    assert normalize_phone("+1 (415) 555-0100") == "+14155550100"
    assert normalize_phone(" +14155550100 ") == "+14155550100"


def test_load_config_defaults_and_normalizes():
    cfg = load_config(FULL)
    assert cfg.owner_phone == "+14155550100"
    assert cfg.public_url == "https://x.trycloudflare.com"
    assert cfg.instinct_url == "http://127.0.0.1:8080"
    assert cfg.voice_model == "openai/gpt-6-luna"
    assert cfg.turn_stop_secs == 1.0
    assert cfg.instinct_timeout_s == 30.0
    assert cfg.voice_reasoning_effort == "minimal"
    assert cfg.owner_timezone == "America/Los_Angeles"


def test_load_config_names_every_missing_key():
    with pytest.raises(RuntimeError) as err:
        load_config({"OWNER_PHONE": "+1"})
    assert "TWILIO_AUTH_TOKEN" in str(err.value)
    assert "CARTESIA_VOICE_ID" in str(err.value)


def test_config_reads_the_transcripts_dir():
    assert load_config(FULL).transcripts_dir is None
    assert load_config({**FULL, "TRANSCRIPTS_DIR": "/data/voice/transcripts"}).transcripts_dir == "/data/voice/transcripts"
