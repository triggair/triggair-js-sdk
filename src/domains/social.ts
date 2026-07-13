// Social (BE-09): the friend state machine (request/auto-accept, remove, block),
// listing friends + incoming requests, and share links (mint a code carrying
// context, resolve one — the invitee may not have a token yet, so resolve is
// pk-only).
import { type Ctx, need } from "./ctx";

export interface FriendProfile {
  id: string;
  display_name: string | null;
  handle: string | null;
  avatar_seed: string | null;
}
export interface Share {
  code: string;
  player_id: string;
  context: unknown;
  created_at: string;
  expires_at: string | null;
}

export function social(ctx: Ctx) {
  return {
    friends: async (): Promise<FriendProfile[]> =>
      (
        await need(
          ctx.request<{ friends: FriendProfile[] }>({
            method: "GET",
            path: "/v1/friends",
            auth: "player",
          }),
        )
      ).friends,
    requests: async (): Promise<FriendProfile[]> =>
      (
        await need(
          ctx.request<{ requests: FriendProfile[] }>({
            method: "GET",
            path: "/v1/friends/requests",
            auth: "player",
          }),
        )
      ).requests,
    /** Request or auto-accept a friendship → the resulting state. */
    request: (id: string) =>
      need(
        ctx.request<{ state: "pending" | "accepted" }>({
          method: "POST",
          path: `/v1/friends/${id}`,
          auth: "player",
        }),
      ),
    remove: async (id: string): Promise<void> => {
      await ctx.request({ method: "DELETE", path: `/v1/friends/${id}`, auth: "player" });
    },
    block: (id: string) =>
      need(
        ctx.request<{ state: "blocked" }>({
          method: "POST",
          path: `/v1/friends/${id}/block`,
          auth: "player",
        }),
      ),
    /** Mint a share code carrying arbitrary context (≤ 4 KB). */
    share: (context?: Record<string, unknown>, opts?: { expiresInSeconds?: number }) =>
      need(
        ctx.request<{ code: string; expires_at: string | null }>({
          method: "POST",
          path: "/v1/share",
          auth: "player",
          body: { context, expires_in_seconds: opts?.expiresInSeconds },
        }),
      ),
    /** Resolve a share code (pk-only — the invitee may be tokenless). */
    resolveShare: (code: string) =>
      need(ctx.request<Share>({ method: "GET", path: `/v1/share/${code}`, auth: "pk" })),
  };
}
