// Leagues (BD-16, design-doc 012) — tiered divisions over a leaderboard. The player joins
// (placed in the lowest division), reads their division / rank / promotion zone, and can
// browse a division's standings. Ranking reuses the §4.2 board; season advance (promotion/
// relegation) is operator-driven (MCP / dashboard). Scores are submitted via tg.leaderboards.
import { type Ctx, need } from "./ctx";

export interface MyLeague {
  member: boolean;
  season?: number;
  division?: number;
  division_name?: string;
  rank?: number;
  members?: number;
  zone?: "promoting" | "safe" | "relegating";
}
const enc = (s: string) => encodeURIComponent(s);

export function leagues(ctx: Ctx) {
  return {
    /** Join a league — placed in the lowest division for the current season. Idempotent. */
    join: (key: string): Promise<{ joined: boolean }> =>
      need(
        ctx.request<{ joined: boolean }>({
          method: "POST",
          path: `/v1/leagues/${enc(key)}/join`,
          auth: "player",
        }),
      ),
    /** The caller's division, rank, and promotion/relegation zone this season. */
    me: (key: string): Promise<MyLeague> =>
      need(
        ctx.request<MyLeague>({
          method: "GET",
          path: `/v1/leagues/${enc(key)}/me`,
          auth: "player",
        }),
      ),
    /** A division's standings (members ranked on the board). */
    divisionTop: async (
      key: string,
      tier: number,
    ): Promise<{ player_id: string; score: number | null; rank: number }[]> =>
      (
        await need(
          ctx.request<{ standings: { player_id: string; score: number | null; rank: number }[] }>({
            method: "GET",
            path: `/v1/leagues/${enc(key)}/divisions/${tier}/top`,
            auth: "pk",
          }),
        )
      ).standings,
  };
}
