// Player inbox (BE-12): list messages, mark read, and claim rewards. Claim is the
// one hardened exactly-once grant path — safe to retry; a no-op returns
// `applied:false` with a reason rather than throwing.
import { type Ctx, need } from "./ctx";

export interface InboxItem {
  id: string;
  kind: string;
  body: unknown;
  rewards: unknown;
  read: boolean;
  claimed: boolean;
  claimable: boolean;
  created_at: string;
  expires_at: string | null;
}
export type ClaimResult =
  | { applied: true; rewards: unknown; stats: { key: string; value: number }[] }
  | { applied: false; reason: "already_claimed" | "no_rewards" | "expired"; rewards: unknown };

export function inbox(ctx: Ctx) {
  return {
    list: async (opts?: { limit?: number }): Promise<InboxItem[]> =>
      (
        await need(
          ctx.request<{ inbox: InboxItem[] }>({
            method: "GET",
            path: "/v1/inbox",
            auth: "player",
            query: { limit: opts?.limit },
          }),
        )
      ).inbox,
    read: async (id: string): Promise<void> => {
      await ctx.request({ method: "POST", path: `/v1/inbox/${id}/read`, auth: "player" });
    },
    /** Claim rewards (exactly-once, safe to retry). */
    claim: (id: string) =>
      need(
        ctx.request<ClaimResult>({ method: "POST", path: `/v1/inbox/${id}/claim`, auth: "player" }),
      ),
  };
}
