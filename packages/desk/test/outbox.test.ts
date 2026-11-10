import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canMove, moveItem, type OutboxState } from "../src/outbox-machine.js";
import { PersonOutbox, type FirstPassCheck, type FirstPassChoice, type Organizer, type OrganizerActions, type OrganizerView, type OutboxDeps, type OutboxPerson } from "../src/outbox.js";
import { readOutbox, type OutboxItem } from "../src/outbox-store.js";

const EZRA = "+14155550190";
const CLEO = "+14155550191";

const person: OutboxPerson = { name: "Ezra", localTime: "Tue, Nov 10, 2:00 PM", guidelines: "", preferences: "", notes: "", inConversation: undefined, turns: [], running: [], channels: ["imessage"] };

function setup(o: Partial<OutboxDeps> & { pass?: (c: FirstPassCheck) => FirstPassChoice | Promise<FirstPassChoice>; dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "outbox-"));
  const clock = { now: new Date("2026-11-10T22:00:00Z") };
  const delivered: Array<{ item: OutboxItem; text: string; channel?: string; stateOnDisk: string }> = [];
  const ledger: OutboxItem[] = [];
  const deps: OutboxDeps = {
    dir,
    now: () => clock.now,
    person: () => person,
    request: () => "",
    recent: () => [],
    deliver: async (item, m) => {
      const onDisk = readOutbox(dir).find((i) => i.id === item.id)!;
      delivered.push({ item, text: m.text, channel: m.channel, stateOnDisk: onDisk.state });
      return m.channel ?? "imessage";
    },
    record: (item) => ledger.push({ ...item }),
    isOwner: (p) => p === EZRA,
    ...(o.pass ? { firstPass: async (c) => o.pass!(c) } : {}),
    ...o,
  };
  const outbox = new PersonOutbox(deps);
  const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  return { outbox, dir, delivered, ledger, clock, advance, deps };
}

const msg = (text: string, why: OutboxItem["why"] = "result", phone = EZRA) => ({ phone, text, why, from: { agent: "worker" as const, issue: 1, call: "CA0001" } });

describe("the outbox item state machine", () => {
  it("allows the moves in the design and nothing else", () => {
    const legal: Array<[OutboxState, OutboxState]> = [
      ["new", "sending"], ["new", "dropped"], ["new", "queued"],
      ["queued", "sending"], ["queued", "scheduled"], ["queued", "merged"], ["queued", "dropped"], ["queued", "cancelled"],
      ["scheduled", "sending"], ["scheduled", "queued"], ["scheduled", "dropped"], ["scheduled", "cancelled"],
      ["sending", "sent"], ["sending", "queued"],
    ];
    const states: OutboxState[] = ["new", "queued", "scheduled", "sending", "sent", "dropped", "merged", "cancelled"];
    for (const from of states) for (const to of states) expect(canMove(from, to), `${from} → ${to}`).toBe(legal.some(([f, t]) => f === from && t === to));
  });

  it("an illegal move is returned as an error and changes nothing", () => {
    const item = { id: "o_1", state: "sent" as OutboxState };
    const moved = moveItem(item, "queued");
    expect(moved.ok).toBe(false);
    expect(item.state).toBe("sent");
  });
});

