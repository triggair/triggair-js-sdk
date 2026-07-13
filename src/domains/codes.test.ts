import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import { codes } from "./codes";
import type { Ctx } from "./ctx";

function fakeCtx(handler: (spec: RequestSpec) => Promise<unknown>) {
  const request = vi.fn(handler);
  return { ctx: { request } as unknown as Ctx, request };
}

describe("codes domain", () => {
  it("redeem() POSTs the code as the player", async () => {
    const { ctx, request } = fakeCtx(async () => ({
      redeemed: true,
      campaign: "launch",
      granted: [],
    }));
    const res = await codes(ctx).redeem("LAUNCH2026");
    expect(res.redeemed).toBe(true);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/codes/redeem",
        auth: "player",
        body: { code: "LAUNCH2026" },
      }),
    );
  });
});
