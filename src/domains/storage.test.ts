import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import type { Ctx } from "./ctx";
import { storage } from "./storage";

function fakeCtx(handler: (spec: RequestSpec) => Promise<unknown>) {
  const request = vi.fn(handler);
  return { ctx: { request } as unknown as Ctx, request };
}

describe("storage domain", () => {
  it("put() sends the value + ifMatch (OCC); get() reads as the player", async () => {
    const { ctx, request } = fakeCtx(async (spec) =>
      spec.method === "PUT" ? { version: 2 } : { value: { hp: 100 }, version: 1 },
    );
    const w = await storage(ctx).put("world", "room1", { hp: 90 }, { ifMatch: 1 });
    expect(w.version).toBe(2);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        path: "/v1/storage/world/room1",
        auth: "player",
        body: { hp: 90 },
        ifMatch: 1,
      }),
    );
    const g = await storage(ctx).get("world", "room1");
    expect(g.version).toBe(1);
  });

  it("incr()/append() POST the mutate op", async () => {
    const { ctx, request } = fakeCtx(async () => ({ value: { count: 5 }, version: 1 }));
    await storage(ctx).incr("counters", "daily", "count", 5);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/storage/counters/daily/mutate",
        body: { op: "incr", field: "count", value: 5 },
      }),
    );
    await storage(ctx).append("counters", "daily", "log", "x");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { op: "append", field: "log", value: "x" } }),
    );
  });

  it("getOther() passes the owner query param", async () => {
    const { ctx, request } = fakeCtx(async () => ({ value: {}, version: 1 }));
    await storage(ctx).getOther("profiles", "card", "p_2");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/v1/storage/profiles/card",
        query: { owner: "p_2" },
      }),
    );
  });
});