describe("submitting", () => {
  it("with no first pass configured, a message is sent, and saved as sending before the channel is called", async () => {
    const { outbox, delivered, ledger } = setup();
    const item = await outbox.submit(msg("Booked: Friday 9:10 AM with Dr. Lee."));
    expect(item.state).toBe("sent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.stateOnDisk).toBe("sending");
    expect(ledger.map((i) => i.state)).toEqual(["sent"]);
  });

  it("the first pass drops: nothing is sent, and the ledger says why", async () => {
    const { outbox, delivered, ledger } = setup({ pass: () => "drop" });
    const item = await outbox.submit(msg("No alert sent.", "report"));
    expect(item.state).toBe("dropped");
    expect(delivered).toHaveLength(0);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.note).toMatch(/first pass/);
  });

  it("the first pass hands it to the organizer: it waits, and the organizer wakes 90 seconds after the last item", async () => {
    const seen: OrganizerView[] = [];
    const organizer: Organizer = { organize: async (view) => void seen.push(view) };
    const { outbox, advance, delivered } = setup({ pass: () => "organizer", organizer });
    await outbox.submit(msg("Invite 1 sent."));
    advance(60_000);
    await outbox.submit(msg("Invite 2 sent."));
    advance(60_000);
    await outbox.tick();
    expect(seen).toHaveLength(0);
    advance(31_000);
    await outbox.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.queued.map((i) => i.text)).toEqual(["Invite 1 sent.", "Invite 2 sent."]);
    expect(delivered).toHaveLength(0);
  });

  it("a steady stream never keeps the organizer waiting past five minutes", async () => {
    let runs = 0;
    const { outbox, advance } = setup({ pass: () => "organizer", organizer: { organize: async () => void runs++ } });
    for (let i = 0; i < 6; i++) {
      await outbox.submit(msg(`Update ${i}`));
      advance(60_000);
      await outbox.tick();
    }
    expect(runs).toBe(1);
  });

  it("when the first pass fails, a reply is sent and anything else waits for the organizer", async () => {
    const { outbox, delivered } = setup({
      pass: () => {
        throw new Error("timeout");
      },
    });
    const reply = await outbox.submit({ ...msg("Yes, 4 PM works.", "reply"), from: { agent: "talker", call: "CA0001" } });
    const report = await outbox.submit(msg("Morning check: nothing new.", "report"));
    expect(reply.state).toBe("sent");
    expect(report.state).toBe("queued");
    expect(delivered.map((d) => d.text)).toEqual(["Yes, 4 PM works."]);
  });

  it("a draft that misses how they like messages goes to the organizer instead of out", async () => {
    const { outbox, delivered } = setup({ checkDraft: async () => "too long" });
    const item = await outbox.submit(msg("A very long result…"));
    expect(item.state).toBe("queued");
    expect(item.note).toMatch(/too long/);
    expect(delivered).toHaveLength(0);
    const checked = await outbox.submit({ ...msg("Already checked."), drafted: true });
    expect(checked.state).toBe("sent");
  });

  it("a channel failure leaves the item queued with the error", async () => {
    const { outbox, ledger } = setup({ deliver: async () => false });
    const item = await outbox.submit(msg("Done."));
    expect(item.state).toBe("queued");
    expect(item.note).toMatch(/not delivered/);
    expect(item.tries).toBe(1);
    expect(ledger).toHaveLength(0);
  });
});

describe("timed items", () => {
  it("a reminder waits as scheduled and fires at its time, through the first pass, told it is firing", async () => {
    const checks: FirstPassCheck[] = [];
    const { outbox, advance, delivered, clock } = setup({ pass: (c) => (checks.push(c), "send") });
    const at = new Date(clock.now.getTime() + 10 * 60_000);
    const item = await outbox.submit({ ...msg("Call the dentist.", "reminder"), sendAt: at });
    expect(item.state).toBe("scheduled");
    expect(checks).toHaveLength(0);
    advance(9 * 60_000);
    await outbox.tick();
    expect(delivered).toHaveLength(0);
    advance(61_000);
    await outbox.tick();
    expect(delivered.map((d) => d.text)).toEqual(["Call the dentist."]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.firing).toBe(true);
    await outbox.tick();
    expect(delivered).toHaveLength(1);
  });

  it("a reminder still goes at its time when the first pass fails", async () => {
    const { outbox, advance, delivered, clock } = setup({
      pass: () => {
        throw new Error("down");
      },
    });
    await outbox.submit({ ...msg("Call the dentist.", "reminder"), sendAt: new Date(clock.now.getTime() + 60_000) });
    advance(61_000);
    await outbox.tick();
    expect(delivered).toHaveLength(1);
  });

  it("the organizer can schedule a queued item; it is weighed again when its time comes", async () => {
    const organizer: Organizer = {
      organize: async (view, act) => {
        act.schedule({ items: view.queued.map((i) => i.id), at: new Date(view.now.getTime() + 8 * 3_600_000) });
      },
    };
    let pass: FirstPassChoice = "organizer";
    const { outbox, advance, delivered } = setup({ pass: () => pass, organizer });
    const item = await outbox.submit(msg("Your flight moved to 3:40 PM."));
    advance(91_000);
    await outbox.tick();
    expect(item.state).toBe("scheduled");
    pass = "send";
    advance(8 * 3_600_000);
    await outbox.tick();
    expect(delivered.map((d) => d.text)).toEqual(["Your flight moved to 3:40 PM."]);
  });
});

