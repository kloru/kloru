import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir } from "@kloru/core";
import { afterEach, describe, expect, it } from "vitest";
import { Models, ROLES, kindsOf, modelOf, useModels } from "../src/models.js";
import { resultGate } from "../src/result-gate.js";

const chat = ["/api/v1/chat/completions", "/api/v1/completions", "/api/v1/messages", "/api/v1/responses"];
const text = (id: string, created: number, params: string[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  created,
  pricing: { prompt: "0.000000825", completion: "0.000004125" },
  architecture: { output_modalities: ["text"] },
  supported_parameters: params,
  endpoints: chat,
  ...extra,
});
const LISTED = [
  text("google/gemini-3.8-flash", 1788362056, ["tools", "structured_outputs"]),
  text("google/gemini-3.5-flash", 1779148800, ["tools", "structured_outputs"]),
  text("acme/plain", 1779148800, []),
  text("acme/keeps-data", 1779148800, ["tools"]),
  text("acme/retired", 1779148800, ["tools"], { expiration_date: "2026-01-01" }),
  { id: "typesafe/jev-1.14", name: "TypeSafe: Jev 1.14", created: 1792021417, pricing: { prompt: "0.000000042", completion: "0" }, architecture: { output_modalities: ["decisions"] }, supported_parameters: [], endpoints: ["/api/alpha/decisions"] },
  { id: "openai/gpt-6-luna-decisions", created: 1791321558, pricing: { prompt: "0.0000001", completion: "0" }, architecture: { output_modalities: ["decisions"] }, supported_parameters: [], endpoints: ["/api/alpha/decisions"] },
  { id: "google/gemini-3.1-flash-image", created: 1781754065, architecture: { output_modalities: ["image", "text"] }, supported_parameters: ["structured_outputs"], endpoints: [...chat, "/api/v1/images"] },
];
const ZDR = LISTED.filter((m) => m.id !== "acme/keeps-data").map((m) => ({ model_id: m.id }));

function openrouter(seen: string[] = [], up = () => true): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    if (!up()) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ data: url.includes("/endpoints/zdr") ? ZDR : LISTED }));
  }) as unknown as typeof fetch;
}
const dir = () => new StateDir(mkdtempSync(join(tmpdir(), "models-")));
const NOW = new Date("2026-11-16T12:00:00Z");

afterEach(() => useModels(undefined));

