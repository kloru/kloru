/**
 * Maritime wakes a sleeping agent for its schedules only if it knows them. The
 * agent pushes its schedule list to the platform on boot and whenever it changes.
 * Pushing is best effort; the in-process scheduler still fires while awake.
 */
export interface ScheduleSyncOptions {
  backendUrl: string;
  agentId: string;
  token: string;
  /** Current schedules in Maritime's shape (Scheduler.toMaritimeSchedules). */
  read: () => unknown[];
  fetchImpl?: typeof fetch;
  logger?: (m: string) => void;
  /** Poll interval for change detection. Default 60 s. */
  intervalMs?: number;
}

export interface ScheduleSync {
  /** Push when the list changed since the last successful push (or always with force). Resolves true when a request was sent and accepted. */
  push(force?: boolean): Promise<boolean>;
  /** Start polling for changes. Returns a stop function. */
  start(): () => void;
  stop(): void;
}

export function schedulesEndpoint(backendUrl: string): string {
  return `${backendUrl.replace(/\/+$/, "")}/api/agents/internal/schedules`;
}

export function createScheduleSync(opts: ScheduleSyncOptions): ScheduleSync {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const log = opts.logger ?? (() => {});
  let lastPushed: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<boolean> | undefined;

  async function push(force = false): Promise<boolean> {
    if (inFlight) return inFlight;
    inFlight = doPush(force).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function doPush(force: boolean): Promise<boolean> {
    const schedules = opts.read();
    const serialized = JSON.stringify(schedules);
    if (!force && serialized === lastPushed) return false;
    try {
      const res = await fetchImpl(schedulesEndpoint(opts.backendUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Maritime-Agent-Id": opts.agentId,
          Authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ schedules }),
      });
      if (!res.ok) {
        log(`schedule push failed: HTTP ${res.status}`);
        return false;
      }
      lastPushed = serialized;
      log(`pushed ${schedules.length} schedule(s) to Maritime`);
      return true;
    } catch (err) {
      log(`schedule push error: ${(err as Error).message}`);
      return false;
    }
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function start(): () => void {
    stop();
    timer = setInterval(() => {
      void push(false);
    }, opts.intervalMs ?? 60_000);
    timer.unref?.();
    return stop;
  }

  return { push, start, stop };
}
