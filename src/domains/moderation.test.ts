// The moderation domain is a thin POST over /v1/moderate/check as the player; assert
// it threads the surface + text and returns the verdict. (Filter semantics live
// server-side, proven in the worker suite.)
import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import type { Ctx } from "./ctx";
import { moderation } from "./moderation";

function fakeCtx(responses: Record<string, unknown>) {
  const request = vi.fn((spec: RequestSpec) => Promise.resolve(responses[spec.path]));
  return { ctx: { request } as unknown as Ctx, request };
}

describe("moderation domain", () => {
  it("check() POSTs the surface + text as the player and returns the verdict", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/moderate/check": {
        verdict: "block",
        categories: ["profanity"],
        severity: 2,
        tier: "tier0",
      },
    });
    const res = await moderation(ctx).check("player_name", "xX_shit_Xx");
    expect(res.verdict).toBe("block");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/moderate/check",
        auth: "player",
        body: { surface: "player_name", text: "xX_shit_Xx" },
      }),
    );
  });

  it("report() POSTs the target + reason as the player", async () => {
    const { ctx, request } = fakeCtx({ "/v1/reports": { report: { id: "rp_1", state: "open" } } });
    const res = await moderation(ctx).report("player", "p_bad", "harassment", "in chat");
    expect(res.report.id).toBe("rp_1");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/reports",
        auth: "player",
        body: { target_type: "player", target_id: "p_bad", reason: "harassment", note: "in chat" },
      }),
    );
  });

  it("appeal() POSTs the ban_id + body as the player", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/appeals": { appeal: { id: "ap_1", state: "pending" } },
    });
    const res = await moderation(ctx).appeal("bn_1", "wasn't me");
    expect(res.appeal.id).toBe("ap_1");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/appeals",
        auth: "player",
        body: { ban_id: "bn_1", body: "wasn't me" },
      }),
    );
  });

  it("myStatus() GETs the self-moderation view as the player", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/players/me/moderation": { banned: false, bans: [], restrictions: [] },
    });
    expect(await moderation(ctx).myStatus()).toEqual({ banned: false, bans: [], restrictions: [] });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/v1/players/me/moderation", auth: "player" }),
    );
  });
});
