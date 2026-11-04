import os

import uvicorn
from dotenv import load_dotenv
from loguru import logger

from voice.app import create_app
from voice.bot import run_call
from voice.config import Config, load_config
from voice.observability import setup_tracing


def log_path(cfg: Config) -> str | None:
    """Full logs on the volume, next to the call log: Fly keeps only the last few hundred lines."""
    return os.path.join(os.path.dirname(cfg.call_log_path), "logs", "voice.log") if cfg.call_log_path else None


def main() -> None:
    load_dotenv()
    cfg = load_config(os.environ)
    if path := log_path(cfg):
        logger.add(path, level="DEBUG", rotation="20 MB", retention=10, enqueue=True)
    setup_tracing(cfg)  # Langfuse, when configured; per call it only runs with "Help improve Kloru" on
    uvicorn.run(create_app(cfg, run_call), host="127.0.0.1", port=int(os.environ.get("VOICE_PORT", "8765")))


if __name__ == "__main__":
    main()
