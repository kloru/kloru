import json

from voice.config import load_config
from voice.prefs import transcripts_allowed
from tests.test_config import FULL


def test_on_unless_the_number_turned_it_off(tmp_path):
    path = tmp_path / "prefs.json"
    assert transcripts_allowed(path, "+14155550190")
    path.write_text(json.dumps({"version": 1, "transcriptsOff": ["+14155550190"]}))
    assert not transcripts_allowed(path, "+1 (415) 555-0190")
    assert transcripts_allowed(path, "+14155550100")


def test_unreadable_preferences_mean_no_transcript(tmp_path):
    path = tmp_path / "prefs.json"
    path.write_text("{not json")
    assert not transcripts_allowed(path, "+14155550190")


def test_no_prefs_path_means_on():
    assert transcripts_allowed(None, "+14155550190")


def test_config_reads_the_prefs_path():
    assert load_config(FULL).prefs_path is None
    assert load_config({**FULL, "VOICE_PREFS_PATH": "/data/voice/prefs.json"}).prefs_path == "/data/voice/prefs.json"
