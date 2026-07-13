import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import type { Ctx } from "./ctx";
import { quests } from "./quests";

function fakeCtx(handler: (spec: RequestSpec) => Promise<unknown>) {
  const request = vi.fn(handler);
  return { ctx: { request } as unknown as Ctx, request };
}

describe("quests domain", () => {
  it("list() reads the player's quests; claim() POSTs the key as the player", async () => {
    const { ctx, request } = fakeCtx(async (spec) =>
      spec.path === "/v1/quests"
        ? { quests: [{ key: "rich", name: "Rich", state: "completed", progress: [] }] }
        : { claimed: true, reward: { stats: [{ key: "xp", amount: 50 }] } },
    );
    expect((await quests(ctx).list())[0]?.state).toBe("completed");
    const c = await quests(ctx).claim("rich");
    expect(c.claimed).toBe(true);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "POST", path: "/v1/quests/rich/claim", auth: "player" }),
    );
  });
});
