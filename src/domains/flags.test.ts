// The flags domain resolves server-side; assert it threads pk auth and is fail-safe
// (an errored/absent flag read returns the caller's default — D4).
import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import type { Ctx } from "./ctx";
import { flags } from "./flags";

function fakeCtx(handler: (spec: RequestSpec) => Promise<unknown>) {
  const request = vi.fn(handler);
  return { ctx: { request } as unknown as Ctx, request };
}

describe("flags domain", () => {
  it("all() returns the resolved map (pk-only)", async () => {
    const { ctx, request } = fakeCtx(async () => ({
      flags: { new_shop: true },
      _meta: { config_version: 3, flags: {} },
    }));
    expect(await flags(ctx).all()).toEqual({ new_shop: true });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/flags", auth: "pk" }),
    );
  });

  it("get()/bool() return the resolved value", async () => {
    const { ctx } = fakeCtx(async (spec) =>
      spec.path === "/v1/flags/new_shop" ? { key: "new_shop", value: true } : undefined,
    );
    expect(await flags(ctx).get("new_shop", false)).toBe(true);
    expect(await flags(ctx).bool("new_shop")).toBe(true);
  });

  it("get() is fail-safe: a read error / unknown flag → the caller's default (D4)", async () => {
    const { ctx } = fakeCtx(async () => {
      throw new Error("flag_not_found");
    });
    expect(await flags(ctx).get("missing", "fallback")).toBe("fallback");
    expect(await flags(ctx).bool("missing", true)).toBe(true);
  });
});
