"""The voice side of the desk (packages/desk): this call files issues, posts its turns, and
follows its inbox for merges. Turns go out in order on a background queue so the pipeline
never waits on them, and an issue is filed only after every earlier turn has landed, so the
issue's base commit is the conversation as the caller heard it.
"""
import asyncio
from collections.abc import Awaitable, Callable
from urllib.parse import quote

import httpx
from loguru import logger

from voice.config import Config

WAIT_S = 20


class DeskUnavailable(RuntimeError):
    """The desk never opened this call, so nothing can be filed on it."""


def merge_message(item: dict) -> str:
    """How a merge reads to the talking model: <info> learned, <events> done; draft names a yes."""
    tag = "events" if item.get("kind") == "events" else "info"
    issue = f' issue="{item["issue"]}"' if item.get("issue") is not None else ""
    draft = f' draft="{item["draft"]}"' if item.get("draft") else ""
    return f"<{tag}{issue}{draft}>{item.get('text', '')}</{tag}>"


class DeskClient:
    def __init__(self, cfg: Config, client: httpx.AsyncClient | None = None, retry_s: float = 2.0):
        self._base = f"{cfg.instinct_url}/desk"
        self._headers = {"Authorization": f"Bearer {cfg.instinct_chat_token}"}
        self._client = client or httpx.AsyncClient()
        self._retry_s = retry_s
        self._turns: asyncio.Queue = asyncio.Queue()
        self._sender: asyncio.Task | None = None
        self.call_id: str | None = None
        self.brief = ""
        self._ended = False

    def _call_path(self, suffix: str) -> str:
        return f"{self._base}/calls/{quote(self.call_id or '', safe='')}/{suffix}"

    async def _post(self, url: str, body: dict) -> httpx.Response:
        return await self._client.post(url, json=body, headers=self._headers, timeout=10)

    async def start(self, call_sid: str, phone: str) -> int:
        """Open this call on the desk; returns how many earlier results are waiting for it."""
        res = await self._post(f"{self._base}/calls", {"callSid": call_sid, "phone": phone, "channel": "voice"})
        res.raise_for_status()
        data = res.json()
        self.call_id = data["call"]["id"]
        self.brief = str(data.get("brief") or "")
        self._sender = asyncio.create_task(self._send_turns())
        return int(data.get("pending", 0))

    async def note(self, text: str) -> None:
        """'Remember that…': kept on the call for the memory update after it ends."""
        await self._ready()
        res = await self._post(self._call_path("notes"), {"text": text})
        res.raise_for_status()

    async def _ready(self) -> None:
        """Every earlier turn has landed (or the desk never opened: fail now, never hang)."""
        if self.call_id is None or self._sender is None:
            raise DeskUnavailable("the desk never opened this call")
        await asyncio.wait_for(self._turns.join(), timeout=10)

    def add_turn(self, role: str, text: str, interrupted: bool = False) -> None:
        if self._sender is None:
            return
        body = {"role": role, "text": text}
        if interrupted:
            body["interrupted"] = True
        self._turns.put_nowait(body)

    async def _send_turns(self) -> None:
        while True:
            body = await self._turns.get()
            try:
                await self._post(self._call_path("turns"), body)
            except Exception as err:  # noqa: BLE001 - a lost turn must not end the call
                logger.error(f"desk: could not post a turn: {err!r}")
            finally:
                self._turns.task_done()

    async def file_issue(self, request: str) -> dict:
        await self._ready()
        res = await self._post(self._call_path("issues"), {"request": request})
        res.raise_for_status()
        return res.json()["issue"]

    async def comment(self, issue: int, text: str) -> None:
        await self._ready()
        res = await self._post(f"{self._base}/issues/{issue}/comments", {"call": self.call_id, "text": text})
        res.raise_for_status()

    async def confirm(self, issue: int, draft: str) -> str | None:
        """None when the yes for that draft was recorded, else why not (no yes was due, or the draft changed)."""
        await self._ready()
        res = await self._post(f"{self._base}/issues/{issue}/confirm", {"call": self.call_id, "draft": draft})
        if res.status_code == 409:
            return str(res.json().get("error", "nothing is waiting for a yes"))
        res.raise_for_status()
        return None

    async def ack(self, seq: int) -> None:
        """This call has passed on every merge up to seq; anything later comes back next call."""
        if self.call_id is None:
            return
        try:
            await self._post(self._call_path("ack"), {"seq": seq})
        except Exception as err:  # noqa: BLE001
            logger.warning(f"desk: ack {seq} failed: {err!r}")

    async def list_issues(self) -> list[dict]:
        res = await self._client.get(f"{self._base}/issues", params={"call": self.call_id or ""}, headers=self._headers, timeout=10)
        res.raise_for_status()
        return res.json().get("issues", [])

    async def waiting(self) -> list[dict]:
        """Results already waiting for this call (e.g. from earlier calls), without waiting for more."""
        res = await self._client.get(self._call_path("inbox"), params={"after": 0, "wait": 0}, headers=self._headers, timeout=10)
        res.raise_for_status()
        return res.json().get("items", [])

    async def follow(self, on_merge: Callable[[dict], Awaitable[None]], after: int = 0) -> None:
        """Hand every merge after `after` to on_merge, in order, until the call ends."""
        while not self._ended:
            try:
                res = await self._client.get(self._call_path("inbox"), params={"after": after, "wait": WAIT_S}, headers=self._headers, timeout=WAIT_S + 10)
                res.raise_for_status()
                data = res.json()
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - keep following; the desk keeps the merges
                logger.warning(f"desk: inbox poll failed: {err!r}")
                await asyncio.sleep(self._retry_s)
                continue
            for item in data.get("items", []):
                try:
                    await on_merge(item)
                except asyncio.CancelledError:
                    raise
                except Exception as err:  # noqa: BLE001 - one bad merge must not stop the rest
                    logger.error(f"desk: handling merge {item.get('seq')} failed: {err!r}")
                after = max(after, int(item["seq"]))
            if data.get("ended") and not data.get("items"):
                return

    async def end(self) -> None:
        self._ended = True
        if self.call_id is None:
            await self.close()
            return
        try:
            await asyncio.wait_for(self._turns.join(), timeout=5)
            await self._post(self._call_path("end"), {})
        except Exception as err:  # noqa: BLE001
            logger.error(f"desk: could not end the call: {err!r}")
        await self.close()

    async def close(self) -> None:
        if self._sender:
            self._sender.cancel()
        await self._client.aclose()
