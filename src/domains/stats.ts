// Structured player stats (BE-07): a batch of atomic increment/set ops and a read
// of all own stats (both visibilities). Stat keys follow the shared grammar; the
// server clamps and applies the batch atomically.
import { type Ctx, need } from "./ctx";

export interface OwnStat {
  key: string;
  value: number;
  visibility: "public" | "private";
  updated_at: string;
}
export interface StatOp {
  key: string;
  op: "increment" | "set";
  value: number;
  visibility?: "public" | "private";
}

export function stats(ctx: Ctx) {
  return {
    /** All own stats (public + private). */
    get: async (): Promise<OwnStat[]> =>
      (
        await need(
          ctx.request<{ stats: OwnStat[] }>({
            method: "GET",
            path: "/v1/players/me/stats",
            auth: "player",
          }),
        )
      ).stats,
    /** Apply 1–50 increment/set ops atomically; returns the affected stats. */
    update: async (ops: StatOp[]): Promise<OwnStat[]> =>
      (
        await need(
          ctx.request<{ stats: OwnStat[] }>({
            method: "POST",
            path: "/v1/players/me/stats",
            auth: "player",
            body: { stats: ops },
          }),
        )
      ).stats,
  };
}
