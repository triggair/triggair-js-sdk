// Storage / custom entities (BD-15, design-doc 014) — the catch-all keyed JSON document
// store. Player-scoped with optimistic-concurrency: get() returns {value, version}; pass
// that version back as `ifMatch` on put() to guard against the lost-update race
// (storage_conflict on mismatch — GET, merge, retry once). Cross-player reads need the
// collection to be read_policy public/authenticated.
import { type Ctx, need } from "./ctx";

export interface StoredDoc {
  value: unknown;
  version: number;
}
const enc = (s: string) => encodeURIComponent(s);

export function storage(ctx: Ctx) {
  return {
    /** The caller's own document (`storage_conflict`-safe via the returned version). */
    get: (collection: string, key: string): Promise<StoredDoc> =>
      need(
        ctx.request<StoredDoc>({
          method: "GET",
          path: `/v1/storage/${enc(collection)}/${enc(key)}`,
          auth: "player",
        }),
      ),
    /** Another player's document — only if the collection is public/authenticated-readable. */
    getOther: (collection: string, key: string, ownerId: string): Promise<StoredDoc> =>
      need(
        ctx.request<StoredDoc>({
          method: "GET",
          path: `/v1/storage/${enc(collection)}/${enc(key)}`,
          auth: "player",
          query: { owner: ownerId },
        }),
      ),
    /** Write the caller's document. Pass `ifMatch` (the last version) to make it OCC-safe. */
    put: (
      collection: string,
      key: string,
      value: unknown,
      opts: { ifMatch?: number } = {},
    ): Promise<{ version: number }> =>
      need(
        ctx.request<{ version: number }>({
          method: "PUT",
          path: `/v1/storage/${enc(collection)}/${enc(key)}`,
          auth: "player",
          body: value,
          ...(opts.ifMatch !== undefined ? { ifMatch: opts.ifMatch } : {}),
        }),
      ),
    delete: (collection: string, key: string): Promise<{ deleted: boolean }> =>
      need(
        ctx.request<{ deleted: boolean }>({
          method: "DELETE",
          path: `/v1/storage/${enc(collection)}/${enc(key)}`,
          auth: "player",
        }),
      ),
    /** Atomically bump a numeric field (race-free, no read-modify-write). */
    incr: (collection: string, key: string, field: string, by = 1): Promise<StoredDoc> =>
      need(
        ctx.request<StoredDoc>({
          method: "POST",
          path: `/v1/storage/${enc(collection)}/${enc(key)}/mutate`,
          auth: "player",
          body: { op: "incr", field, value: by },
        }),
      ),
    /** Atomically append to an array field (race-free). */
    append: (collection: string, key: string, field: string, value: unknown): Promise<StoredDoc> =>
      need(
        ctx.request<StoredDoc>({
          method: "POST",
          path: `/v1/storage/${enc(collection)}/${enc(key)}/mutate`,
          auth: "player",
          body: { op: "append", field, value },
        }),
      ),
    /** Shared (game-global) documents (D4). One authoritative doc per (collection, key) for
     *  the whole game. Read is gated by read_policy; a pk `put` only works if the collection
     *  is write_policy:player (else `storage_forbidden` — seed it server-side instead). */
    shared: {
      get: (collection: string, key: string): Promise<StoredDoc> =>
        need(
          ctx.request<StoredDoc>({
            method: "GET",
            path: `/v1/storage/shared/${enc(collection)}/${enc(key)}`,
            auth: "player",
          }),
        ),
      put: (
        collection: string,
        key: string,
        value: unknown,
        opts: { ifMatch?: number } = {},
      ): Promise<{ version: number }> =>
        need(
          ctx.request<{ version: number }>({
            method: "PUT",
            path: `/v1/storage/shared/${enc(collection)}/${enc(key)}`,
            auth: "player",
            body: value,
            ...(opts.ifMatch !== undefined ? { ifMatch: opts.ifMatch } : {}),
          }),
        ),
    },
    /** Team-owned (cooperative clan/guild) documents. The caller must be a member of the
     *  team to write/delete (and to read a private collection); OCC like all storage docs. */
    team: {
      get: (teamId: string, collection: string, key: string): Promise<StoredDoc> =>
        need(
          ctx.request<StoredDoc>({
            method: "GET",
            path: `/v1/storage/team/${enc(teamId)}/${enc(collection)}/${enc(key)}`,
            auth: "player",
          }),
        ),
      put: (
        teamId: string,
        collection: string,
        key: string,
        value: unknown,
        opts: { ifMatch?: number } = {},
      ): Promise<{ version: number }> =>
        need(
          ctx.request<{ version: number }>({
            method: "PUT",
            path: `/v1/storage/team/${enc(teamId)}/${enc(collection)}/${enc(key)}`,
            auth: "player",
            body: value,
            ...(opts.ifMatch !== undefined ? { ifMatch: opts.ifMatch } : {}),
          }),
        ),
      delete: (teamId: string, collection: string, key: string): Promise<{ deleted: boolean }> =>
        need(
          ctx.request<{ deleted: boolean }>({
            method: "DELETE",
            path: `/v1/storage/team/${enc(teamId)}/${enc(collection)}/${enc(key)}`,
            auth: "player",
          }),
        ),
      list: async (
        teamId: string,
        collection: string,
      ): Promise<{ key: string; version: number }[]> =>
        (
          await need(
            ctx.request<{ keys: { key: string; version: number }[] }>({
              method: "GET",
              path: `/v1/storage/team/${enc(teamId)}/${enc(collection)}`,
              auth: "player",
            }),
          )
        ).keys,
    },
    /** The caller's keys in a collection. */
    list: async (collection: string): Promise<{ key: string; version: number }[]> =>
      (
        await need(
          ctx.request<{ keys: { key: string; version: number }[] }>({
            method: "GET",
            path: `/v1/storage/${enc(collection)}`,
            auth: "player",
          }),
        )
      ).keys,
  };
}
