// Promo codes (BD-03, design-doc 008 §10) — the one player-facing code write. Campaign
// authoring + minting are sk/MCP only. Redeem is fail-closed: on error, error.code is
// one of code_invalid | code_expired | code_already_redeemed | code_campaign_exhausted |
// code_wrong_audience — none are retryable. The reward is granted through the ledger.
import { type Ctx, need } from "./ctx";

export interface RedeemResult {
  redeemed: boolean;
  campaign: string;
  granted: { target: string; delta: number; balance_after: number }[];
}

export function codes(ctx: Ctx) {
  return {
    /** Redeem a promo code → grants its reward. Exactly-once (a retry never double-grants). */
    redeem: (code: string): Promise<RedeemResult> =>
      need(
        ctx.request<RedeemResult>({
          method: "POST",
          path: "/v1/codes/redeem",
          auth: "player",
          body: { code },
        }),
      ),
  };
}
