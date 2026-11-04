import { describe, expect, it } from "vitest";
import type { Principal, RegisteredTool, ToolContext } from "@kloru/core";
import { DesktopdBackend, DesktopdClient, desktopdTools, takeoverInstructions } from "../src/index.js";
import { PNG_B64, bytesResponse, fakeFetch, jsonResponse, unreachableFetch } from "./fake-fetch.js";

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
const ctx: ToolContext = { principal: owner, conversationKey: "chat:test", channel: "chat", now: () => new Date() };

function toolByName(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((t) => t.spec.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function run(tools: RegisteredTool[], name: string, args: unknown) {
  const result = await toolByName(tools, name).spec.execute(args, ctx);
  if (typeof result === "string") throw new Error("expected a block result");
  return result;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

describe("DesktopdClient", () => {
  it("reports health only when desktopd answers ok", async () => {
    const { fetchImpl } = fakeFetch({ "GET /health": () => jsonResponse({ ok: true, mode: "agent", size: [1200, 750] }) });
    const client = new DesktopdClient({ url: "http://127.0.0.1:5911/", fetchImpl });
    expect(client.url).toBe("http://127.0.0.1:5911");
    expect((await client.health())?.mode).toBe("agent");

    const down = new DesktopdClient({ fetchImpl: unreachableFetch() });
    expect(await down.health()).toBeUndefined();

    const notOk = new DesktopdClient({ fetchImpl: fakeFetch({ "GET /health": () => jsonResponse({ ok: false }) }).fetchImpl });
    expect(await notOk.health()).toBeUndefined();
  });

  it("keeps desktopd's error body on HTTP 400 and marks network failures", async () => {
    const { fetchImpl } = fakeFetch({
      "POST /action": () => jsonResponse({ error: "coordinate out of bounds", clamped: [1279, 799] }, 400),
    });
    const client = new DesktopdClient({ fetchImpl });
    const result = await client.action({ action: "left_click", coordinate: [5000, 5000] });
    expect(result.error).toBe("coordinate out of bounds");
    expect(result.clamped).toEqual([1279, 799]);

    const down = await new DesktopdClient({ fetchImpl: unreachableFetch() }).action({ action: "screenshot" });
    expect(down.is_error).toBe(true);
    expect(String(down.error)).toMatch(/unreachable/);
  });
});

describe("desktopd tools", () => {
  it("exposes the computer tool set with computer.use metadata", async () => {
    const backend = new DesktopdBackend({ fetchImpl: unreachableFetch(), agentId: "agt_1" });
    const tools = await backend.tools();
    expect(tools.map((t) => t.spec.name).sort()).toEqual(
      ["computer", "computer_batch", "computer_read_file", "computer_write_file", "request_takeover", "takeover_status"].sort(),
    );
    for (const tool of tools) {
      expect(tool.spec.meta.capabilities).toEqual(["computer.use"]);
      expect(tool.spec.meta.group).toBe("computer");
      expect(tool.spec.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    expect(backend.kind).toBe("desktopd");
    expect(backend.dashboardLink()).toBe("https://maritime.sh/agents/agt_1");
    expect(backend.describe()).toContain("127.0.0.1:5911");
  });

  it("turns an action result into an image block plus JSON text without the image", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "POST /action": () => jsonResponse({ image_b64: PNG_B64, width: 1200, height: 750, scale: 0.9375, frame_id: 7, action: "left_click" }),
    });
    const tools = desktopdTools(new DesktopdClient({ fetchImpl }), { dashboardLink: "https://maritime.sh" });
    const result = await run(tools, "computer", { action: "left_click", coordinate: [10, 20], text: "" });

    expect(calls[0]).toMatchObject({ method: "POST", path: "/action", body: { action: "left_click", coordinate: [10, 20] } });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: "image", data: PNG_B64, mimeType: "image/png" });
    const text = textOf(result);
    expect(text).not.toContain(PNG_B64);
    expect(JSON.parse(text)).toEqual({ action: "left_click", frame_id: 7, height: 750, scale: 0.9375, width: 1200 });
    expect(toolByName(tools, "computer").spec.meta.describe?.({ action: "left_click", coordinate: [10, 20] })).toBe("left_click at 10,20");
  });

  it("uses image/jpeg when desktopd says so and flags errors", async () => {
    const { fetchImpl } = fakeFetch({
      "POST /action": ({ body }) =>
        (body as { action: string }).action === "screenshot"
          ? jsonResponse({ image_b64: PNG_B64, mime: "image/jpeg", width: 1200, height: 750 })
          : jsonResponse({ error: "human_in_control", is_error: true }, 400),
    });
    const tools = desktopdTools(new DesktopdClient({ fetchImpl }), { dashboardLink: "https://maritime.sh" });
    const shot = await run(tools, "computer", { action: "screenshot", format: "jpeg" });
    expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });

    const blocked = await run(tools, "computer", { action: "type", text: "hi" });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain("human_in_control");
  });

  it("prefixes batch results with their index and reports any failure", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "POST /batch": () =>
        jsonResponse({
          results: [
            { action: "left_click", no_screenshot: true },
            { error: "Not executed: an earlier computer action in this turn failed.", is_error: true },
          ],
        }),
    });
    const tools = desktopdTools(new DesktopdClient({ fetchImpl }), { dashboardLink: "https://maritime.sh" });
    const result = await run(tools, "computer_batch", {
      actions: [{ action: "left_click", coordinate: [1, 2] }, { action: "type", text: "x" }],
    });
    expect((calls[0]?.body as { actions: unknown[] }).actions).toHaveLength(2);
    expect(result.isError).toBe(true);
    const texts = result.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
    expect(texts[0]).toMatch(/^\[0\] /);
    expect(texts[1]).toMatch(/^\[1\] .*Not executed/);
  });

  it("request_takeover flips the desktop and returns dashboard instructions without blocking", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "POST /takeover": () => jsonResponse({ ok: true, mode: "human", reason: "log in to Gmail", takeover_seq: 3 }),
    });
    const tools = desktopdTools(new DesktopdClient({ fetchImpl }), { dashboardLink: "https://maritime.sh/agents/agt_1" });
    const result = await run(tools, "request_takeover", { reason: "log in to Gmail" });
    expect(calls.map((c) => c.path)).toEqual(["/takeover"]);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result)) as { mode: string; instructions: string };
    expect(parsed.mode).toBe("human");
    expect(parsed.instructions).toContain("https://maritime.sh/agents/agt_1");
    expect(parsed.instructions).toContain("log in to Gmail");
    expect(parsed.instructions).toContain("Done");
    expect(takeoverInstructions("x", "https://d")).toContain("takeover_status");
  });

  it("request_takeover with wait long-polls and returns the completion screenshot", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "POST /takeover": () => jsonResponse({ ok: true, mode: "human" }),
      "GET /takeover/wait": () =>
        jsonResponse({ timeout: false, mode: "agent", success: true, note: "done", screenshot: { image_b64: PNG_B64, width: 1200, height: 750 } }),
    });
    const tools = desktopdTools(new DesktopdClient({ fetchImpl }), { dashboardLink: "https://maritime.sh" });
    const result = await run(tools, "request_takeover", { reason: "2FA", wait: true, timeout: 5000 });
    // desktopd caps the wait at 600 s; the client must not ask for more.
    expect(calls[1]?.path).toBe("/takeover/wait?timeout=600");
    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: "image", data: PNG_B64 });
    const parsed = JSON.parse(textOf(result)) as { success: boolean; screenshot: Record<string, unknown> };
    expect(parsed.success).toBe(true);
    expect(parsed.screenshot).toEqual({ height: 750, width: 1200 });
  });

  it("request_takeover with wait reports timeouts and owner failure as errors", async () => {
    const timedOut = fakeFetch({
      "POST /takeover": () => jsonResponse({ ok: true, mode: "human" }),
      "GET /takeover/wait": () => jsonResponse({ timeout: true, mode: "human" }),
    });
    let tools = desktopdTools(new DesktopdClient({ fetchImpl: timedOut.fetchImpl }), { dashboardLink: "https://maritime.sh" });
    let result = await run(tools, "request_takeover", { reason: "pay", wait: true, timeout: 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timed out");

    const failed = fakeFetch({
      "POST /takeover": () => jsonResponse({ ok: true, mode: "human" }),
      "GET /takeover/wait": () => jsonResponse({ timeout: false, mode: "agent", success: false, note: "card declined", screenshot: null }),
    });
    tools = desktopdTools(new DesktopdClient({ fetchImpl: failed.fetchImpl }), { dashboardLink: "https://maritime.sh" });
    result = await run(tools, "request_takeover", { reason: "pay", wait: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("card declined");
    expect(textOf(result)).toContain("Do not retry");
  });

  it("takeover_status returns the mode", async () => {
    const { fetchImpl } = fakeFetch({ "GET /mode": () => jsonResponse({ mode: "human", reason: "login", since: 1, takeover_seq: 2 }) });
    const tools = desktopdTools(new DesktopdClient({ fetchImpl }), { dashboardLink: "https://maritime.sh" });
    const result = await run(tools, "takeover_status", {});
    expect(JSON.parse(textOf(result))).toMatchObject({ mode: "human", reason: "login" });
  });

  it("reads UTF-8 files as text and binary files as base64", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "GET /fs/read": ({ path }) =>
        path.includes("notes.txt")
          ? bytesResponse(new TextEncoder().encode("hello\nworld"))
          : path.includes("missing")
            ? jsonResponse({ error: "not found" }, 404)
            : bytesResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])),
    });
    const tools = desktopdTools(new DesktopdClient({ fetchImpl }), { dashboardLink: "https://maritime.sh" });

    const text = await run(tools, "computer_read_file", { path: "/data/notes.txt" });
    expect(calls[0]?.path).toBe("/fs/read?path=%2Fdata%2Fnotes.txt");
    expect(textOf(text)).toBe("hello\nworld");

    const binary = await run(tools, "computer_read_file", { path: "/data/pic.png" });
    const parsed = JSON.parse(textOf(binary)) as { encoding: string; bytes: number; data: string };
    expect(parsed.encoding).toBe("base64");
    expect(parsed.bytes).toBe(6);
    expect(Buffer.from(parsed.data, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

    const missing = await run(tools, "computer_read_file", { path: "/data/missing" });
    expect(missing.isError).toBe(true);
  });

  it("writes files as data_b64 and refuses anything over 8 MiB without a request", async () => {
    const { fetchImpl, calls } = fakeFetch({ "POST /fs/write": () => jsonResponse({ ok: true }) });
    const tools = desktopdTools(new DesktopdClient({ fetchImpl }), { dashboardLink: "https://maritime.sh" });

    const result = await run(tools, "computer_write_file", { path: "/data/out.txt", content: "héllo" });
    const body = calls[0]?.body as { path: string; data_b64: string };
    expect(body.path).toBe("/data/out.txt");
    expect(Buffer.from(body.data_b64, "base64").toString("utf8")).toBe("héllo");
    expect(JSON.parse(textOf(result))).toEqual({ bytes: 6, ok: true, path: "/data/out.txt" });

    const b64 = await run(tools, "computer_write_file", { path: "/data/a.bin", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" });
    expect(JSON.parse(textOf(b64)).bytes).toBe(3);

    const tooBig = await run(tools, "computer_write_file", { path: "/data/big", content: "x".repeat(8 * 1024 * 1024 + 1) });
    expect(tooBig.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
