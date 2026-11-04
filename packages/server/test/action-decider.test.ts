import { describe, expect, it } from "vitest";
import { actionDecider } from "../src/action-decider.js";

const check = { action: "GMAIL_SEND_EMAIL", args: { recipient_email: "dan@work.example.com", body: "I'm interviewing at Acme" }, request: "Send Dan my update", call: "Caller: Send Dan my update", guidelines: "Emails to me need no yes.", known: "Dan is Evan's manager.", ownEmails: ["evan@work.example.com"] };

function fakeFetch(content: unknown, seen: unknown[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  }) as typeof fetch;
}

describe("the action decider", () => {
  it("returns the model's decision, with the fix or the question when there is one", async () => {
    const seen: any[] = [];
    const d = await actionDecider({ apiKey: "k", fetchImpl: fakeFetch({ reaches: "his manager", reversible: false, worst_case: "his job search is out", asked_for: true, decision: "revise", reason: "job search", ask: "", fix: "Leave out Acme" }, seen) })(check);
    expect(d).toEqual({ decision: "revise", reason: "job search", fix: "Leave out Acme" });
    const user = seen[0].messages[1].content as string;
    expect(user).toContain("GMAIL_SEND_EMAIL");
    expect(user).toContain("Dan is Evan's manager.");
    expect(user).toContain("Emails to me need no yes.");
    expect(seen[0].response_format.json_schema.strict).toBe(true);
  });

  it("for a family member, the model sees the owner's policies for her; for the owner, nothing extra", async () => {
    const seen: any[] = [];
    const answer = { reaches: "", reversible: true, worst_case: "", asked_for: true, decision: "do", reason: "ok", ask: "", fix: "" };
    await actionDecider({ apiKey: "k", fetchImpl: fakeFetch(answer, seen) })({ ...check, ownerGuidelines: 'Evan said about Cara: "only my calendar"' });
    await actionDecider({ apiKey: "k", fetchImpl: fakeFetch(answer, seen) })(check);
    expect(seen[0].messages[1].content).toContain('Evan said about Cara: "only my calendar"');
    expect(seen[1].messages[1].content).not.toContain("family owner");
  });

  it("an answer without a decision is an error, so the worker's own judgment stands", async () => {
    await expect(actionDecider({ apiKey: "k", fetchImpl: fakeFetch({ reason: "?" }) })(check)).rejects.toThrow(/no decision/);
  });
});
