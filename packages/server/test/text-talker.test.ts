import { describe, expect, it } from "vitest";
import { textTalker, type TalkerTools } from "../src/text-talker.js";

/** A fake OpenRouter: each call returns the next scripted message. */
function model(script: Array<{ content?: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> }>) {
  const bodies: any[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const m = script[Math.min(i++, script.length - 1)]!;
    const message = { content: m.content ?? "", ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t, n) => ({ id: `t${n}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

function tools() {
  const calls: string[] = [];
  const t: TalkerTools = {
    fileIssue: (r) => (calls.push(`file ${r}`), "Filed #7."),
    updateIssue: (n, x) => (calls.push(`update ${n} ${x}`), "Updated."),
    confirm: (n, d) => (calls.push(`confirm ${n} ${d}`), "Confirmed."),
    remember: (x) => (calls.push(`remember ${x}`), "Noted."),
    remind: (x, at) => (calls.push(`remind ${at} ${x}`), `Set for ${at}.`),
    outboxList: () => (calls.push("list"), "- o_1 [reminder, goes Wed 9:00 AM] Reminder: call Dr. Lee."),
    outboxCancel: (id) => (calls.push(`cancel ${id}`), "Cancelled; it won't be sent."),
  };
  return { t, calls };
}

const NOW = new Date("2026-10-30T16:00:00Z");

describe("the text talker", () => {
  it("files the request, then replies in a few words", async () => {
    const m = model([{ tool_calls: [{ name: "file_issue", args: { request: "What's on my calendar tomorrow?" } }] }, { content: "Checking your calendar now; a few seconds." }]);
    const { t, calls } = tools();
    const reply = await textTalker({ apiKey: "k", fetchImpl: m.fetchImpl, now: () => NOW })({ brief: "Caller: Ezra", channel: "imessage", thread: [{ role: "caller", text: "What's on my calendar tomorrow?" }], tools: t, timezone: "America/Los_Angeles" });
    expect(calls).toEqual(["file What's on my calendar tomorrow?"]);
    expect(reply).toBe("Checking your calendar now; a few seconds.");
    const second = m.bodies[1];
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "t0", content: "Filed #7." });
    expect(m.bodies[0].messages[0].content).toContain("Caller: Ezra");
    expect(m.bodies[0].tools.map((x: any) => x.function.name)).toEqual(["file_issue", "update_issue", "confirm", "remember", "remind", "outbox_list", "outbox_cancel"]);
  });

  it("a reminder whose words are known is set with remind, and a waiting one can be listed and stopped", async () => {
    const m = model([
      { tool_calls: [{ name: "remind", args: { text: "Reminder: call Dr. Lee.", at: "2026-10-31T09:00" } }] },
      { tool_calls: [{ name: "outbox_list", args: {} }] },
      { tool_calls: [{ name: "outbox_cancel", args: { id: "o_1" } }] },
      { content: "Done." },
    ]);
    const { t, calls } = tools();
    await textTalker({ apiKey: "k", fetchImpl: m.fetchImpl, now: () => NOW })({ brief: "", channel: "imessage", thread: [{ role: "caller", text: "Remind me at 9 tomorrow to call Dr. Lee" }], tools: t, timezone: "America/Los_Angeles" });
    expect(calls).toEqual(["remind 2026-10-31T09:00 Reminder: call Dr. Lee.", "list", "cancel o_1"]);
    expect(m.bodies[1].messages.at(-1)).toMatchObject({ role: "tool", content: "Set for 2026-10-31T09:00." });
  });

  it("a result that lands becomes one message", async () => {
    const m = model([{ content: "Tomorrow: drop-off at 8, dentist at 3." }]);
    const { t } = tools();
    const reply = await textTalker({ apiKey: "k", fetchImpl: m.fetchImpl, now: () => NOW })({ brief: "", channel: "imessage", thread: [{ role: "caller", text: "What's on tomorrow?" }, { role: "kloru", text: "Checking." }], event: "<info>Tomorrow: drop-off 8 AM; Nora dentist 3 PM.</info>", tools: t, timezone: "America/Los_Angeles" });
    expect(reply).toBe("Tomorrow: drop-off at 8, dentist at 3.");
    expect(m.bodies[0].messages.at(-1).content).toContain("<info>Tomorrow");
  });

  it("nothing new to say is an empty reply", async () => {
    const m = model([{ content: "[quiet]" }]);
    const { t } = tools();
    expect(await textTalker({ apiKey: "k", fetchImpl: m.fetchImpl, now: () => NOW })({ brief: "", channel: "email", thread: [{ role: "caller", text: "thanks!" }], tools: t, timezone: "America/Los_Angeles" })).toBe("");
  });

  it("a reaction marker copied from an old thread never reaches them (Nov 2)", async () => {
    const m = model([{ content: "[reacted eyes] I'm on it." }]);
    const { t } = tools();
    expect(await textTalker({ apiKey: "k", fetchImpl: m.fetchImpl, now: () => NOW })({ brief: "", channel: "imessage", thread: [{ role: "caller", text: "Are you suggesting more?" }], tools: t, timezone: "America/Los_Angeles" })).toBe("I'm on it.");
    const n = model([{ content: "[reacted eyes]" }]);
    expect(await textTalker({ apiKey: "k", fetchImpl: n.fetchImpl, now: () => NOW })({ brief: "", channel: "imessage", thread: [{ role: "caller", text: "Are you suggesting more?" }], tools: t, timezone: "America/Los_Angeles" })).toBe("");
  });

  it("stops after a few rounds of tools, whatever the model does", async () => {
    const m = model([{ tool_calls: [{ name: "remember", args: { text: "x" } }] }]);
    const { t, calls } = tools();
    await textTalker({ apiKey: "k", fetchImpl: m.fetchImpl, now: () => NOW })({ brief: "", channel: "imessage", thread: [{ role: "caller", text: "hi" }], tools: t, timezone: "America/Los_Angeles" });
    expect(calls.length).toBeLessThanOrEqual(4);
  });
});
