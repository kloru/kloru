/**
 * Desk traces to Langfuse over OpenTelemetry, the same path the voice service uses, so a call's
 * PM batches and worker runs sit in the call's session next to its turns (session = CallSid).
 * Words (specs, results) go only when the caller's "Help improve Kloru for everyone" is on.
 */
import { existsSync, readFileSync } from "node:fs";
import type { DeskTelemetry } from "@kloru/desk";
import { normalizePhone } from "@kloru/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";

export interface Langfuse {
  endpoint: string;
  telemetry: DeskTelemetry;
  shutdown(): Promise<void>;
}

/** Off (undefined) without LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. */
export function langfuseFromEnv(env: NodeJS.ProcessEnv, opts: { exporter?: SpanExporter; sync?: boolean } = {}): Langfuse | undefined {
  const clean = (v?: string) => v?.trim().replace(/^"|"$/g, "") || undefined;
  const pub = clean(env.LANGFUSE_PUBLIC_KEY);
  const secret = clean(env.LANGFUSE_SECRET_KEY);
  if (!pub || !secret) return undefined;
  const base = (clean(env.LANGFUSE_BASE_URL) ?? "https://us.cloud.langfuse.com").replace(/\/+$/, "");
  const endpoint = `${base}/api/public/otel/v1/traces`;
  const exporter = opts.exporter ?? new OTLPTraceExporter({ url: endpoint, headers: { Authorization: `Basic ${Buffer.from(`${pub}:${secret}`).toString("base64")}` } });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "kloru-desk" }),
    spanProcessors: [opts.sync ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("kloru-desk");
  return {
    endpoint,
    telemetry: {
      span(s) {
        const attributes: Record<string, string | number | boolean> = { "langfuse.session.id": s.sessionId, "session.id": s.sessionId, "langfuse.trace.name": s.name };
        if (s.input !== undefined) attributes["langfuse.observation.input"] = s.input;
        if (s.output !== undefined) attributes["langfuse.observation.output"] = s.output;
        for (const [k, v] of Object.entries(s.attributes)) attributes[`kloru.${k}`] = v;
        tracer.startSpan(s.name, { startTime: s.start, attributes }).end(s.end);
      },
    },
    shutdown: () => provider.shutdown(),
  };
}

/** The voice preferences file (packages/web prefs.ts): words allowed unless the phone opted out; unreadable means no. */
export function prefsAllowContent(path: string | undefined): (phone: string) => boolean {
  return (phone) => {
    if (!path) return false;
    if (!existsSync(path)) return true;
    try {
      const off = (JSON.parse(readFileSync(path, "utf8")) as { transcriptsOff?: unknown }).transcriptsOff;
      return !(Array.isArray(off) && off.includes(normalizePhone(phone)));
    } catch {
      return false;
    }
  };
}
