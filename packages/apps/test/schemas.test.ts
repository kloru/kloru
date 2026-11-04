import { describe, expect, it } from "vitest";
import { fetchToolSchemas, renderToolGuide } from "../src/schemas.js";

const SCHEMA = {
  slug: "GMAIL_FETCH_EMAILS",
  description: "Fetches a list of email messages from a Gmail account, supporting filtering, pagination, and optional full content retrieval. Long text that goes on and on.",
  input_parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail advanced search query (e.g., 'from:user subject:meeting'). Supports operators like after:, before:." },
      max_results: { type: "integer", description: "Maximum number of messages to retrieve per page." },
      label_ids: { type: "array", items: { type: "string" }, description: "Filter by label IDs." },
    },
    required: ["query"],
  },
};

describe("preloaded tool schemas (#17)", () => {
  it("fetches each slug's schema at the latest toolkit version, with the project key", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("ck");
      return new Response(JSON.stringify(SCHEMA), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchToolSchemas("ck", ["GMAIL_FETCH_EMAILS"], fetchImpl);
    expect(urls).toEqual(["https://backend.composio.dev/api/v3/tools/GMAIL_FETCH_EMAILS?toolkit_versions=latest"]);
    expect(out[0]!.slug).toBe("GMAIL_FETCH_EMAILS");
  });

  it("a slug that fails is skipped, not fatal", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchToolSchemas("ck", ["NOPE"], fetchImpl)).toEqual([]);
  });

  it("renders a compact guide: what each action does, its parameters and which are required", () => {
    const guide = renderToolGuide([SCHEMA]);
    expect(guide).toContain("GMAIL_FETCH_EMAILS: Fetches a list of email messages from a Gmail account");
    expect(guide).toContain("query* (string)");
    expect(guide).toContain("max_results (integer)");
    expect(guide).toContain("label_ids (string[])");
    expect(guide.length).toBeLessThan(600);
  });
});
