import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { langfuseFromEnv, prefsAllowContent } from "../src/telemetry.js";

const ENV = { LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-2", LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com" };

describe("telemetry", () => {
  it("is off without Langfuse keys", () => {
    expect(langfuseFromEnv({})).toBeUndefined();
  });

  it("turns desk spans into OTLP spans in the call's Langfuse session", async () => {
    const exporter = new InMemorySpanExporter();
    const lf = langfuseFromEnv(ENV, { exporter, sync: true })!;
    expect(lf.endpoint).toBe("https://us.cloud.langfuse.com/api/public/otel/v1/traces");
    const start = new Date(Date.now() - 1500);
    lf.telemetry.span({ name: "engineer #1", sessionId: "CA9", start, end: new Date(), input: "List Wednesday", output: "Dentist 11:30", attributes: { issue: 1, role: "engineer" } });
    lf.telemetry.span({ name: "pm", sessionId: "CA9", start, end: new Date(), attributes: { triggers: "filed #1", ok: true } });
    const [worker, pm] = exporter.getFinishedSpans();
    await lf.shutdown();
    expect(worker!.name).toBe("engineer #1");
    expect(worker!.attributes).toMatchObject({ "langfuse.session.id": "CA9", "session.id": "CA9", "langfuse.trace.name": "engineer #1", "langfuse.observation.input": "List Wednesday", "langfuse.observation.output": "Dentist 11:30", "kloru.issue": 1, "kloru.role": "engineer" });
    expect(pm!.attributes["langfuse.observation.input"]).toBeUndefined();
    expect(pm!.attributes["kloru.ok"]).toBe(true);
    const ms = (worker!.endTime[0] - worker!.startTime[0]) * 1000 + (worker!.endTime[1] - worker!.startTime[1]) / 1e6;
    expect(ms).toBeGreaterThanOrEqual(1400);
  });

  it("words go to traces only when the caller's improve setting is on; unreadable means no", () => {
    const dir = mkdtempSync(join(tmpdir(), "prefs-"));
    const file = join(dir, "prefs.json");
    expect(prefsAllowContent(undefined)("+14155550190")).toBe(false);
    expect(prefsAllowContent(file)("+14155550190")).toBe(true);
    writeFileSync(file, JSON.stringify({ version: 1, transcriptsOff: ["+14155550190"] }));
    expect(prefsAllowContent(file)("+1 (415) 555-0190")).toBe(false);
    expect(prefsAllowContent(file)("+14155550100")).toBe(true);
    writeFileSync(file, "{nope");
    expect(prefsAllowContent(file)("+14155550100")).toBe(false);
  });
});