describe("restarts", () => {
  it("an item that was sending when Kloru stopped is queued, marked, and not sent again on its own", async () => {
    let stop: (() => void) | undefined;
    const first = setup({ deliver: () => new Promise(() => stop?.()) });
    void first.outbox.submit(msg("Booked."));
    await new Promise((r) => setTimeout(r, 20));
    const seen: OrganizerView[] = [];
    const second = setup({ dir: first.dir, organizer: { organize: async (v) => void seen.push(v) } });
    await second.outbox.recover();
    const [item] = second.outbox.all(EZRA);
    expect(item!.state).toBe("queued");
    expect(item!.note).toMatch(/may already have been delivered/);
    expect(second.delivered).toHaveLength(0);
    second.advance(91_000);
    await second.outbox.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.queued[0]!.note).toMatch(/may already have been delivered/);
  });

  it("on boot: an overdue scheduled item fires once, and an item the first pass never saw gets it", async () => {
    const first = setup();
    await first.outbox.submit({ ...msg("Take the bins out.", "reminder"), sendAt: new Date(first.clock.now.getTime() + 60_000) });
    // A crash right after an item was saved, before its first pass.
    const never = setup({ dir: first.dir, pass: () => new Promise(() => {}) });
    void never.outbox.submit(msg("Refund arrived."));
    await new Promise((r) => setTimeout(r, 20));
    const second = setup({ dir: first.dir, pass: () => "send" });
    second.advance(3_600_000);
    await second.outbox.recover();
    expect(second.delivered.map((d) => d.text).sort()).toEqual(["Refund arrived.", "Take the bins out."]);
    await second.outbox.recover();
    expect(second.delivered).toHaveLength(2);
  });

  it("on boot, a queue nobody is due to look at wakes the organizer", async () => {
    const first = setup({ pass: () => "organizer" });
    await first.outbox.submit(msg("Update."));
    let runs = 0;
    const second = setup({ dir: first.dir, organizer: { organize: async () => void runs++ } });
    second.outbox.store.setClock(EZRA, { wakeAt: undefined, burstStart: undefined });
    await second.outbox.recover();
    second.advance(91_000);
    await second.outbox.tick();
    expect(runs).toBe(1);
  });
});

