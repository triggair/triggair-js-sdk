import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import type { Ctx } from "./ctx";
import { tournaments } from "./tournaments";

function fakeCtx(handler: (spec: RequestSpec) => Promise<unknown>) {
  const request = vi.fn(handler);
  return { ctx: { request } as unknown as Ctx, request };
}

describe("tournaments domain", () => {
  it("list()/get()/standings() read with the pk; join()/me() use the player token", async () => {
    const { ctx, request } = fakeCtx(async (spec) => {
      if (spec.path === "/v1/tournaments") return { tournaments: [{ key: "cup" }] };
      if (spec.path.endsWith("/standings")) return { standings: [{ player_id: "p1", rank: 1 }] };
      if (spec.path.endsWith("/join")) return { joined: true, fee_txn: "etx_1" };
      if (spec.path.endsWith("/me")) return { entered: true, rank: 1 };
      return { key: "cup", status: "running" };
    });
    const t = tournaments(ctx);

    expect(await t.list()).toEqual([{ key: "cup" }]);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "GET", path: "/v1/tournaments", auth: "pk" }),
    );

    expect((await t.get("cup")).status).toBe("running");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/v1/tournaments/cup", auth: "pk" }),
    );

    expect(await t.standings("cup", { limit: 5 })).toEqual([{ player_id: "p1", rank: 1 }]);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/v1/tournaments/cup/standings", query: { limit: "5" } }),
    );

    expect((await t.join("cup")).joined).toBe(true);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "POST", path: "/v1/tournaments/cup/join", auth: "player" }),
    );

    expect((await t.me("cup")).rank).toBe(1);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "GET", path: "/v1/tournaments/cup/me", auth: "player" }),
    );
  });
});
