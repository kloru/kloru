"""The one bridge from the voice layer to kloru: POST /chat on a voice conversation."""
import httpx
from loguru import logger

from voice.config import Config

UNREACHABLE = "I couldn't reach your agent just now. Try again in a minute."
STILL_WORKING = "Your agent is still working on that. It should be done shortly."


async def ask_instinct(request: str, conversation_id: str, cfg: Config, client: httpx.AsyncClient | None = None) -> str:
    owned = client is None
    client = client or httpx.AsyncClient()
    try:
        res = await client.post(
            f"{cfg.instinct_url}/chat",
            headers={"Authorization": f"Bearer {cfg.instinct_chat_token}"},
            json={"message": request, "conversation_id": conversation_id, "source": "voice"},
            timeout=cfg.instinct_timeout_s,
        )
    except httpx.TimeoutException:
        logger.warning(f"ask_instinct timed out after {cfg.instinct_timeout_s}s ({conversation_id})")
        return STILL_WORKING
    except httpx.HTTPError as err:
        logger.error(f"ask_instinct failed: {err!r}")
        return UNREACHABLE
    finally:
        if owned:
            await client.aclose()
    if res.status_code != 200:
        logger.error(f"ask_instinct HTTP {res.status_code}: {res.text[:200]}")
        return UNREACHABLE
    text = str(res.json().get("response") or "").strip()
    return text or UNREACHABLE
