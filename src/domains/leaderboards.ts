// Leaderboards (BE-08): submit a score and read the top / around-me / friends
// slices. Submit returns the caller's best + the current period key (never whether
// a score was shadow-flagged, by design). Reads return ranked entries with the
// public profile fields for rendering.
import { type Ctx, need } from "./ctx";

export interface BoardEntry {
  rank: number;
  player_id: string;
  display_name: string | null;
  handle: string | null;
  avatar_seed: string | null;
  score: number;
  elapsed_ms: number | null;
}
export interface SubmitResult {
  ok: true;
  best_score: number;
  period_key: string;
}
export interface TopResult {
  board: string;
  period_key: string;
  entries: BoardEntry[];
}
export interface AroundResult extends TopResult {
  me: { rank: number | null; score: number; status: string } | null;
}

export function leaderboards(ctx: Ctx) {
  return {
    submit: (board: string, score: number, opts?: { elapsedMs?: number }) =>
      need(
        ctx.request<SubmitResult>({
          method: "POST",
          path: `/v1/leaderboards/${board}/scores`,
          auth: "player",
          body: { score, elapsed_ms: opts?.elapsedMs },
        }),
      ),
    top: (board: string, opts?: { limit?: number; periodKey?: string }) =>
      need(
        ctx.request<TopResult>({
          method: "GET",
          path: `/v1/leaderboards/${board}/top`,
          auth: "pk",
          query: { limit: opts?.limit, period_key: opts?.periodKey },
        }),
      ),
    aroundMe: (board: string, opts?: { window?: number }) =>
      need(
        ctx.request<AroundResult>({
          method: "GET",
          path: `/v1/leaderboards/${board}/around-me`,
          auth: "player",
          query: { window: opts?.window },
        }),
      ),
    friends: (board: string) =>
      need(
        ctx.request<AroundResult>({
          method: "GET",
          path: `/v1/leaderboards/${board}/friends`,
          auth: "player",
        }),
      ),
  };
}
