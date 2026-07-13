// Async / turn-based matches (BD-04, design-doc 004) — a complete turn-based multiplayer
// backend with no realtime socket. Create a match, submit a turn (the server enforces turn
// order + optimistic concurrency via `version`, and notifies the next player in their inbox),
// read state, or forfeit. The game owns the `state` shape.
import { type Ctx, need } from "./ctx";

export interface AsyncMatch {
  id: string;
  type: string;
  turn_order: string[];
  current_turn: string | null;
  state: unknown;
  version: number;
  turn_number: number;
  status: "active" | "complete" | "forfeited" | "expired";
  winner: string | null;
}
const enc = (s: string) => encodeURIComponent(s);

export function asyncMatch(ctx: Ctx) {
  return {
    /** Create a turn-based match. Include yourself in `players`; the first player moves first. */
    create: (
      players: string[],
      opts: { type?: string; state?: unknown } = {},
    ): Promise<{ match: AsyncMatch }> =>
      need(
        ctx.request<{ match: AsyncMatch }>({
          method: "POST",
          path: "/v1/async",
          auth: "player",
          body: { players, ...opts },
        }),
      ),
    /** The match state — participants only. */
    get: (id: string): Promise<{ match: AsyncMatch }> =>
      need(
        ctx.request<{ match: AsyncMatch }>({
          method: "GET",
          path: `/v1/async/${enc(id)}`,
          auth: "player",
        }),
      ),
    /** The caller's active matches. */
    mine: async (): Promise<AsyncMatch[]> =>
      (
        await need(
          ctx.request<{ matches: AsyncMatch[] }>({
            method: "GET",
            path: "/v1/async/mine",
            auth: "player",
          }),
        )
      ).matches,
    /** Submit your turn: pass the `version` you last saw + the new `state`. `not_your_turn` if
     *  it isn't your turn; `async_conflict` if the version is stale. `end:{winner}` finishes it. */
    turn: (
      id: string,
      move: { version: number; state: unknown; next?: string; end?: { winner?: string } },
    ): Promise<{ match: AsyncMatch }> =>
      need(
        ctx.request<{ match: AsyncMatch }>({
          method: "POST",
          path: `/v1/async/${enc(id)}/turn`,
          auth: "player",
          body: move,
        }),
      ),
    /** Forfeit — the win goes to the opponent (in a 2-player match) and the match ends. */
    forfeit: (id: string): Promise<{ forfeited: boolean; winner: string | null }> =>
      need(
        ctx.request<{ forfeited: boolean; winner: string | null }>({
          method: "POST",
          path: `/v1/async/${enc(id)}/forfeit`,
          auth: "player",
        }),
      ),
  };
}
