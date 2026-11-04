import { describe, expect, it } from "vitest";
import { READ_TOOLS, TOOL_CAPABILITIES, capabilitiesFor, isSupportedTool } from "../src/capabilities.js";

describe("capabilitiesFor", () => {
  it("tags every read with email.read only", () => {
    for (const tool of ["read_inbox", "read_message", "search_messages"]) {
      expect(capabilitiesFor(tool)).toEqual(["email.read"]);
    }
  });

  it("tags every send with email.send only", () => {
    for (const tool of ["send_email", "reply_to_message"]) {
      expect(capabilitiesFor(tool)).toEqual(["email.send"]);
    }
  });

  it("returns a copy, so a caller cannot change the table", () => {
    capabilitiesFor("send_email").push("purchase");
    expect(capabilitiesFor("send_email")).toEqual(["email.send"]);
  });

  it("throws for a tool with no tag instead of guessing", () => {
    expect(() => capabilitiesFor("jmap_request")).toThrow(/no capability tag/);
  });
});

describe("isSupportedTool", () => {
  it("leaves out the tools that read, send and delete in one call", () => {
    expect(isSupportedTool("jmap_request")).toBe(false);
    expect(isSupportedTool("run_preset")).toBe(false);
  });

  it("leaves out the duplicates and the setup helpers", () => {
    for (const tool of ["search", "fetch", "list_agents", "help"]) expect(isSupportedTool(tool)).toBe(false);
  });

  it("does not treat Object prototype keys as tools", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) expect(isSupportedTool(key)).toBe(false);
  });

  it("supports exactly the tools in the table", () => {
    expect(Object.keys(TOOL_CAPABILITIES).sort()).toEqual(["read_inbox", "read_message", "reply_to_message", "search_messages", "send_email"]);
    for (const tool of Object.keys(TOOL_CAPABILITIES)) expect(isSupportedTool(tool)).toBe(true);
  });
});

describe("READ_TOOLS", () => {
  it("holds only tools that need nothing beyond email.read", () => {
    for (const tool of READ_TOOLS) expect(capabilitiesFor(tool)).toEqual(["email.read"]);
  });

  it("never holds a send, so a send result is not wrapped as inbox text", () => {
    expect(READ_TOOLS.has("send_email")).toBe(false);
    expect(READ_TOOLS.has("reply_to_message")).toBe(false);
  });
});
