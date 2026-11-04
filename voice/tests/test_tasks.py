import asyncio

from voice.tasks import TaskBoard


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def test_start_returns_before_the_work_finishes():
    gate = asyncio.Event()
    calls = []

    async def run(request, conversation_id):
        calls.append((request, conversation_id))
        await gate.wait()
        return "done"

    finished = []

    async def on_done(task):
        finished.append(task)

    board = TaskBoard("CA1", run, on_done)
    task = board.start("check calendar")
    assert task.status == "running"
    await settle()
    assert calls == [("check calendar", "voice:CA1:1")]
    assert finished == []
    gate.set()
    await settle()
    assert finished[0].result == "done" and finished[0].status == "done"


async def test_each_task_gets_its_own_conversation():
    seen = []

    async def run(request, conversation_id):
        seen.append(conversation_id)
        return "ok"

    async def on_done(task):
        pass

    board = TaskBoard("CA1", run, on_done)
    board.start("a")
    board.start("b")
    await settle()
    assert seen == ["voice:CA1:1", "voice:CA1:2"]


async def test_failure_is_reported_not_raised():
    async def run(request, conversation_id):
        raise RuntimeError("boom")

    finished = []

    async def on_done(task):
        finished.append(task)

    board = TaskBoard("CA1", run, on_done)
    board.start("x")
    await settle()
    assert finished[0].status == "failed"
    assert "boom" in finished[0].result


async def test_summary_lists_tasks():
    async def run(request, conversation_id):
        await asyncio.sleep(10)

    async def on_done(task):
        pass

    board = TaskBoard("CA1", run, on_done)
    board.start("inbox cleanup", size="long")
    assert board.summary() == [{"task_id": "1", "request": "inbox cleanup", "size": "long", "status": "running"}]
    await board.cancel_all()


async def test_on_start_sees_every_task_including_quiet_ones():
    started = []

    async def run(request, conversation_id):
        return "ok"

    async def on_done(task):
        pass

    board = TaskBoard("CA1", run, on_done, on_start=lambda t: started.append((t.id, t.request, t.size, t.quiet)))
    board.start("check calendar", size="long")
    board.start("save a fact", quiet=True)
    assert started == [("1", "check calendar", "long", False), ("2", "save a fact", "quick", True)]
    await settle()
