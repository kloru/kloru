import { describe, expect, it } from "vitest";
import { appsNotConfiguredTool, setupSummaryFor } from "../src/setup-summary.js";
import type { ToolContext } from "@kloru/core";

describe("setup summary", () => {
  it("says plainly what is missing", () => {
    const text = setupSummaryFor({});
    expect(text).toContain("Messaging: no Inkbox identity");
    expect(text).toContain("Apps: not set up");
    expect(text).toContain("COMPOSIO_API_KEY");
    expect(text).toContain("Computer: none");
    expect(text).toContain("Payments: not set up");
  });
  it("describes a fully wired agent", () => {
    const text = setupSummaryFor({ inkbox: { handle: "maria-instinct" }, computerKind: "desktopd", apps: { connected: ["gmail"], anyApp: true, toolkits: [] }, wallet: { connected: true } });
    expect(text).toContain("@maria-instinct");
    expect(text).toContain("own Linux desktop");
    expect(text).toContain("any app by name");
    expect(text).toContain("Connected: gmail");
    expect(text).toContain("wallet connected");
  });
  it("with Kloru's own browser and the vault, it can log in, book and pay on the web", () => {
    const text = setupSummaryFor({ browser: true, vault: { cards: 1 } });
    expect(text).toContain("Browser: yes");
    expect(text).not.toMatch(/cannot browse|book on the web/);
    expect(text).toContain("browser_pay");
    expect(text).not.toContain("Payments: not set up");
    // No card saved yet: say where cards go, not that payments are impossible.
    expect(setupSummaryFor({ browser: true, vault: { cards: 0 } })).toContain("kloru.com");
  });
  it("the stand-in apps_connect names the missing key instead of a screen", async () => {
    const tool = appsNotConfiguredTool();
    const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" }, conversationKey: "imessage:1", channel: "imessage", now: () => new Date() } as unknown as ToolContext;
    const out = await tool.spec.execute({ toolkit: "gmail" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("COMPOSIO_API_KEY");
    expect(text).toContain("gmail");
    expect(text).not.toMatch(/settings page/i);
  });
});
