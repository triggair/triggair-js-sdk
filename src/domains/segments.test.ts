import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import type { Ctx } from "./ctx";
import { segments } from "./segments";

function fakeCtx(handler: (spec: RequestSpec) => Promise<unknown>) {
  const request = vi.fn(handler);
  return { ctx: { request } as unknown as Ctx, request };
}

describe("segments domain", () => {
  it("mine() reads the player's memberships (player-auth)", async () => {
    const { ctx, request } = fakeCtx(async () => ({
      segments: [{ segment_id: "seg_1", key: "whales", source: "materialized" }],
    }));
    const res = await segments(ctx).mine();
    expect(res[0]?.key).toBe("whales");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/v1/players/me/segments", auth: "player" }),
    );
  });
});
