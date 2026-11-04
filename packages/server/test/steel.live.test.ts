/**
 * The browser tools on a real Steel session (STEEL_API_KEY, from .kloru.steel.env): a script drives
 * it through the local relay, never sees the key, and a cookie set in one session is there in the
 * next through the person's Steel profile. Skipped without a key; costs a cent or two.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk, type Planner, type WorkerHost } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { browserTools } from "../src/browser-tools.js";

const key = process.env.STEEL_API_KEY;
const EVAN = "+14155550190";

class Host implements WorkerHost {
  run(): Promise<string> {
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

describe.skipIf(!key)("browser tools on Steel", () => {
  it("drives a Steel browser with Playwright, keeps the key from scripts, and keeps sign-ins in the profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "steel-"));
    const desk = new Desk({ root, host: new Host(), planner: { handle: async () => {} } as Planner, ownerPhone: EVAN });
    const logs: string[] = [];
    const opts = { desk, profilesDir: join(root, "browser"), executablePath: "", steelApiKey: key!, log: (m: string) => logs.push(m) };
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Check a page");
    const ctx = { conversationKey: `desk:issue:${issue.id}:engineer` } as never;
    const text = (r: unknown) => JSON.stringify(r);

    const first = browserTools(opts);
    const run = (code: string) => first.tools.find((t) => t.spec.name === "browser_run")!.spec.execute({ code, timeout_seconds: 90 }, ctx);
    try {
      const out = text(await run(`await page.goto("https://example.com"); await context.addCookies([{ name: "kloru", value: "kept", domain: "example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 3600 }]); return { title: await page.title(), env: Object.keys(process.env).filter((k) => /STEEL|KEY/.test(k)) };`));
      expect(out).toContain("Example Domain");
      expect(out).toContain('\\"env\\": []');
      expect(out).not.toContain(key!);
    } finally {
      await first.pool.closeAll();
    }
    expect(logs.join("\n")).toMatch(/Steel session/);

    // A new session for the same person comes back with the cookie, through the profile.
    await new Promise((r) => setTimeout(r, 8_000));
    const second = browserTools(opts);
    try {
      const out = text(await second.tools.find((t) => t.spec.name === "browser_run")!.spec.execute({ code: `return (await context.cookies("https://example.com")).map((c) => c.name + "=" + c.value);`, timeout_seconds: 120 }, ctx));
      expect(out).toContain("kloru=kept");
    } finally {
      await second.pool.closeAll();
    }
  }, 240_000);
});
