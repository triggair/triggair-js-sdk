// Economy wallet reads (BD-05). Read-only from the client: balances (materialized)
// and the player's own ledger history. There is deliberately no grant/spend here —
// currency only enters a wallet through a server-authoritative path (a reward, a
// validated purchase, or the operator grant), never from a publishable key.
import { type Ctx, need } from "./ctx";

export interface Balance {
  currency: string;
  balance: number;
}
export interface LedgerLine {
  id: string;
  txn_id: string;
  target: string;
  delta: number;
  balance_after: number;
  created_at: string;
}
export interface History {
  lines: LedgerLine[];
  next_cursor: string | null;
}
export interface InventoryEntry {
  item_id: string;
  qty: number;
  equipped: boolean;
  expires_at: string | null;
}
export interface StoreSummary {
  key: string;
  name: string;
}
export interface StoreListing {
  id: string;
  item_id: string;
  grant_qty: number;
  price: { currency: string; amount: number }[];
  purchase_limit: number | null;
  stock: number | null;
  sort: number;
}
export interface TxnResult {
  kind: "applied" | "replay";
  txn_id: string;
  lines?: { target: string; delta: number; balance_after: number }[];
}
export interface LootResult {
  kind: "opened" | "replay";
  txn_id: string;
  result?: { target: string; amount: number };
  lines?: { target: string; delta: number; balance_after: number }[];
}
export interface LootOdds {
  target: string;
  weight: number;
  probability: number;
}
export interface EnergyStatus {
  meter: string;
  current: number;
  max: number;
  regen_period_sec: number;
  next_regen_at: string | null;
  full_at: string | null;
}

