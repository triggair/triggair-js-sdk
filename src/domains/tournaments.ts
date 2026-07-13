// Tournaments (BD-16, design-doc 012) — competitions layered on a leaderboard. Browse +
// detail + standings read with the publishable key; join + `me` need a player token. Scores
// still go through the normal §4.2 submit (`tg.leaderboards.submit`) — a tournament only
// decides which validated scores count and who gets paid. Prizes land in the inbox (claim
// them via `tg.inbox`); there is no client prize-grant. Config/finalize are operator (MCP).
import { type Ctx, need } from "./ctx";

export interface Tournament {
  key: string;
  board: string;
  title: string;
  starts_at: string;
  ends_at: string;
  entry_fee: { currency: { code: string; amount: number }[] } | null;
  reward_table: unknown[];
  status: "scheduled" | "running" | "closed";
}
export interface TournamentStanding {
  player_id: string;
  rank: number;
  score: number;
}
export interface MyTournamentEntry {
  entered: boolean;
  joined_at?: string;
  rank?: number | null;
  prize?: unknown | null;
}
const enc = (s: string) => encodeURIComponent(s);

export function tournaments(ctx: Ctx) {
  return {
    /** Browse the game's tournaments (scheduled / running / closed). */
    list: async (): Promise<Tournament[]> =>
      (
        await need(
          ctx.request<{ tournaments: Tournament[] }>({
            method: "GET",
            path: "/v1/tournaments",
            auth: "pk",
          }),
        )
      ).tournaments,
    /** One tournament's detail (window, reward table, live status). */
    get: (id: string): Promise<Tournament> =>
      need(
        ctx.request<Tournament>({ method: "GET", path: `/v1/tournaments/${enc(id)}`, auth: "pk" }),
      ),
    /** The current standings among entrants (edge-cacheable, top-N). */
    standings: async (id: string, opts: { limit?: number } = {}): Promise<TournamentStanding[]> =>
      (
        await need(
          ctx.request<{ standings: TournamentStanding[] }>({
            method: "GET",
            path: `/v1/tournaments/${enc(id)}/standings`,
            auth: "pk",
            ...(opts.limit !== undefined ? { query: { limit: String(opts.limit) } } : {}),
          }),
        )
      ).standings,
    /** Opt in: pays the entry fee (economy) if any. `already_entered` returns joined:false.
     *  `tournament_not_open`/`tournament_closed` if outside the window; `insufficient_funds`
     *  if the fee can't be charged. */
    join: (id: string): Promise<{ joined: boolean; reason?: string; fee_txn?: string | null }> =>
      need(
        ctx.request<{ joined: boolean; reason?: string; fee_txn?: string | null }>({
          method: "POST",
          path: `/v1/tournaments/${enc(id)}/join`,
          auth: "player",
        }),
      ),
    /** The caller's joined tournaments (active entries). */
    mine: async (): Promise<Tournament[]> =>
      (
        await need(
          ctx.request<{ tournaments: Tournament[] }>({
            method: "GET",
            path: "/v1/tournaments/mine",
            auth: "player",
          }),
        )
      ).tournaments,
    /** The caller's entry: live rank + any prize once the tournament closes (claim via inbox). */
    me: (id: string): Promise<MyTournamentEntry> =>
      need(
        ctx.request<MyTournamentEntry>({
          method: "GET",
          path: `/v1/tournaments/${enc(id)}/me`,
          auth: "player",
        }),
      ),
  };
}
