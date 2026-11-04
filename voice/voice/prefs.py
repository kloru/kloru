"""Per-person preferences set on the website (packages/web/src/prefs.ts), read at each call.

"Help improve Kloru for everyone" is on unless the caller's number is in transcriptsOff.
Unreadable preferences mean no transcript: when unsure, keep less.
"""
import json
from pathlib import Path

from loguru import logger

from voice.config import normalize_phone


def transcripts_allowed(path: str | Path | None, phone: str) -> bool:
    if path is None:
        return True
    try:
        off = json.loads(Path(path).read_text()).get("transcriptsOff", [])
    except FileNotFoundError:
        return True
    except Exception as err:  # noqa: BLE001
        logger.error(f"prefs: could not read {path}; not keeping a transcript: {err}")
        return False
    return normalize_phone(phone) not in off