describe("the organizer", () => {
  const queueThree = async (s: ReturnType<typeof setup>) => {
    const a = await s.outbox.submit(msg("Invite to Jordan sent."));
    const b = await s.outbox.submit(msg("Invite to Dr. Lee sent."));
    const c = await s.outbox.submit(msg("Morning check: nothing new.", "report"));
    return [a, b, c] as const;
  };

  it("one message covering several drafts: the drafts end merged naming it, and it lists what it covers", async () => {
    const organizer: Organizer = {
      organize: async (view, act) => {
        await act.send({ items: view.queued.map((i) => i.id), text: "Both invites went out; nothing new this morning." });
      },
    };
    const s = setup({ pass: () => "organizer", organizer });
    const [a, b, c] = await queueThree(s);
    s.advance(91_000);
    await s.outbox.tick();
    expect(s.delivered.map((d) => d.text)).toEqual(["Both invites went out; nothing new this morning."]);
    const sent = s.outbox.all(EZRA).find((i) => i.state === "sent")!;
    expect(sent.from.agent).toBe("organizer");
    expect(sent.covers).toEqual([a.id, b.id, c.id]);
    for (const i of [a, b, c]) {
      expect(i.state).toBe("merged");
      expect(i.coveredBy).toBe(sent.id);
      expect(i.text).not.toBe(sent.text);
    }
    // Exactly one ledger entry per item.
    expect(s.ledger.map((i) => i.id).sort()).toEqual([a.id, b.id, c.id, sent.id].sort());
  });

  it("a question is never folded into a digest", async () => {
    const said: string[] = [];
    const organizer: Organizer = {
      organize: async (view, act) => {
        said.push(await act.send({ items: view.queued.map((i) => i.id), text: "Two things, and one question…" }));
      },
    };
    const s = setup({ pass: () => "organizer", organizer });
    await s.outbox.submit(msg("Report A.", "report"));
    const q = await s.outbox.submit(msg("Should I book the 9:10 or the 2:30?", "question"));
    s.advance(91_000);
    await s.outbox.tick();
    expect(said[0]).toMatch(/question goes on its own/);
    expect(s.delivered).toHaveLength(0);
    expect(q.state).toBe("queued");
  });

  it("runs one at a time per person; a wake during a run starts another right after", async () => {
    let active = 0;
    let most = 0;
    let runs = 0;
    const organizer: Organizer = {
      organize: async () => {
        runs++;
        active++;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      },
    };
    const s = setup({ pass: () => "organizer", organizer });
    await s.outbox.submit(msg("One."));
    const first = s.outbox.runOrganizer(EZRA);
    const second = s.outbox.runOrganizer(EZRA);
    await Promise.all([first, second]);
    expect(most).toBe(1);
    expect(runs).toBe(2);
  });

  it("after two failed runs, what someone waits for goes as written, oldest first; reports stay", async () => {
    const organizer: Organizer = {
      organize: async () => {
        throw new Error("model down");
      },
    };
    const s = setup({ pass: () => "organizer", organizer });
    await s.outbox.submit(msg("Report.", "report"));
    await s.outbox.submit(msg("Result one."));
    await s.outbox.submit(msg("Which time?", "question"));
    s.advance(91_000);
    await s.outbox.tick();
    expect(s.delivered).toHaveLength(0);
    s.advance(61_000);
    await s.outbox.tick();
    expect(s.delivered.map((d) => d.text)).toEqual(["Result one.", "Which time?"]);
    expect(s.outbox.list(EZRA).map((i) => i.text)).toEqual(["Report."]);
  });

  it("an organizer run that never ends is cut off and counts as failed", async () => {
    const s = setup({ pass: () => "organizer", organizer: { organize: () => new Promise(() => {}) }, organizerMs: 20 });
    await s.outbox.submit(msg("Result."));
    s.advance(91_000);
    await s.outbox.tick();
    s.advance(61_000);
    await s.outbox.tick();
    expect(s.delivered.map((d) => d.text)).toEqual(["Result."]);
  });

  it("drop, wake, and sending one item as written on another channel", async () => {
    const lines: string[] = [];
    let acts: OrganizerActions | undefined;
    const organizer: Organizer = {
      organize: async (view, act) => {
        acts = act;
        const [a, b] = view.queued;
        lines.push(act.drop({ items: [a!.id], reason: "they saw this an hour ago" }));
        lines.push(await act.send({ items: [b!.id], channel: "email" }));
        lines.push(act.wake({ at: new Date(view.now.getTime() + 3_600_000) }));
      },
    };
    const s = setup({ pass: () => "organizer", organizer });
    const a = await s.outbox.submit(msg("Stale."));
    await s.outbox.submit(msg("Fresh."));
    s.advance(91_000);
    await s.outbox.tick();
    expect(a.state).toBe("dropped");
    expect(s.ledger.find((i) => i.id === a.id)!.note).toBe("they saw this an hour ago");
    expect(s.delivered.map((d) => [d.text, d.channel])).toEqual([["Fresh.", "email"]]);
    expect(s.outbox.store.clock(EZRA).selfWakeAt).toBeTruthy();
    // After the run, its tools no longer act.
    expect(acts!.wake({ at: new Date(s.clock.now.getTime() + 60_000) })).toMatch(/over/);
  });

  it("the person speaking wakes the organizer soon when something is waiting", async () => {
    let runs = 0;
    const s = setup({ pass: () => "organizer", organizer: { organize: async () => void runs++ }, settleMs: 10 * 60_000, maxSettleMs: 60 * 60_000 });
    await s.outbox.submit(msg("Update."));
    s.outbox.personSpoke(EZRA);
    s.advance(21_000);
    await s.outbox.tick();
    expect(runs).toBe(1);
  });
});

describe("listing and cancelling", () => {
  it("a person sees and cancels their own waiting items; an owner may cancel anyone's; nobody else", async () => {
    const s = setup({ pass: () => "organizer" });
    const mine = await s.outbox.submit(msg("For Cleo.", "result", CLEO));
    const other = await s.outbox.submit(msg("For Cleo too.", "result", CLEO));
    const ezras = await s.outbox.submit(msg("For Ezra."));
    expect(s.outbox.list(CLEO).map((i) => i.id)).toEqual([mine.id, other.id]);
    expect(s.outbox.cancel(ezras.id, CLEO).ok).toBe(false);
    expect(s.outbox.cancel(mine.id, CLEO).ok).toBe(true);
    expect(s.outbox.cancel(other.id, EZRA).ok).toBe(true);
    expect(s.outbox.cancel(other.id, EZRA).ok).toBe(false);
    expect(s.outbox.list(CLEO)).toHaveLength(0);
    expect(s.ledger.map((i) => [i.id, i.state])).toEqual([[mine.id, "cancelled"], [other.id, "cancelled"]]);
  });

  it("items survive on disk: a new outbox over the same directory lists them", async () => {
    const s = setup({ pass: () => "organizer" });
    await s.outbox.submit({ ...msg("Call the dentist.", "reminder"), sendAt: new Date(s.clock.now.getTime() + 3_600_000) });
    const again = setup({ dir: s.dir });
    expect(again.outbox.list(EZRA).map((i) => [i.text, i.state])).toEqual([["Call the dentist.", "scheduled"]]);
    expect(readFileSync(join(s.dir, "14155550190.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});
