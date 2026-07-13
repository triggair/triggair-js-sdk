import { describe, expect, it } from "vitest";
import { createOutbox } from "./outbox";
import { memoryStorage } from "./storage";
import type { RequestSpec } from "./transport";

function recorder(fail = false) {
  const calls: RequestSpec[] = [];
  const request = (async (spec: RequestSpec) => {
    calls.push(spec);
    if (fail) throw new Error("offline");
    return {};
  }) as <T>(s: RequestSpec) => Promise<T | undefined>;
  return { calls, request };
}
// Fails the first `failTimes` requests, then succeeds — models a dropped flush.
function flakyRecorder(failTimes: number) {
  const calls: RequestSpec[] = [];
  let n = 0;
  const request = (async (spec: RequestSpec) => {
    calls.push(spec);
    if (n++ < failTimes) throw new Error("offline");
    return {};
  }) as <T>(s: RequestSpec) => Promise<T | undefined>;
  return { calls, request };
}
const opts = (request: ReturnType<typeof recorder>["request"], storage = memoryStorage()) => ({
  request,
  storage,
  namespace: "t:",
  intervalMs: 0,
  online: () => false, // no auto-flush; tests flush explicitly
});

describe("outbox", () => {
  it("coalesces events by name and flushes one batch", async () => {
    const r = recorder();
    const ob = createOutbox(opts(r.request));
    ob.track("hit");
    ob.track("hit", 3);
    ob.track("miss");
    await ob.flush();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.path).toBe("/v1/events");
    const body = r.calls[0]?.body as { events: { name: string; count: number }[] };
    expect(body.events).toEqual(
      expect.arrayContaining([
        { name: "hit", count: 4 },
        { name: "miss", count: 1 },
      ]),
    );
    expect(r.calls[0]?.idempotencyKey).toMatch(/^idem_/);
    await ob.flush(); // nothing left
    expect(r.calls).toHaveLength(1);
  });

  it("coalesces saves by slot (last write wins) with a stable idem key", async () => {
    const r = recorder();
    const ob = createOutbox(opts(r.request));
    ob.queueSave("slot1", { hp: 1 });
    ob.queueSave("slot1", { hp: 9 });
    await ob.flush();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.path).toBe("/v1/saves/slot1");
    expect(r.calls[0]?.body).toEqual({ hp: 9 });
    expect(r.calls[0]?.idempotencyKey).toMatch(/^idem_/);
  });

  it("persists across a reload and leaves items queued on failure", async () => {
    const store = memoryStorage();
    const bad = recorder(true);
    const ob1 = createOutbox(opts(bad.request, store));
    ob1.track("evt");
    await ob1.flush(); // fails → stays queued + persisted
    expect(bad.calls).toHaveLength(1);

    const good = recorder();
    const ob2 = createOutbox(opts(good.request, store)); // reload from storage
    expect(ob2.pending().events).toEqual({ evt: 1 });
    await ob2.flush();
    expect(good.calls).toHaveLength(1);
    expect(ob2.pending().events).toEqual({});
  });

  it("reuses the SAME idempotency key when a failed events flush is retried", async () => {
    const r = flakyRecorder(1);
    const ob = createOutbox(opts(r.request));
    ob.track("evt", 2);
    await ob.flush(); // fails → frozen batch stays queued
    expect(ob.pending().events).toEqual({ evt: 2 });
    await ob.flush(); // retries the identical batch
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]?.idempotencyKey).toBe(r.calls[1]?.idempotencyKey);
    expect(ob.pending().events).toEqual({});
  });

  it("events tracked during a failed flush form a separate batch with a new key", async () => {
    const r = flakyRecorder(1);
    const ob = createOutbox(opts(r.request));
    ob.track("a", 1);
    await ob.flush(); // batch {a:1} frozen, request fails
    ob.track("b", 1); // accrues behind the in-flight batch
    await ob.flush(); // retries {a:1} under the same key, succeeds
    await ob.flush(); // sends {b:1} as a new batch under a new key
    const bodies = r.calls.map((c) => c.body as { events: { name: string; count: number }[] });
    expect(bodies[0]?.events).toEqual([{ name: "a", count: 1 }]);
    expect(bodies[1]?.events).toEqual([{ name: "a", count: 1 }]); // immutable retry
    expect(r.calls[0]?.idempotencyKey).toBe(r.calls[1]?.idempotencyKey);
    expect(bodies[2]?.events).toEqual([{ name: "b", count: 1 }]);
    expect(r.calls[2]?.idempotencyKey).not.toBe(r.calls[1]?.idempotencyKey);
    expect(ob.pending().events).toEqual({});
  });
});
