import { describe, expect, it } from "vitest";
import { composioLogger } from "../src/composio.js";

// What the SDK hands a logger: one string, with colour codes, a timestamp, then each argument on its own line.
const sdk = (m: string, extra?: unknown) => `\x1b[90m2026-11-15T09:00:00.000Z\x1b[39m - \x1b[33m${m}\x1b[39m${extra ? `\n${JSON.stringify(extra)}` : ""}`;
const WARN = "Unsupported auth scheme in connected account state, ignoring state field";

describe("composioLogger", () => {
  it("shows a repeated warning once an hour, as one line, with how often it came", () => {
    const lines: string[] = [];
    let now = 0;
    const log = composioLogger((m) => lines.push(m), () => now);
    for (let i = 0; i < 40; i++) log.warn(sdk(WARN, { error: { name: "ZodError", message: "x".repeat(2000) } }));
    expect(lines).toEqual([`composio sdk: ${WARN}`]);
    now = 61 * 60_000;
    log.warn(sdk(WARN, { error: { name: "ZodError" } }));
    expect(lines).toEqual([`composio sdk: ${WARN}`, `composio sdk: ${WARN} (39 more in the last hour)`]);
  });

  it("a different warning and every error still show; info and debug don't", () => {
    const lines: string[] = [];
    const log = composioLogger((m) => lines.push(m), () => 0);
    log.warn(sdk(WARN));
    log.warn(sdk("Toolkit version is latest"));
    log.error(sdk("Request failed"));
    log.error(sdk("Request failed"));
    log.info(sdk("hello"));
    log.debug(sdk("hello"));
    expect(lines).toEqual([`composio sdk: ${WARN}`, "composio sdk: Toolkit version is latest", "composio sdk: Request failed", "composio sdk: Request failed"]);
  });
});
