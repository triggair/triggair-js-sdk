// Daily rewards & streaks (BE-11): read status (is a claim available today?) and
// claim. Claim is server-time-gated and exactly-once per server-day — a same-day
// re-claim throws `conflict`. The reward is escrowed to the inbox.
import { type Ctx, need } from "./ctx";

export interface DailyStatus {
  streak_count: number;
  longest_streak: number;
  last_claim_day: string | null;
  claimable: boolean;
  server_day: string;
  day_index: number;
  cycle_length: number;
  next_reward: unknown;
}
export interface DailyClaim {
  claimed: true;
  streak_count: number;
  longest_streak: number;
  day_index: number;
  reward: unknown;
}

export function daily(ctx: Ctx) {
  return {
    status: () =>
      need(ctx.request<DailyStatus>({ method: "GET", path: "/v1/daily", auth: "player" })),
    /** Claim today's reward (409 conflict if already claimed today). */
    claim: () =>
      need(ctx.request<DailyClaim>({ method: "POST", path: "/v1/daily/claim", auth: "player" })),
  };
}
