/**
 * Keeps the store fresh in the background: every 2 minutes calendar (a short window) and new mail;
 * the trash recheck every 15 minutes; the full calendar (a year each way) daily; the mail fill each
 * run until done. kick() refreshes a source at once after Kloru changes it (write-through).
 */
interface SyncerLike {
  calendar(o?: { full?: boolean }): Promise<number>;
  gmail(o?: { recheck?: boolean }): Promise<number>;
  gmailFill(pages?: number): Promise<number>;
}

const MIN = 60_000;

export class SyncRunner {
  private lastFull = 0;
  private lastRecheck = 0;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly syncer: SyncerLike,
    private readonly log: (m: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** One pass; never two at once. */
  async runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const t = this.now().getTime();
      const full = t - this.lastFull >= 24 * 60 * MIN;
      const recheck = t - this.lastRecheck >= 15 * MIN;
      await this.syncer.calendar(full ? { full: true } : {});
      if (full) this.lastFull = t;
      await this.syncer.gmail(recheck ? { recheck: true } : {});
      if (recheck) this.lastRecheck = t;
      await this.syncer.gmailFill();
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Kloru just changed something through this app action: refresh that source now. */
  async kick(slug: string): Promise<void> {
    const s = slug.toUpperCase();
    if (s.startsWith("GOOGLECALENDAR_")) await this.syncer.calendar();
    else if (s.startsWith("GMAIL_")) await this.syncer.gmail({ recheck: true });
  }

  start(everyMs = 2 * MIN): void {
    const tick = () => void this.runOnce().catch((e) => this.log(`store: sync run failed: ${e instanceof Error ? e.message : String(e)}`));
    tick();
    this.timer ??= setInterval(tick, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
