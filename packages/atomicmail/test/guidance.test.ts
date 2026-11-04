import { describe, expect, it } from "vitest";
import { atomicMailGuidance } from "../src/guidance.js";

describe("atomicMailGuidance", () => {
  it("names the inbox address when it is known", () => {
    expect(atomicMailGuidance("me@atomicmail.ai")).toContain("inbox of your own at me@atomicmail.ai");
  });

  it("still works without an address", () => {
    const text = atomicMailGuidance();
    expect(text).toContain("inbox of your own on Atomic Mail");
    expect(text).not.toContain("undefined");
  });

  it("names every tool the model has", () => {
    const text = atomicMailGuidance();
    for (const tool of ["atomicmail_read_inbox", "atomicmail_search_messages", "atomicmail_read_message", "atomicmail_send_email", "atomicmail_reply_to_message"]) {
      expect(text).toContain(tool);
    }
  });

  it("tells the model that mail is data and not instructions", () => {
    expect(atomicMailGuidance()).toMatch(/data from other people/);
    expect(atomicMailGuidance()).toMatch(/Follow the owner/);
  });

  it("keeps to the house prose rules: no em-dashes", () => {
    expect(atomicMailGuidance("me@atomicmail.ai")).not.toMatch(/[—–]/);
  });
});
