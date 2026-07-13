// The compliance domain is a thin wrapper over the age-gate routes; assert it threads
// the right body/auth. Gate semantics live server-side (proven in the worker suite).
import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import { compliance } from "./compliance";
import type { Ctx } from "./ctx";

function fakeCtx(responses: Record<string, unknown>) {
  const request = vi.fn((spec: RequestSpec) => Promise.resolve(responses[spec.path]));
  return { ctx: { request } as unknown as Ctx, request };
}

describe("compliance domain", () => {
  it("setAge() POSTs a bracket as the player", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/players/me/age": { bracket: "adult", gated: { lootbox: false } },
    });
    const res = await compliance(ctx).setAge({ bracket: "adult" });
    expect(res.bracket).toBe("adult");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/players/me/age",
        auth: "player",
        body: { bracket: "adult" },
      }),
    );
  });

  it("setAge() maps a birth year to the snake_case body", async () => {
    const { ctx, request } = fakeCtx({ "/v1/players/me/age": { bracket: "13_15" } });
    await compliance(ctx).setAge({ birthYear: 2012 });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/players/me/age", body: { birth_year: 2012 } }),
    );
  });

  it("status() reads the player's gated map; policy() is pk-only", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/players/me/compliance": { bracket: "unknown", gated: { lootbox: true } },
      "/v1/compliance/policy": { gates: {}, coppa_mode: true, default_jurisdiction: null },
    });
    const status = await compliance(ctx).status();
    expect(status.gated.lootbox).toBe(true);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/players/me/compliance", auth: "player" }),
    );
    await compliance(ctx).policy();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/compliance/policy", auth: "pk" }),
    );
  });

  it("requestConsent() POSTs the parent email as the player; consent() reads the record", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/players/me/consent/request": { id: "pc_1", state: "pending", expires_at: "t" },
      "/v1/players/me/consent": { consent: { id: "pc_1", state: "granted", expires_at: "t" } },
    });
    const r = await compliance(ctx).requestConsent("parent@example.com");
    expect(r.state).toBe("pending");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/players/me/consent/request",
        auth: "player",
        body: { parent_email: "parent@example.com" },
      }),
    );
    const s = await compliance(ctx).consent();
    expect(s.consent?.state).toBe("granted");
  });
});
