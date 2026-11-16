import json

from voice.config import load_config
from voice.models import chosen
from tests.test_config import FULL


def test_the_pick_for_a_job_wins_over_the_fallback(tmp_path):
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"voice": {"model": "openai/gpt-6.1-terra", "by": "Evan", "at": "2026-11-16T00:00:00Z"}}))
    assert chosen(path, "voice", "openai/gpt-6-luna") == "openai/gpt-6.1-terra"
    assert chosen(path, "call-judge", "openai/gpt-6.1-terra") == "openai/gpt-6.1-terra"


def test_no_file_or_an_unreadable_one_means_the_fallback(tmp_path):
    assert chosen(None, "voice", "openai/gpt-6-luna") == "openai/gpt-6-luna"
    assert chosen(tmp_path / "models.json", "voice", "openai/gpt-6-luna") == "openai/gpt-6-luna"
    (tmp_path / "models.json").write_text("{not json")
    assert chosen(tmp_path / "models.json", "voice", "openai/gpt-6-luna") == "openai/gpt-6-luna"


def test_config_reads_the_models_path():
    assert load_config(FULL).models_path is None
    assert load_config({**FULL, "KLORU_MODELS_PATH": "/data/instinct/models.json"}).models_path == "/data/instinct/models.json"
