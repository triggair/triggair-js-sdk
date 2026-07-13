// The economy domain is a thin read layer over the wallet routes; assert each
// method hits the right path as the player and threads query params. (The ledger
// semantics live server-side, proven in the worker suite.)
import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import type { Ctx } from "./ctx";
import { economy } from "./economy";

function fakeCtx(responses: Record<string, unknown>) {
  const request = vi.fn((spec: RequestSpec) => Promise.resolve(responses[spec.path]));
  return { ctx: { request } as unknown as Ctx, request };
}

describe("economy domain", () => {
  it("wallet() GETs /v1/wallet as the player and returns balances", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/wallet": { balances: [{ currency: "gold", balance: 42 }] },
    });
    expect(await economy(ctx).wallet()).toEqual([{ currency: "gold", balance: 42 }]);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/v1/wallet", auth: "player" }),
    );
  });

  it("balance(currency) GETs the per-currency path", async () => {
    const { ctx, request } = fakeCtx({ "/v1/wallet/gold": { currency: "gold", balance: 7 } });
    expect(await economy(ctx).balance("gold")).toEqual({ currency: "gold", balance: 7 });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: "/v1/wallet/gold" }));
  });

  it("history() threads limit + cursor as query params", async () => {
    const { ctx, request } = fakeCtx({ "/v1/wallet/history": { lines: [], next_cursor: null } });
    await economy(ctx).history({ limit: 10, cursor: "el_9" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/wallet/history", query: { limit: 10, cursor: "el_9" } }),
    );
  });

  it("inventory() / stores() / listings() GET the right player-scoped paths", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/inventory": { items: [{ item_id: "sword", qty: 1 }] },
      "/v1/stores": { stores: [{ key: "main", name: "Main" }] },
      "/v1/stores/main": { listings: [] },
    });
    expect(await economy(ctx).inventory()).toEqual([{ item_id: "sword", qty: 1 }]);
    expect(await economy(ctx).stores()).toEqual([{ key: "main", name: "Main" }]);
    await economy(ctx).listings("main");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/stores/main", auth: "player" }),
    );
  });

  it("buy()/consume() POST with an idempotency_key (generated, overridable)", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/stores/main/buy": { kind: "applied", txn_id: "etx_1" },
      "/v1/inventory/potion/consume": { kind: "applied", txn_id: "etx_2" },
    });
    await economy(ctx).buy("main", "sl_1");
    const buyBody = request.mock.calls[0]?.[0].body as {
      listing_id: string;
      idempotency_key: string;
    };
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      path: "/v1/stores/main/buy",
      auth: "player",
    });
    expect(buyBody.listing_id).toBe("sl_1");
    expect(buyBody.idempotency_key).toBeTruthy();

    await economy(ctx).consume("potion", 2, { idem: "fixed" });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: "/v1/inventory/potion/consume",
        body: { qty: 2, idempotency_key: "fixed" },
      }),
    );
  });

  it("equip()/unequip() POST the inventory verb paths as the player", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/inventory/sword/equip": { ok: true, equipped: true },
      "/v1/inventory/sword/unequip": { ok: true, equipped: false },
    });
    expect(await economy(ctx).equip("sword")).toEqual({ ok: true, equipped: true });
    expect(await economy(ctx).unequip("sword")).toEqual({ ok: true, equipped: false });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/inventory/sword/equip",
        auth: "player",
      }),
    );
  });

  it("loot.odds() is pk-only; loot.open() POSTs an idem as the player", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/loot/chest/odds": { odds: [{ target: "item:sword", weight: 100, probability: 1 }] },
      "/v1/loot/chest/open": {
        kind: "opened",
        txn_id: "etx_1",
        result: { target: "item:sword", amount: 1 },
      },
    });
    const o = await economy(ctx).loot.odds("chest");
    expect(o[0]?.target).toBe("item:sword");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/v1/loot/chest/odds", auth: "pk" }),
    );
    const r = await economy(ctx).loot.open("chest", { idem: "fixed" });
    expect(r.result?.target).toBe("item:sword");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/loot/chest/open",
        auth: "player",
        body: { idempotency_key: "fixed" },
      }),
    );
  });

  it("energy.get/spend/refill thread the meter + idem as the player", async () => {
    const { ctx, request } = fakeCtx({
      "/v1/energy/lives": { meter: "lives", current: 3, max: 5 },
      "/v1/energy/lives/spend": { meter: "lives", current: 2, max: 5 },
      "/v1/energy/lives/refill": { meter: "lives", current: 5, max: 5 },
    });
    expect((await economy(ctx).energy.get("lives")).current).toBe(3);
    await economy(ctx).energy.spend("lives", 1, { idem: "fixed" });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/energy/lives/spend",
        auth: "player",
        body: { amount: 1, idempotency_key: "fixed" },
      }),
    );
    expect((await economy(ctx).energy.refill("lives", { idem: "r" })).current).toBe(5);
  });

  it("gifts.send POSTs the recipient + item + idem as the player", async () => {
    const { ctx, request } = fakeCtx({ "/v1/gifts": { kind: "sent", txn_id: "etx_1" } });
    const r = await economy(ctx).gifts.send("p_friend", "sword", { qty: 2, idem: "fixed" });
    expect(r.kind).toBe("sent");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/gifts",
        auth: "player",
        body: { to: "p_friend", item: "sword", qty: 2, idempotency_key: "fixed" },
      }),
    );
  });
});
