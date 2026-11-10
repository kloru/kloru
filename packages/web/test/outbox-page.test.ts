import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { outboxPage } from "../src/desk-pages.js";

const EZRA = "+14155550190";
const CLEO = "+14155550191";

async function outbox() {
  const root = mkdtempSync(join(tmpdir(), "outbox-page-"));
  const desk = new Desk({
    root,
    host: { run: () => new Promise<string>(() => {}), steer: () => false, stop: () => {} },
    planner: { handle: async () => {} },
    notify: async () => "imessage",
    firstPass: async (c) => (c.item.text.includes("weekly") ? "organizer" : c.item.text.includes("again") ? "drop" : "send"),
  });
  const { call } = desk.startCall({ callSid: "CA000", phone: EZRA, channel: "voice" });
  const issue = desk.fileIssue(call.id, "Find a dentist for Nora");
  await desk.messageCaller(issue.id, "Maplewood Dental can see Nora on Friday at 3.");
  await desk.messageCaller(issue.id, "The weekly summary is ready.");
  await desk.messageCaller(issue.id, "Here's the dentist again.");
  await desk.remind(EZRA, "Reminder: call <b>Dr. Lee</b>.", "2099-01-05T09:00");
  await desk.remind(CLEO, "Reminder: pick up Nora at Little Pines.", "2099-01-05T15:00");
  return root;
}

describe("the Messages page", () => {
  it("shows a person what waits for them, what is scheduled, and what the last day sent or dropped", async () => {
    const html = outboxPage(await outbox(), { phone: EZRA });
    const section = (title: string) => html.split("<h2>").find((s) => s.startsWith(title)) ?? "";
    expect(section("Waiting")).toContain("The weekly summary is ready.");
    expect(section("Scheduled")).toContain("Reminder: call &lt;b&gt;Dr. Lee&lt;/b&gt;.");
    expect(section("The last day")).toContain("Maplewood Dental can see Nora on Friday at 3.");
    expect(section("The last day")).toContain("sent by imessage");
    expect(section("The last day")).toContain("Here&#39;s the dentist again.");
    expect(html).not.toContain("Little Pines");
  });

  it("an owner's view of everyone's says whose each one is", async () => {
    const html = outboxPage(await outbox(), { name: (p) => (p === CLEO ? "Cleo" : "Ezra") });
    expect(html).toContain("Little Pines");
    expect(html).toContain("for Cleo");
  });

  it("an empty outbox says so", () => {
    const html = outboxPage(mkdtempSync(join(tmpdir(), "outbox-page-")), { phone: EZRA });
    expect(html).toContain("Nothing is waiting.");
    expect(html).toContain("Nothing is scheduled.");
  });
});
