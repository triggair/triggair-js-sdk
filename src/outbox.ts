// The durable outbox (§6.2): writes that must survive a dropped connection are
// queued in Storage and replayed on reconnect. Analytics events coalesce by name
// (counts summed); cloud saves coalesce by slot (last-write-wins). flush() runs on
// the `online` event, on an interval, and after each enqueue; it removes an item
// only on a confirmed 2xx and never throws (best-effort background work). Each item
// carries an Idempotency-Key so replay won't double-apply once the server reads it.
// Events are frozen into an in-flight `batch` with a STABLE key before sending, so
// a re-flush after a failure resends the identical batch under the identical key
// (the server dedupes on it); new track()s accrue behind the batch and flush next.
// Saves are additionally last-write-wins, so a replayed save is naturally safe.
import type { RequestSpec } from "./transport";

type Requester = <T>(spec: RequestSpec) => Promise<T | undefined>;
interface KV {
  get(k: string): string | null;
  set(k: string, v: string): void;
}
interface EventBatch {
  events: Record<string, number>;
  idem: string;
}
interface State {
  events: Record<string, number>;
  batch: EventBatch | null;
  saves: Record<string, { data: unknown; idem: string }>;
}
const MAX_EVENT_NAMES = 200;
const rid = () => `idem_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;

export function createOutbox(o: {
  request: Requester;
  storage: KV;
  namespace: string;
  intervalMs?: number;
  online?: () => boolean;
}) {
  const skey = `${o.namespace}outbox`;
  const state: State = load();
  let flushing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const isOnline = o.online ?? (() => globalThis.navigator?.onLine ?? true);

  function load(): State {
    try {
      const raw = o.storage.get(skey);
      const s = raw ? (JSON.parse(raw) as Partial<State>) : null;
      if (s?.events && s.saves) return { events: s.events, batch: s.batch ?? null, saves: s.saves };
    } catch {
      // corrupt persisted queue — discard rather than crash
    }
    return { events: {}, batch: null, saves: {} };
  }
  function persist(): void {
    o.storage.set(skey, JSON.stringify(state));
  }
  function kick(): void {
    if (isOnline()) void flush();
  }

  function track(name: string, count = 1): void {
    if (!(name in state.events) && Object.keys(state.events).length >= MAX_EVENT_NAMES) return;
    state.events[name] = (state.events[name] ?? 0) + count;
    persist();
    kick();
  }
  function queueSave(slot: string, data: unknown): void {
    state.saves[slot] = { data, idem: rid() };
    persist();
    kick();
  }

  async function flushEvents(): Promise<void> {
    // Freeze the accumulated events into an immutable in-flight batch with a
    // stable key. A retry (a later flush) resends THIS batch under THIS key, so
    // the server dedupes it; track()s that arrive meanwhile accrue in state.events
    // and become the next batch. On a confirmed 2xx the batch is dropped.
    if (!state.batch) {
      if (Object.keys(state.events).length === 0) return;
      state.batch = { events: { ...state.events }, idem: rid() };
      state.events = {};
      persist();
    }
    const events = Object.entries(state.batch.events).map(([name, count]) => ({ name, count }));
    await o.request({
      method: "POST",
      path: "/v1/events",
      auth: "player",
      body: { events },
      idempotencyKey: state.batch.idem,
    });
    state.batch = null;
    persist();
  }
  async function flushSaves(): Promise<void> {
    for (const [slot, item] of Object.entries({ ...state.saves })) {
      await o.request({
        method: "PUT",
        path: `/v1/saves/${slot}`,
        auth: "player",
        body: item.data,
        idempotencyKey: item.idem,
      });
      if (state.saves[slot]?.idem === item.idem) delete state.saves[slot];
      persist();
    }
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      await flushEvents();
      await flushSaves();
    } catch {
      // leave the remainder queued for the next trigger (online/interval/enqueue)
    } finally {
      flushing = false;
    }
  }

  function start(): void {
    if (o.intervalMs && o.intervalMs > 0) {
      timer = setInterval(() => void flush(), o.intervalMs);
      // In Node, unref the background flush timer so it never keeps the process
      // alive (a scripted `await tg.login(); …` should exit on its own). Browser
      // timers have no unref, so the optional call no-ops there.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    globalThis.addEventListener?.("online", () => void flush());
  }
  function stop(): void {
    if (timer) clearInterval(timer);
  }

  // pending() reports everything not yet confirmed: live events summed with the
  // frozen in-flight batch, so the contract ("what's still queued") is unchanged.
  function pending(): { events: Record<string, number>; saves: State["saves"] } {
    const events = { ...state.events };
    for (const [name, count] of Object.entries(state.batch?.events ?? {}))
      events[name] = (events[name] ?? 0) + count;
    return { events, saves: { ...state.saves } };
  }
  return { track, queueSave, flush, start, stop, pending };
}

export type Outbox = ReturnType<typeof createOutbox>;
