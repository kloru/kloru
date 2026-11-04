import { describe, expect, it } from "vitest";
import { appsGuidance } from "../src/guidance.js";
import { DEFAULT_TOOLKITS } from "../src/index.js";

describe("appsGuidance", () => {
  it("lists connected and missing apps and how to connect", () => {
    const text = appsGuidance(["gmail"], ["googlecalendar"]);
    expect(text).toContain("Connected: gmail");
    expect(text).toContain("Not connected: googlecalendar");
    expect(text).toContain("app_composio_manage_connections");
    expect(text).toContain("apps_connect");
    expect(text).toContain("apps_list");
    expect(text).toContain("Never paste tokens");
    expect(text).not.toContain("Any app Composio supports");
    expect(text).not.toMatch(/—/);
  });

  it("says any app can be requested by name in all mode, even with nothing connected", () => {
    const text = appsGuidance([], [], { anyApp: true });
    expect(text).not.toContain("No apps are configured");
    expect(text).toContain("Connected: none yet");
    expect(text).toContain("Any app Composio supports can be requested by name");
    expect(text).toContain("app_composio_search_tools");
    expect(text).toContain("apps_connect");
    expect(text).toContain("Only the owner may connect");
    expect(text).not.toMatch(/—/);
  });

  it("lists the connected apps and the any-app line together", () => {
    const text = appsGuidance(["gmail", "notion"], [], { anyApp: true });
    expect(text).toContain("Connected: gmail, notion");
    expect(text).toContain("requested by name");
  });

  it("explains the empty case", () => {
    const text = appsGuidance([], []);
    expect(text).toContain("No apps are configured");
  });

  it("skips the connect instructions when everything is connected", () => {
    const text = appsGuidance(["gmail", "googlecalendar"], []);
    expect(text).not.toContain("Not connected");
    expect(text).toContain("Only the owner may connect");
  });
});

describe("appsGuidance with toolkits lacking an auth config", () => {
  it("names them and says who has to fix it", () => {
    const text = appsGuidance(["gmail"], ["googlecalendar"], { unavailable: ["googlecontacts"] });
    expect(text).toContain("Not available yet: googlecontacts.");
    expect(text).toContain("must add a Composio auth config for it");
    expect(appsGuidance(["gmail"], [])).not.toContain("Not available yet");
  });
});

describe("appsGuidance after a connect link", () => {
  it("tells the model to check apps_list itself and to send the link when an action fails unconnected", () => {
    const text = appsGuidance(["gmail"], ["googlecalendar"]);
    expect(text).toContain("call apps_list first");
    expect(text).toContain("never make the owner report back");
    expect(text).toContain("send the connect link in that same turn");
  });
});

describe("DEFAULT_TOOLKITS", () => {
  it("is gmail, calendar and contacts", () => {
    expect(DEFAULT_TOOLKITS).toEqual(["gmail", "googlecalendar", "googlecontacts"]);
  });
});
