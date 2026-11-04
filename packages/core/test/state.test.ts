import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateDir, resolveDataDir } from "../src/state.js";
import { tempState } from "./helpers.js";

describe("resolveDataDir", () => {
  it("honours INSTINCT_DATA_DIR and otherwise picks /data or ./.instinct", () => {
    expect(resolveDataDir({ INSTINCT_DATA_DIR: "/tmp/x/state" })).toBe("/tmp/x/state");
    expect(resolveDataDir({ INSTINCT_DATA_DIR: "rel/state" })).toBe(path.resolve("rel/state"));
    const fallback = resolveDataDir({});
    const hasData = fs.existsSync("/data") && fs.statSync("/data").isDirectory();
    expect(fallback).toBe(hasData ? "/data" : path.resolve(".instinct"));
    expect(resolveDataDir({ INSTINCT_DATA_DIR: "   " })).toBe(fallback);
  });
});

describe("StateDir", () => {
  it("ensure() creates the standard subdirectories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instinct-state-"));
    const state = new StateDir(path.join(root, "nested", "data"));
    expect(fs.existsSync(state.root)).toBe(false);
    state.ensure();
    for (const sub of ["memory/journal", "sessions", "workspace", "inbox"]) expect(fs.existsSync(path.join(state.root, sub)), sub).toBe(true);
    state.ensure(); // idempotent
  });

  it("refuses paths that escape the root", () => {
    const state = tempState();
    expect(state.path("a", "b.json")).toBe(path.join(state.root, "a", "b.json"));
    expect(() => state.path("../outside.json")).toThrow(/escapes/);
    expect(() => state.path("sessions/../../x")).toThrow(/escapes/);
    expect(() => state.readText("../etc/passwd")).toThrow(/escapes/);
    expect(state.path()).toBe(state.root);
  });

  it("reads and writes JSON with a fallback for missing or corrupt files", () => {
    const state = tempState();
    expect(state.readJson("missing.json", { a: 1 })).toEqual({ a: 1 });
    state.writeJson("deep/dir/thing.json", { hello: "world", n: [1, 2] });
    expect(state.exists("deep/dir/thing.json")).toBe(true);
    expect(state.readJson("deep/dir/thing.json", null)).toEqual({ hello: "world", n: [1, 2] });
    state.writeText("broken.json", "{not json");
    expect(state.readJson("broken.json", "fallback")).toBe("fallback");
    expect(fs.readdirSync(state.root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("appends and reads lines without blank entries", () => {
    const state = tempState();
    expect(state.readLines("log.jsonl")).toEqual([]);
    state.appendLine("log.jsonl", "one");
    state.appendLine("log.jsonl", "two\n");
    state.appendLine("log.jsonl", "three\r\n");
    expect(state.readLines("log.jsonl")).toEqual(["one", "two", "three"]);
    expect(state.readText("log.jsonl")).toBe("one\ntwo\nthree\n");
  });

  it("readText returns the fallback for a missing file", () => {
    const state = tempState();
    expect(state.readText("nope.md")).toBe("");
    expect(state.readText("nope.md", "x")).toBe("x");
    state.writeText("notes.md", "hi");
    expect(state.readText("notes.md")).toBe("hi");
  });
});
