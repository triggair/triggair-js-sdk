// Achievements (BE-10): the trophy screen and progress reporting. `report` clamps
// server-side and unlocks exactly once; the reward is escrowed to the inbox on
// unlock (never granted here) — `reward_granted` signals a fresh unlock so the game
// can nudge the player to open their inbox.
import { type Ctx, need } from "./ctx";

export interface TrophyItem {
  key: string;
  name: string;
  description: string;
  target: number;
  rewards: unknown;
  secret: boolean;
  progress: number;
  unlocked: boolean;
  unlocked_at: string | null;
}
export interface ReportResult {
  key: string;
  progress: number;
  target: number;
  unlocked: boolean;
  unlocked_at: string | null;
  reward_granted: boolean;
}

export function achievements(ctx: Ctx) {
  return {
    list: async (): Promise<TrophyItem[]> =>
      (
        await need(
          ctx.request<{ achievements: TrophyItem[] }>({
            method: "GET",
            path: "/v1/achievements",
            auth: "player",
          }),
        )
      ).achievements,
    /** Report progress (default increment); returns the new state. */
    report: (key: string, amount: number, opts?: { op?: "increment" | "set" }) =>
      need(
        ctx.request<ReportResult>({
          method: "POST",
          path: `/v1/achievements/${key}/progress`,
          auth: "player",
          body: { amount, op: opts?.op },
        }),
      ),
  };
}