// A fresh idempotency key per user action; a call's transport retries reuse the
// same body (so a retried buy/consume never double-applies). Caller can override.
const newIdem = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `idem_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;

export function economy(ctx: Ctx) {
  return {
    /** All of the player's currency balances. */
    wallet: async (): Promise<Balance[]> =>
      (
        await need(
          ctx.request<{ balances: Balance[] }>({
            method: "GET",
            path: "/v1/wallet",
            auth: "player",
          }),
        )
      ).balances,
    /** One currency's balance (0 if never granted). */
    balance: async (currency: string): Promise<Balance> =>
      need(ctx.request<Balance>({ method: "GET", path: `/v1/wallet/${currency}`, auth: "player" })),
    /** The player's own ledger history (newest first), cursor-paged. */
    history: async (opts: { limit?: number; cursor?: string } = {}): Promise<History> =>
      need(
        ctx.request<History>({
          method: "GET",
          path: "/v1/wallet/history",
          auth: "player",
          query: {
            ...(opts.limit ? { limit: opts.limit } : {}),
            ...(opts.cursor ? { cursor: opts.cursor } : {}),
          },
        }),
      ),
    /** Owned item stacks (qty>0, non-expired). */
    inventory: async (): Promise<InventoryEntry[]> =>
      (
        await need(
          ctx.request<{ items: InventoryEntry[] }>({
            method: "GET",
            path: "/v1/inventory",
            auth: "player",
          }),
        )
      ).items,
    /** The game's open storefronts. */
    stores: async (): Promise<StoreSummary[]> =>
      (
        await need(
          ctx.request<{ stores: StoreSummary[] }>({
            method: "GET",
            path: "/v1/stores",
            auth: "player",
          }),
        )
      ).stores,
    /** A store's current listings. */
    listings: async (storeKey: string): Promise<StoreListing[]> =>
      (
        await need(
          ctx.request<{ listings: StoreListing[] }>({
            method: "GET",
            path: `/v1/stores/${storeKey}`,
            auth: "player",
          }),
        )
      ).listings,
    /** Buy a listing — atomic spend-currency → grant-item. Idempotent: a retry with
     *  the same key never double-charges (a fresh key is generated per call). */
    buy: (storeKey: string, listingId: string, opts: { idem?: string } = {}): Promise<TxnResult> =>
      need(
        ctx.request<TxnResult>({
          method: "POST",
          path: `/v1/stores/${storeKey}/buy`,
          auth: "player",
          body: { listing_id: listingId, idempotency_key: opts.idem ?? newIdem() },
        }),
      ),
    /** Consume a consumable from inventory (fail-closed on insufficient qty). */
    consume: (itemId: string, qty: number, opts: { idem?: string } = {}): Promise<TxnResult> =>
      need(
        ctx.request<TxnResult>({
          method: "POST",
          path: `/v1/inventory/${itemId}/consume`,
          auth: "player",
          body: { qty, idempotency_key: opts.idem ?? newIdem() },
        }),
      ),
    /** Equip an equippable item (enforces one item per equip_slot). */
    equip: (itemId: string): Promise<{ ok: boolean; equipped: boolean }> =>
      need(
        ctx.request<{ ok: boolean; equipped: boolean }>({
          method: "POST",
          path: `/v1/inventory/${itemId}/equip`,
          auth: "player",
        }),
      ),
    /** Unequip an item. */
    unequip: (itemId: string): Promise<{ ok: boolean; equipped: boolean }> =>
      need(
        ctx.request<{ ok: boolean; equipped: boolean }>({
          method: "POST",
          path: `/v1/inventory/${itemId}/unequip`,
          auth: "player",
        }),
      ),
    loot: {
      /** Disclosed drop odds (D10) — no player token needed. */
      odds: async (key: string): Promise<LootOdds[]> =>
        (
          await need(
            ctx.request<{ odds: LootOdds[] }>({
              method: "GET",
              path: `/v1/loot/${key}/odds`,
              auth: "pk",
            }),
          )
        ).odds,
      /** Open a loot box — the server rolls and grants. Blocked for a minor/unknown-age
       *  player (013 age gate). Idempotent: a retry with the same key never re-rolls. */
      open: (key: string, opts: { idem?: string } = {}): Promise<LootResult> =>
        need(
          ctx.request<LootResult>({
            method: "POST",
            path: `/v1/loot/${key}/open`,
            auth: "player",
            body: { idempotency_key: opts.idem ?? newIdem() },
          }),
        ),
    },
    gifts: {
      /** Send a tradable item to another player — it escrows into their inbox, which
       *  they claim with tg.inbox.claim(). One-directional; idempotent (auto-idem). */
      send: (
        to: string,
        item: string,
        opts: { qty?: number; idem?: string } = {},
      ): Promise<{
        kind: "sent" | "replay";
        txn_id: string;
        to?: string;
        item?: string;
        qty?: number;
      }> =>
        need(
          ctx.request({
            method: "POST",
            path: "/v1/gifts",
            auth: "player",
            body: {
              to,
              item,
              ...(opts.qty ? { qty: opts.qty } : {}),
              idempotency_key: opts.idem ?? newIdem(),
            },
          }),
        ),
    },
    energy: {
      /** All configured meters with their current value + server-time regen countdown. */
      all: async (): Promise<EnergyStatus[]> =>
        (
          await need(
            ctx.request<{ meters: EnergyStatus[] }>({
              method: "GET",
              path: "/v1/energy",
              auth: "player",
            }),
          )
        ).meters,
      /** One meter's current value (ticks off SERVER time, never Date.now()). */
      get: (meter: string): Promise<EnergyStatus> =>
        need(
          ctx.request<EnergyStatus>({ method: "GET", path: `/v1/energy/${meter}`, auth: "player" }),
        ),
      /** Spend energy (the authoritative gate; fail-closed out_of_energy). Idempotent. */
      spend: (meter: string, amount: number, opts: { idem?: string } = {}): Promise<EnergyStatus> =>
        need(
          ctx.request<EnergyStatus>({
            method: "POST",
            path: `/v1/energy/${meter}/spend`,
            auth: "player",
            body: { amount, idempotency_key: opts.idem ?? newIdem() },
          }),
        ),
      /** Refill to full by spending the configured currency price (one atomic txn). */
      refill: (meter: string, opts: { idem?: string } = {}): Promise<EnergyStatus> =>
        need(
          ctx.request<EnergyStatus>({
            method: "POST",
            path: `/v1/energy/${meter}/refill`,
            auth: "player",
            body: { idempotency_key: opts.idem ?? newIdem() },
          }),
        ),
    },
  };
}
