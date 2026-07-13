// Battle pass / seasons (BD-12, design-doc 003 D6) — the player reads their season progress
// (battle points, tier, per-lane claim state) and claims an earned tier's reward into the
// inbox (the "tap to collect"). BP and tiers are server-owned — there is no client write.
// Season config + premium grants are operator (MCP / dashboard).
import { type Ctx, need } from "./ctx";

export interface BattlePass {
  season_key: string;
  name: string;
  state: "scheduled" | "active" | "ended";
  bp: number;
  tier: number;
  has_premium: boolean;
  claimed_free: number[];
  claimed_premium: number[];
  tiers: { tier: number; bp_required: number }[];
  starts_at: string;
  ends_at: string;
}
const enc = (s: string) => encodeURIComponent(s);

export function battlePass(ctx: Ctx) {
  return {
    /** The player's progress in a season (BP, tier, which tiers/lanes are claimed). */
    get: (season: string): Promise<BattlePass> =>
      need(
        ctx.request<BattlePass>({
          method: "GET",
          path: `/v1/battle-pass/${enc(season)}`,
          auth: "player",
        }),
      ),
    /** Claim an earned tier's reward on a lane → it lands in the inbox. `tier_not_earned` /
     *  `premium_required` if not eligible; an already-claimed tier is a no-op {claimed:false}. */
    claim: (
      season: string,
      tier: number,
      lane: "free" | "premium" = "free",
    ): Promise<{ claimed: boolean; reason?: string; reward?: unknown }> =>
      need(
        ctx.request<{ claimed: boolean; reason?: string; reward?: unknown }>({
          method: "POST",
          path: `/v1/battle-pass/${enc(season)}/claim`,
          auth: "player",
          body: { tier, lane },
        }),
      ),
  };
}
