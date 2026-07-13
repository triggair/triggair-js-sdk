// Keyed entity boards (BD-16, design-doc 012 §D6): rank arbitrary entities — a team, a UGC item,
// any opaque key — via the materialized standing engine. Submit is player-authenticated (an
// entity_id + score fold into the entity's standing per the board's aggregation); top + entry
// reads are pk-only. Distinct from `leaderboards` (the §4.2 player path). Boards are dev-configured.
import { type Ctx, need } from "./ctx";

export interface KeyedEntry {
  rank: number;
  entity_id: string;
  score: number;
  samples: number;
  entry_meta: Record<string, unknown> | null;
}
export interface KeyedSubmitResult {
  ok: true;
  score: number;
  samples: number;
  period_key: string;
}
export interface KeyedTopResult {
  board: string;
  entity_type: string;
  period_key: string;
  entries: KeyedEntry[];
}
export interface KeyedEntryResult {
  board: string;
  period_key: string;
  entry: KeyedEntry | null;
}

export function keyedBoards(ctx: Ctx) {
  return {
    submit: (
      board: string,
      entityId: string,
      score: number,
      opts?: { entryMeta?: Record<string, unknown> | null },
    ) =>
      need(
        ctx.request<KeyedSubmitResult>({
          method: "POST",
          path: `/v1/boards/${board}/submit`,
          auth: "player",
          body: { entity_id: entityId, score, entry_meta: opts?.entryMeta },
        }),
      ),
    top: (board: string, opts?: { limit?: number; periodKey?: string }) =>
      need(
        ctx.request<KeyedTopResult>({
          method: "GET",
          path: `/v1/boards/${board}/top`,
          auth: "pk",
          query: { limit: opts?.limit, period_key: opts?.periodKey },
        }),
      ),
    entry: (board: string, entityId: string) =>
      need(
        ctx.request<KeyedEntryResult>({
          method: "GET",
          path: `/v1/boards/${board}/entries/${entityId}`,
          auth: "pk",
        }),
      ),
  };
}
