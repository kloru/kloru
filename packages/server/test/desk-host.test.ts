import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { RuntimeWorkerHost } from "../src/desk-host.js";

class FakeConv {
  busy = false;
  steered: string[] = [];
  aborted = 0;
  runs: string[] = [];
  release: (() => void) | undefined;
  constructor(readonly role: WorkerRole) {}
  key = "";
  agent = { abort: () => { this.aborted++; } };
  steer(t: string) { this.steered.push(t); }
  async run(prompt: string): Promise<string> {
    this.busy = true;
    this.runs.push(prompt);
    await new Promise<void>((r) => { this.release = r; });
    this.busy = false;
    return `done:${prompt}`;
  }
}

function fakeRuntime() {
  const convs = new Map<string, FakeConv>();
  const runtime = {
    created: [] as string[],
    principals: [] as unknown[],
    retire(key: string) {
      convs.delete(key);
    },
    worker(key: string, role: WorkerRole, principal?: unknown) {
      runtime.principals.push(principal);
      let c = convs.get(key);
      if (!c) {
        c = new FakeConv(role);
        c.key = key;
        convs.set(key, c);
        runtime.created.push(key);
      }
      return c as never;
    },
  };
  return { runtime, convs };
}

const role: WorkerRole = { name: "engineer", prompt: "read only" };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("RuntimeWorkerHost", () => {
  it("a follow-up runs in the earlier issue's conversation, and steer and stop reach it there", async () => {
    const { runtime, convs } = fakeRuntime();
    const host = new RuntimeWorkerHost(runtime);
    const first = host.run(102, role, "research");
    await tick();
    convs.get("desk:issue:102:engineer")!.release!();
    await first;
    void host.run(103, role, "email those", undefined, 102);
    await tick();
    const conv = convs.get("desk:issue:102:engineer")!;
    expect(conv.runs).toEqual(["research", "email those"]);
    expect(convs.has("desk:issue:103:engineer")).toBe(false);
    expect(host.steer(103, "actually skip the second one")).toBe(true);
    expect(conv.steered).toEqual(["actually skip the second one"]);
  });

  it("runs each worker as the person who filed: Cleo as her contact, no phone as the owner", async () => {
    const { runtime } = fakeRuntime();
    const CLEO = { kind: "contact", id: "contact:cleo", tier: "partner" };
    const host = new RuntimeWorkerHost(runtime, (phone) => (phone === "+14155550191" ? (CLEO as never) : undefined));
    void host.run(1, role, "a", "+14155550191");
    void host.run(2, role, "b");
    await tick();
    expect(runtime.principals).toEqual([CLEO, undefined]);
    host.steer(1, "x");
    expect(runtime.principals.at(-1)).toEqual(CLEO);
  });

  it("runs one prompt at a time per issue, in order, with the issue's role", async () => {
    const { runtime, convs } = fakeRuntime();
    const host = new RuntimeWorkerHost(runtime);
    const first = host.run(1, role, "a");
    const second = host.run(1, role, "b");
    await tick();
    const conv = convs.get("desk:issue:1:engineer")!;
    expect(conv.role).toBe(role);
    expect(conv.runs).toEqual(["a"]);
    conv.release!();
    expect(await first).toBe("done:a");
    await tick();
    expect(conv.runs).toEqual(["a", "b"]);
    conv.release!();
    expect(await second).toBe("done:b");
  });

  it("steers and stops only a running worker it started, and never creates one", async () => {
    const { runtime, convs } = fakeRuntime();
    const host = new RuntimeWorkerHost(runtime);
    expect(host.steer(7, "hello")).toBe(false);
    host.stop(7);
    expect(runtime.created).toEqual([]);
    void host.run(2, role, "x");
    await tick();
    expect(host.steer(2, "new detail")).toBe(true);
    const conv = convs.get("desk:issue:2:engineer")!;
    host.stop(2);
    expect(conv.steered).toEqual(["new detail"]);
    expect(conv.aborted).toBe(1);
    conv.release!();
    await tick();
    expect(host.steer(2, "late")).toBe(false);
  });
});

describe("RuntimeWorkerHost: a hung worker", () => {
  it("#493: a stopped run that never finishes doesn't hold up the next one, which starts in a fresh conversation", async () => {
    const { runtime, convs } = fakeRuntime();
    const host = new RuntimeWorkerHost(runtime);
    void host.run(493, role, "research"); // hangs: a browser call that ignores abort
    await tick();
    const hung = convs.get("desk:issue:493:engineer")!;
    host.stop(493);
    expect(hung.aborted).toBe(1);
    const next = host.run(493, role, "research again");
    await tick();
    const fresh = convs.get("desk:issue:493:engineer")!;
    expect(fresh).not.toBe(hung);
    expect(fresh.runs).toEqual(["research again"]);
    fresh.release!();
    expect(await next).toBe("done:research again");
  });
});

describe("RuntimeWorkerHost: roles", () => {
  it("an issue reassigned to another role gets a separate conversation, never the old role's tools", async () => {
    const { runtime, convs } = fakeRuntime();
    const host = new RuntimeWorkerHost(runtime);
    void host.run(5, { name: "ops", prompt: "writes" }, "a");
    void host.run(5, { name: "engineer", prompt: "reads" }, "b");
    await tick();
    expect([...convs.keys()].sort()).toEqual(["desk:issue:5:engineer", "desk:issue:5:ops"]);
    expect(convs.get("desk:issue:5:engineer")!.role.name).toBe("engineer");
  });
});
