"""The model an owner picked for a job on the website (Admin → Models), read at each call.

The agent keeps the choices in models.json (packages/server/src/models.ts) and checks each one
against OpenRouter's list as it is made. No file, no pick or an unreadable file: the fallback.
"""
import json
from pathlib import Path

from loguru import logger


def chosen(path: str | Path | None, role: str, fallback: str) -> str:
    if path is None:
        return fallback
    try:
        pick = json.loads(Path(path).read_text()).get(role)
    except FileNotFoundError:
        return fallback
    except Exception as err:  # noqa: BLE001
        logger.error(f"models: could not read {path}; using {fallback}: {err}")
        return fallback
    model = pick.get("model") if isinstance(pick, dict) else None
    return model if isinstance(model, str) and model else fallback
