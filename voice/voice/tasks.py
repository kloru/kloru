"""Background work for a call: tasks run without blocking the conversation. When a finished
result may be spoken is decided by Turns (voice/turns.py)."""
import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from loguru import logger

Run = Callable[[str, str], Awaitable[str]]


@dataclass
class Task:
    id: str
    request: str
    size: str
    quiet: bool
    status: str = "running"
    result: str = ""


class TaskBoard:
    """Tasks started on one call. Each runs on its own kloru conversation so
    several can run at once; on_done fires when one finishes or fails."""

    def __init__(self, call_sid: str, run: Run, on_done: Callable[[Task], Awaitable[None]], on_start: Callable[[Task], None] | None = None):
        self._call_sid, self._run, self._on_done, self._on_start = call_sid, run, on_done, on_start
        self._tasks: dict[str, Task] = {}
        self._running: set[asyncio.Task] = set()

    def start(self, request: str, size: str = "quick", quiet: bool = False) -> Task:
        task = Task(id=str(len(self._tasks) + 1), request=request, size=size, quiet=quiet)
        self._tasks[task.id] = task
        if self._on_start:
            self._on_start(task)
        job = asyncio.create_task(self._work(task))
        self._running.add(job)
        job.add_done_callback(self._running.discard)
        return task

    async def _work(self, task: Task) -> None:
        try:
            task.result = await self._run(task.request, f"voice:{self._call_sid}:{task.id}")
            task.status = "done"
        except Exception as err:  # reported to the owner, never raised into the call
            logger.error(f"task {task.id} failed: {err!r}")
            task.result, task.status = f"failed: {err}", "failed"
        await self._on_done(task)

    def summary(self) -> list[dict]:
        return [{"task_id": t.id, "request": t.request, "size": t.size, "status": t.status} for t in self._tasks.values() if not t.quiet]

    async def cancel_all(self) -> None:
        for job in list(self._running):
            job.cancel()