describe("which model does each job", () => {
  it("a job nobody picked for runs on the environment's model, else the listed default", () => {
    const m = new Models(dir(), { defaults: { pm: "google/gemini-3.5-flash" } });
    expect(m.of("pm")).toBe("google/gemini-3.5-flash");
    expect(m.of("engineer")).toBe(ROLES.engineer.model);
    expect(m.chosen("pm")).toBeUndefined();
    expect(m.list().find((r) => r.id === "pm")).toMatchObject({ label: "PM", kind: "tools", model: "google/gemini-3.5-flash", default: "google/gemini-3.5-flash" });
  });

  it("says what each listed model can do, from what OpenRouter serves", () => {
    expect(kindsOf(LISTED[0]!)).toEqual(["text", "tools", "json"]);
    expect(kindsOf(LISTED[2]!)).toEqual(["text"]);
    expect(kindsOf(LISTED[5]!)).toEqual(["decision"]);
    expect(kindsOf(LISTED[7]!)).toEqual(["text", "json", "image"]);
  });

  it("the choices are the models offered now with no data kept, newest first, with their prices", async () => {
    const seen: string[] = [];
    const m = new Models(dir(), { fetchImpl: openrouter(seen), now: () => NOW });
    const c = await m.catalog();
    expect(c.ok && c.value.map((x) => x.id)).toEqual(["typesafe/jev-1.14", "openai/gpt-6-luna-decisions", "google/gemini-3.8-flash", "google/gemini-3.1-flash-image", "google/gemini-3.5-flash", "acme/plain"]);
    expect(c.ok && c.value[2]).toMatchObject({ in: 0.825, out: 4.125, since: "2026-09-02" });
    // Decision models are only in the full list.
    expect(seen).toEqual(["https://openrouter.ai/api/v1/models?output_modalities=all", "https://openrouter.ai/api/v1/endpoints/zdr"]);
    await m.catalog();
    expect(seen).toHaveLength(2);
  });

  it("a pick is kept with who made it, survives a restart, and goes back to the default", async () => {
    const state = dir();
    const m = new Models(state, { fetchImpl: openrouter(), now: () => NOW });
    const r = await m.set("pm", " google/gemini-3.8-flash ", "Evan");
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ id: "pm", model: "google/gemini-3.8-flash", default: ROLES.pm.model, by: "Evan", at: NOW.toISOString() }) });
    expect(JSON.parse(readFileSync(state.path("models.json"), "utf8"))).toEqual({ pm: { model: "google/gemini-3.8-flash", by: "Evan", at: NOW.toISOString() } });
    expect(new Models(state).of("pm")).toBe("google/gemini-3.8-flash");
    expect(await m.set("pm", "", "Evan")).toMatchObject({ ok: true, value: { model: ROLES.pm.model } });
    expect(new Models(state).chosen("pm")).toBeUndefined();
  });

  it("another decision model can do a decision job; a writing model can't, and a decision model can't write", async () => {
    const m = new Models(dir(), { fetchImpl: openrouter(), now: () => NOW });
    expect((await m.set("access", "openai/gpt-6-luna-decisions", "Evan")).ok).toBe(true);
    expect(await m.set("access", "google/gemini-3.8-flash", "Evan")).toEqual({ ok: false, error: "Access review needs a model that answers OpenRouter's decisions API; google/gemini-3.8-flash doesn't." });
    expect(await m.set("pm", "typesafe/jev-1.14", "Evan")).toMatchObject({ ok: false, error: expect.stringContaining("calls tools") });
    expect(await m.set("pm", "acme/plain", "Evan")).toMatchObject({ ok: false });
    expect(await m.set("fast-path-writer", "acme/plain", "Evan")).toMatchObject({ ok: true });
    expect(await m.set("image", "google/gemini-3.1-flash-image", "Evan")).toMatchObject({ ok: true });
  });

  it("refuses a model OpenRouter doesn't offer, one whose providers keep data, and a retired one", async () => {
    const m = new Models(dir(), { fetchImpl: openrouter(), now: () => NOW });
    for (const id of ["google/gemini-9-flash", "acme/keeps-data", "acme/retired"]) {
      expect(await m.set("pm", id, "Evan")).toEqual({ ok: false, error: `OpenRouter doesn't offer ${id} through a provider that keeps no data.` });
    }
    expect(m.chosen("pm")).toBeUndefined();
  });

  it("changes nothing while OpenRouter's list can't be read; the last good list still checks a pick", async () => {
    let up = false;
    let now = NOW;
    const m = new Models(dir(), { fetchImpl: openrouter([], () => up), now: () => now });
    expect(await m.set("pm", "google/gemini-3.8-flash", "Evan")).toMatchObject({ ok: false, error: expect.stringContaining("nothing was changed") });
    up = true;
    expect((await m.catalog()).ok).toBe(true);
    up = false;
    now = new Date(NOW.getTime() + 3_600_000);
    expect((await m.set("pm", "google/gemini-3.8-flash", "Evan")).ok).toBe(true);
  });

  it("a file someone broke by hand is read as no picks", () => {
    const state = dir();
    writeFileSync(state.path("models.json"), JSON.stringify({ pm: "nope", bogus: { model: "x" }, qa: { model: "google/gemini-3.8-flash", by: "Evan", at: "x" } }));
    const m = new Models(state);
    expect(m.chosen("pm")).toBeUndefined();
    expect(m.of("qa")).toBe("google/gemini-3.8-flash");
  });

  it("a job reads its model at each run, so a pick takes effect without a restart", async () => {
    const m = new Models(dir(), { fetchImpl: openrouter(), now: () => NOW });
    expect(modelOf("result-gate")).toBe("typesafe/jev-1.14");
    useModels(m);
    const asked: string[] = [];
    const jev = (async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)).model);
      return new Response(JSON.stringify({ answers: { check: { type: "choice", choice: "none", probabilities: { none: 0.9 } } } }));
    }) as unknown as typeof fetch;
    const gate = resultGate({ apiKey: "k", fetchImpl: jev });
    const check = { request: "r", result: "done", changed: "c", ledger: [] };
    await gate(check);
    await m.set("result-gate", "openai/gpt-6-luna-decisions", "Evan");
    await gate(check);
    expect(asked).toEqual(["typesafe/jev-1.14", "openai/gpt-6-luna-decisions"]);
  });
});
