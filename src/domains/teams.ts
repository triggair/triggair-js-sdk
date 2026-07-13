// Teams / clans (BD-11, design-doc 001) — player-driven. Create/join/leave/roster + the
// admin actions (kick/role/disband), each role-gated server-side. Errors: team_forbidden
// (role/membership), team_full (per-player cap), conflict (tag taken). Team leaderboards +
// chat + invites are later slices.
import { type Ctx, need } from "./ctx";

export interface Team {
  id: string;
  name: string;
  tag: string;
  privacy: string;
  owner_id: string;
  member_count: number;
  members?: { player_id: string; role: string; joined_at: string }[];
}
export interface TeamStanding {
  team_id: string;
  name: string;
  tag: string;
  value: number;
  members: number;
}

export function teams(ctx: Ctx) {
  const P = (path: string, body?: unknown) =>
    need(ctx.request<unknown>({ method: "POST", path, auth: "player", ...(body ? { body } : {}) }));
  return {
    /** Create a team (caller becomes the owner). The name is filtered server-side. */
    create: (
      name: string,
      tag: string,
      opts: { privacy?: "open" | "closed" | "invite_only" } = {},
    ) =>
      need(
        ctx.request<{ team: Team }>({
          method: "POST",
          path: "/v1/teams",
          auth: "player",
          body: { name, tag, ...(opts.privacy ? { privacy: opts.privacy } : {}) },
        }),
      ),
    /** A team + its roster. */
    get: (id: string): Promise<Team> =>
      need(ctx.request<Team>({ method: "GET", path: `/v1/teams/${id}`, auth: "pk" })),
    /** The caller's team memberships. */
    mine: async (): Promise<{ id: string; name: string; tag: string; role: string }[]> =>
      (
        await need(
          ctx.request<{ teams: { id: string; name: string; tag: string; role: string }[] }>({
            method: "GET",
            path: "/v1/teams/mine",
            auth: "player",
          }),
        )
      ).teams,
    join: (id: string) => P(`/v1/teams/${id}/join`),
    leave: (id: string) => P(`/v1/teams/${id}/leave`),
    /** Kick a member (admin/owner only). */
    kick: (id: string, playerId: string) => P(`/v1/teams/${id}/members/${playerId}/kick`),
    /** Promote/demote a member (owner only). */
    setRole: (id: string, playerId: string, role: "admin" | "member") =>
      P(`/v1/teams/${id}/members/${playerId}/role`, { role }),
    /** Transfer ownership to a member (owner only) — the caller steps down to admin. */
    transfer: (id: string, playerId: string) => P(`/v1/teams/${id}/transfer`, { to: playerId }),
    /** Ban a player from the team (admin/owner) — removed + blocked from every rejoin path. */
    ban: (id: string, playerId: string, reason?: string) =>
      P(`/v1/teams/${id}/members/${playerId}/ban`, reason ? { reason } : {}),
    /** Lift a team ban (admin/owner) so the player can join again. */
    unban: (id: string, playerId: string) => P(`/v1/teams/${id}/members/${playerId}/unban`),
    /** The team's ban list (admin/owner only). */
    bans: async (id: string): Promise<{ player_id: string; reason: string | null }[]> =>
      (
        await need(
          ctx.request<{ bans: { player_id: string; reason: string | null }[] }>({
            method: "GET",
            path: `/v1/teams/${id}/bans`,
            auth: "player",
          }),
        )
      ).bans,
    /** Disband the team (owner only). */
    disband: (id: string) => P(`/v1/teams/${id}/disband`),
    /** Browse/discover teams by an optional name/tag substring (biggest first). */
    browse: async (opts: { q?: string; limit?: number } = {}): Promise<Team[]> => {
      const params = new URLSearchParams();
      if (opts.q) params.set("q", opts.q);
      if (opts.limit) params.set("limit", String(opts.limit));
      const qs = params.toString();
      return (
        await need(
          ctx.request<{ teams: Team[] }>({
            method: "GET",
            path: `/v1/teams${qs ? `?${qs}` : ""}`,
            auth: "pk",
          }),
        )
      ).teams;
    },
    /** Invite a player to the team (admin/owner only). */
    invite: (id: string, playerId: string) =>
      P(`/v1/teams/${id}/invites`, { invitee_id: playerId }),
    /** The caller's pending invites. */
    myInvites: async (): Promise<{ id: string; team_id: string; name: string; tag: string }[]> =>
      (
        await need(
          ctx.request<{ invites: { id: string; team_id: string; name: string; tag: string }[] }>({
            method: "GET",
            path: "/v1/teams/mine/invites",
            auth: "player",
          }),
        )
      ).invites,
    /** Accept a pending invite → join the team. */
    acceptInvite: (inviteId: string) => P(`/v1/teams/invites/${inviteId}/accept`),
    /** Reject a pending invite. */
    rejectInvite: (inviteId: string) => P(`/v1/teams/invites/${inviteId}/reject`),
    /** Request to join a closed team. */
    requestJoin: (id: string) => P(`/v1/teams/${id}/requests`),
    /** Pending join requests for a team (admin/owner only). */
    requests: async (id: string): Promise<{ id: string; player_id: string }[]> =>
      (
        await need(
          ctx.request<{ requests: { id: string; player_id: string }[] }>({
            method: "GET",
            path: `/v1/teams/${id}/requests`,
            auth: "player",
          }),
        )
      ).requests,
    /** Approve a join request (admin/owner only) → the player joins. */
    approveRequest: (id: string, requestId: string) =>
      P(`/v1/teams/${id}/requests/${requestId}/approve`),
    /** Reject a join request (admin/owner only). */
    rejectRequest: (id: string, requestId: string) =>
      P(`/v1/teams/${id}/requests/${requestId}/reject`),
    /** Team leaderboard: teams ranked by their members' aggregated score on `board`. */
    leaderboard: async (
      board: string,
      opts: { agg?: "sum" | "max" | "avg"; period?: string; limit?: number } = {},
    ): Promise<TeamStanding[]> => {
      const q = new URLSearchParams();
      if (opts.agg) q.set("agg", opts.agg);
      if (opts.period) q.set("period", opts.period);
      if (opts.limit) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return (
        await need(
          ctx.request<{ standings: TeamStanding[] }>({
            method: "GET",
            path: `/v1/teams/leaderboards/${board}${qs ? `?${qs}` : ""}`,
            auth: "pk",
          }),
        )
      ).standings;
    },
  };
}
