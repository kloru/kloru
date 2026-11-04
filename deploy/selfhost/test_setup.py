"""Run: cd voice && uv run pytest ../deploy/selfhost/test_setup.py -q"""
import base64
import importlib.util
import sys
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("setup", Path(__file__).with_name("setup.py"))
setup = importlib.util.module_from_spec(spec)
sys.modules["kloru_setup"] = setup
spec.loader.exec_module(setup)

KEYS = {k: f"v-{k.lower()}" for k in setup.REQUIRED} | {"STEEL_API_KEY": "steel"}
OWNER = setup.Owner(name="Sam Lee", phone="(415) 555-0100", email="sam@example.com")


def test_a_domain_is_checked_and_names_the_app_and_identity():
    assert setup.check_domain("https://Kloru.Example.com/") == "kloru.example.com"
    with pytest.raises(SystemExit):
        setup.check_domain("not a domain")
    assert setup.default_app("kloru.example.com") == "kloru-example"
    assert setup.default_app("leefamily.net") == "kloru-leefamily"
    assert setup.handle_for("kloru-example") == "example-kloru"


def test_secrets_are_yours_only_and_never_blank():
    s = setup.secrets_for(OWNER, KEYS, setup.generate_secrets(), "example-kloru")
    assert s["OWNER_PHONE"] == s["KLORU_ADMIN_PHONES"] == "+14155550100"
    assert s["VOICE_OPENROUTER_API_KEY"] == s["OPENROUTER_API_KEY"] == "v-openrouter_api_key"
    assert s["INKBOX_AGENT_HANDLE"] == "example-kloru" and s["STEEL_API_KEY"] == "steel"
    assert "RESEND_API_KEY" not in s and all(s.values())
    assert len(base64.b64decode(s["KLORU_VAULT_KEY"])) == 32


def test_the_fly_config_is_filled_in_for_your_domain():
    toml = setup.render_fly_toml("kloru-example", "sjc", "kloru.example.com", "+16505550100", "Sam Lee", "sam@example.com")
    assert 'app = "kloru-example"' in toml and 'primary_region = "sjc"' in toml
    assert 'KLORU_PUBLIC_URL = "https://kloru.example.com"' in toml and 'PUBLIC_URL = "https://kloru.example.com"' in toml
    assert 'LINK_REDIRECT_URI = "https://kloru.example.com/oauth/link/callback"' in toml
    assert 'KLORU_TEXT_NUMBER = "+16505550100"' in toml and 'KLORU_CONTACT_EMAIL = "sam@example.com"' in toml
    assert "kloru.com" not in toml.replace("kloru.example.com", "") and "{" not in toml


def test_a_rerun_adds_new_secrets_but_never_changes_the_backup_or_vault_key(tmp_path, monkeypatch):
    monkeypatch.setattr(setup, "generated_path", lambda app: tmp_path / f"{app}.env")
    (tmp_path / "kloru-example.env").write_text("BACKUP_KEY=keep-me\nKLORU_VAULT_KEY=keep-vault\n")
    got = setup.load_or_generate("kloru-example")
    assert got["BACKUP_KEY"] == "keep-me" and got["KLORU_VAULT_KEY"] == "keep-vault" and got["OWNER_API_SECRET"]
    assert setup.load_or_generate("kloru-example") == got


def test_preflight_says_what_to_do(monkeypatch):
    monkeypatch.setattr(setup.shutil, "which", lambda _: None)
    monkeypatch.setattr(setup, "http", lambda *a, **k: (200, {}))
    problems = setup.preflight({"OPENROUTER_API_KEY": "x"})
    assert any("Install the Fly CLI" in p for p in problems)
    assert any("missing TWILIO_ACCOUNT_SID" in p for p in problems)
