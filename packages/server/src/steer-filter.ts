/**
 * Whether a caller's line changes an issue's work (decision-models skill: a schema-shaped yes/no on
 * a fast, cheap model). Only then is the worker steered: on call CA75760d…, "I'll just wait" reached
 * the weather engineer, its last message replied to that, and the forecast never reached the caller.
 */
import type { Issue } from "@kloru/desk";
import { chatCompletion } from "./openrouter.js";

const MODEL = "google/gemini-3.5-flash-lite";
const SCHEMA = { type: "object", additionalProperties: false, required: ["changes"], properties: { changes: { type: "boolean" } } };
const PROMPT =
  "Kloru is working on the caller's request while they talk on the phone. Does what they just said change, narrow, " +
  "add to or cancel that request? Waiting, thanks, small talk, or questions to Kloru about something else: false.";

export function steerFilter(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string }): (issue: Issue, text: string) => Promise<boolean> {
  return async (issue, text) => {
    const content = await chatCompletion({ apiKey: o.apiKey, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) }, {
        model: o.model ?? MODEL,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: `Request: ${issue.request}${issue.spec ? `\nAs assigned: ${issue.spec}` : ""}\nThe caller just said: ${text}` },
        ],
        response_format: { type: "json_schema", json_schema: { name: "changes_request", strict: true, schema: SCHEMA } },
      });
    return (JSON.parse(content || "{}") as { changes?: boolean }).changes === true;
  };
}
