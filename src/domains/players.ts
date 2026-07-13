// Player profile methods (BE-04/BE-07): own identity, profile edits, and public
// lookups. `me` is the minimal own identity; `profile`/`lookup` return the public
// card (id, display name, handle, avatar seed, public stats).
import { type Ctx, need } from "./ctx";

export interface ProfileStat {
  key: string;
  value: number;
  updated_at: string;
}
export interface PublicProfile {
  id: string;
  display_name: string | null;
  handle: string | null;
  avatar_seed: string | null;
  created_at: string;
  stats: ProfileStat[];
}
export interface Me {
  id: string;
  created_at: string;
  display_name: string | null;
}
export interface ProfilePatch {
  display_name?: string;
  handle?: string;
  avatar_seed?: string;
}

export function players(ctx: Ctx) {
  return {
    /** Own minimal identity (requires a token). */
    me: () => need(ctx.request<Me>({ method: "GET", path: "/v1/players/me", auth: "player" })),
    /** Update own public profile (at least one field). */
    updateProfile: (patch: ProfilePatch) =>
      need(
        ctx.request<PublicProfile>({
          method: "PATCH",
          path: "/v1/players/me",
          auth: "player",
          body: patch,
        }),
      ),
    /** Public profile by handle. */
    lookup: (handle: string) =>
      need(
        ctx.request<PublicProfile>({
          method: "GET",
          path: "/v1/players",
          auth: "pk",
          query: { handle },
        }),
      ),
    /** Public profile by player id. */
    profile: (id: string) =>
      need(ctx.request<PublicProfile>({ method: "GET", path: `/v1/players/${id}`, auth: "pk" })),
  };
}
