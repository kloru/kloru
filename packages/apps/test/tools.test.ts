import { describe, expect, it, vi } from "vitest";
import { PolicyEngine, defaultPolicy } from "@kloru/core";
import type { Principal, ToolContext } from "@kloru/core";
import { appsTools, describeStatus, type AppsLike } from "../src/tools.js";
import { APPS_MANAGE } from "../src/capabilities.js";

function fakeApps(over: Partial<AppsLike> = {}): AppsLike & { connectLink: ReturnType<typeof vi.fn> } {
  const connectLink = vi.fn(async (toolkit: string) => `https://connect.example/${toolkit}`);
  return {
    allToolkits: false,
    toolkitSlugs: ["gmail", "googlecalendar"],
    connectedToolkits: async () => [
      { slug: "gmail", connected: true },
      { slug: "googlecalendar", connected: false },
    ],
    connectLink,
    ...over,
  };
}

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
const partner: Principal = { kind: "contact", id: "contact:sam", tier: "partner", displayName: "Sam" };
const ctxFor = (principal: Principal): ToolContext => ({ principal, conversationKey: "c1", channel: "imessage" as ToolContext["channel"], now: () => new Date() });

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.map((c) => c.text ?? "").join("\n");
}

describe("appsTools", () => {
  it("registers apps_list and apps_connect as owner-only apps tools", () => {
    const tools = appsTools({ apps: fakeApps() });
    expect(tools.map((t) => t.spec.name)).toEqual(["apps_list", "apps_connect"]);
    for (const t of tools) {
      expect(t.spec.meta.group).toBe("apps");
      expect(t.spec.meta.capabilities).toEqual([...APPS_MANAGE]);
      expect(t.spec.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    const engine = new PolicyEngine(defaultPolicy());
    for (const t of tools) {
      expect(engine.evaluate(owner, t.spec.meta, {}).outcome).toBe("allow");
      expect(engine.evaluate(partner, t.spec.meta, {}).outcome).toBe("deny");
    }
  });

  it("apps_list reports connected and missing toolkits", async () => {
    const [list] = appsTools({ apps: fakeApps() });
    const out = textOf(await list!.spec.execute({}, ctxFor(owner)));
    expect(out).toContain("Connected: gmail.");
    expect(out).toContain("Configured but not connected: googlecalendar");
    expect(out).toContain("apps_connect");
  });

  it("apps_list says any app can be connected in all mode", async () => {
    const [list] = appsTools({ apps: fakeApps({ allToolkits: true, toolkitSlugs: ["*"], connectedToolkits: async () => [] }) });
    const out = textOf(await list!.spec.execute({}, ctxFor(owner)));
    expect(out).toContain("Connected: none yet.");
    expect(out).toContain("Any app Composio supports can be connected by name");
  });

  it("apps_connect returns the link for a configured toolkit, lowercased and trimmed", async () => {
    const apps = fakeApps();
    const [, connect] = appsTools({ apps });
    const result = await connect!.spec.execute({ toolkit: " GoogleCalendar " }, ctxFor(owner));
    expect(textOf(result)).toContain("https://connect.example/googlecalendar");
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(apps.connectLink).toHaveBeenCalledWith("googlecalendar");
  });

  it("apps_connect refuses a toolkit outside the list and names the fix", async () => {
    const apps = fakeApps();
    const [, connect] = appsTools({ apps });
    const result = await connect!.spec.execute({ toolkit: "notion" }, ctxFor(owner));
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("COMPOSIO_TOOLKITS=gmail,googlecalendar,notion");
    expect(textOf(result)).toContain("COMPOSIO_TOOLKITS=all");
    expect(apps.connectLink).not.toHaveBeenCalled();
  });

  it("apps_connect accepts any toolkit in all mode", async () => {
    const apps = fakeApps({ allToolkits: true, toolkitSlugs: ["*"] });
    const [, connect] = appsTools({ apps });
    expect(textOf(await connect!.spec.execute({ toolkit: "notion" }, ctxFor(owner)))).toContain("https://connect.example/notion");
  });

  it("apps_connect rejects a slug with odd characters before calling Composio", async () => {
    const apps = fakeApps({ allToolkits: true, toolkitSlugs: ["*"] });
    const [, connect] = appsTools({ apps });
    const result = await connect!.spec.execute({ toolkit: "notion; rm -rf" }, ctxFor(owner));
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(apps.connectLink).not.toHaveBeenCalled();
  });

  it("apps_connect refuses a non-owner even if the policy let the call through", async () => {
    const apps = fakeApps();
    const [, connect] = appsTools({ apps });
    const result = await connect!.spec.execute({ toolkit: "gmail" }, ctxFor(partner));
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(apps.connectLink).not.toHaveBeenCalled();
  });

  it("apps_connect explains a no-auth toolkit", async () => {
    const apps = fakeApps({ allToolkits: true, toolkitSlugs: ["*"], connectLink: vi.fn(async () => undefined) });
    const [, connect] = appsTools({ apps });
    expect(textOf(await connect!.spec.execute({ toolkit: "hackernews" }, ctxFor(owner)))).toContain("needs no sign-in");
  });

  it("describe never echoes more than the slug", () => {
    const [, connect] = appsTools({ apps: fakeApps() });
    expect(connect!.spec.meta.describe?.({ toolkit: "Slack" })).toBe("connect app slack");
    expect(connect!.spec.meta.describe?.(undefined)).toBe("connect app ?");
  });
});

describe("describeStatus", () => {
  it("tells the owner how to get more apps when the list is fixed", () => {
    expect(describeStatus([{ slug: "gmail", connected: true }], false)).toContain("COMPOSIO_TOOLKITS=all");
  });
});
