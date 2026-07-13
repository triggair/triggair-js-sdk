import { describe, expect, it, vi } from "vitest";
import type { RequestSpec } from "../transport";
import type { Ctx } from "./ctx";
import { teams } from "./teams";

function fakeCtx(handler: (spec: RequestSpec) => Promise<unknown>) {
  const request = vi.fn(handler);
  return { ctx: { request } as unknown as Ctx, request };
}

describe("teams domain", () => {
  it("create() POSTs name+tag as the player; get() is pk-only", async () => {
    const { ctx, request } = fakeCtx(async (spec) =>
      spec.path === "/v1/teams"
        ? { team: { id: "tm_1", name: "Crew", tag: "CRW" } }
        : { id: "tm_1", members: [] },
    );
    const c = await teams(ctx).create("Crew", "CRW", { privacy: "open" });
    expect(c.team.id).toBe("tm_1");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/teams",
        auth: "player",
        body: { name: "Crew", tag: "CRW", privacy: "open" },
      }),
    );
    await teams(ctx).get("tm_1");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "GET", path: "/v1/teams/tm_1", auth: "pk" }),
    );
  });

  it("kick()/setRole()/disband() POST the role-gated admin paths", async () => {
    const { ctx, request } = fakeCtx(async () => ({ ok: true }));
    await teams(ctx).kick("tm_1", "p_2");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/teams/tm_1/members/p_2/kick",
        auth: "player",
      }),
    );
    await teams(ctx).setRole("tm_1", "p_2", "admin");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/v1/teams/tm_1/members/p_2/role", body: { role: "admin" } }),
    );
  });

  it("invite()/acceptInvite() POST the invite paths", async () => {
    const { ctx, request } = fakeCtx(async () => ({ invite_id: "ti_1" }));
    await teams(ctx).invite("tm_1", "p_2");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/teams/tm_1/invites",
        body: { invitee_id: "p_2" },
      }),
    );
    await teams(ctx).acceptInvite("ti_1");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/teams/invites/ti_1/accept",
        auth: "player",
      }),
    );
  });

  it("requestJoin()/approveRequest() POST the request paths", async () => {
    const { ctx, request } = fakeCtx(async () => ({ request_id: "tr_1" }));
    await teams(ctx).requestJoin("tm_1");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/v1/teams/tm_1/requests", auth: "player" }),
    );
    await teams(ctx).approveRequest("tm_1", "tr_1");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "POST", path: "/v1/teams/tm_1/requests/tr_1/approve" }),
    );
  });

  it("leaderboard() GETs the board with the agg query param (pk)", async () => {
    const { ctx, request } = fakeCtx(async () => ({
      standings: [{ team_id: "tm_1", value: 150 }],
    }));
    const rows = await teams(ctx).leaderboard("global", { agg: "sum", limit: 10 });
    expect(rows[0]?.value).toBe(150);
    const spec = request.mock.calls[0]?.[0] as { path: string; auth: string };
    expect(spec.auth).toBe("pk");
    expect(spec.path).toContain("/v1/teams/leaderboards/global?");
    expect(spec.path).toContain("agg=sum");
  });
});
