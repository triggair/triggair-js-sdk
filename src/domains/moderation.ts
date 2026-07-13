// Moderation client pre-check (BD-02, design-doc 010 §8). One method: validate a
// name/message against the game's Tier-0 filter BEFORE submitting it, so an agent can
// pick a clean handle without a round-trip failure. Stateless server-side (writes no
// row). Enforcement of the verdict is the caller's job per surface (D4): a
// player_name that returns `block` should be re-prompted; a chat line honors `mask`.
import { type Ctx, need } from "./ctx";

export type Verdict = "allow" | "mask" | "block" | "review";
export interface CheckResult {
  verdict: Verdict;
  masked_text?: string;
  categories: string[];
  severity: number;
  tier: "tier0" | "tier1";
}

export type ReportTarget = "player" | "message" | "ugc" | "name";
export type ReportReason =
  | "harassment"
  | "hate_speech"
  | "spam"
  | "cheating"
  | "sexual_content"
  | "self_harm"
  | "impersonation"
  | "other";
export interface Report {
  id: string;
  state: string;
  target_type: string;
  target_id: string;
  reason: string;
  created_at: string;
}
export interface SelfModeration {
  banned: boolean;
  bans: { id: string; scope: string; kind: string; expires_at: string | null }[];
  restrictions: { id: string; effect: string; expires_at: string | null }[];
}

export function moderation(ctx: Ctx) {
  return {
    /** Pre-validate text for a surface (`player_name`/`team_name`/`chat`/`dm`/`ugc`). */
    check: (surface: string, text: string): Promise<CheckResult> =>
      need(
        ctx.request<CheckResult>({
          method: "POST",
          path: "/v1/moderate/check",
          auth: "player",
          body: { surface, text },
        }),
      ),
    /** Report another player / message / UGC. A duplicate open report is a no-op (409);
     *  treat that as success. Rate-limited per player. */
    report: (
      target_type: ReportTarget,
      target_id: string,
      reason: ReportReason,
      note?: string,
    ): Promise<{ report: Report }> =>
      need(
        ctx.request<{ report: Report }>({
          method: "POST",
          path: "/v1/reports",
          auth: "player",
          body: { target_type, target_id, reason, ...(note ? { note } : {}) },
        }),
      ),
    /** Appeal a ban on this account. Re-appealing a decided ban 409s (don't loop). */
    appeal: (banId: string, body: string): Promise<{ appeal: { id: string; state: string } }> =>
      need(
        ctx.request<{ appeal: { id: string; state: string } }>({
          method: "POST",
          path: "/v1/appeals",
          auth: "player",
          body: { ban_id: banId, body },
        }),
      ),
    /** The caller's own active (non-shadow) bans + restrictions — render "muted until…". */
    myStatus: (): Promise<SelfModeration> =>
      need(
        ctx.request<SelfModeration>({
          method: "GET",
          path: "/v1/players/me/moderation",
          auth: "player",
        }),
      ),
  };
}
