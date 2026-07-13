// Cloud saves (BE-06): OCC-versioned per-slot blobs. `put` writes immediately and
// returns the new version (pass `ifMatch` for a conflict-safe write → throws
// save_conflict on a lost race; omit for last-write-wins). `queue` hands the write
// to the durable outbox instead — it survives a dropped connection and replays on
// reconnect (last-write-wins per slot), for saves that must not be lost.
import { type Ctx, need } from "./ctx";

export interface SaveRef {
  slot: string;
  version: number;
  updated_at: string;
}
export interface SaveMeta extends SaveRef {
  size: number;
}
export interface SaveFull extends SaveRef {
  data: unknown;
}

export function saves(ctx: Ctx) {
  return {
    list: async (): Promise<SaveMeta[]> =>
      (
        await need(
          ctx.request<{ saves: SaveMeta[] }>({ method: "GET", path: "/v1/saves", auth: "player" }),
        )
      ).saves,
    get: (slot: string) =>
      need(ctx.request<SaveFull>({ method: "GET", path: `/v1/saves/${slot}`, auth: "player" })),
    /** Write now; `ifMatch` opts into OCC (409 save_conflict on mismatch). */
    put: (slot: string, data: unknown, opts?: { ifMatch?: number }): Promise<SaveRef> =>
      need(
        ctx.request<SaveRef>({
          method: "PUT",
          path: `/v1/saves/${slot}`,
          auth: "player",
          body: data,
          ifMatch: opts?.ifMatch,
        }),
      ),
    /** Durable write — queued to the outbox, replayed on reconnect (LWW). */
    queue: (slot: string, data: unknown): void => ctx.outbox.queueSave(slot, data),
    remove: async (slot: string): Promise<void> => {
      await ctx.request({ method: "DELETE", path: `/v1/saves/${slot}`, auth: "player" });
    },
  };
}
