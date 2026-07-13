// Progression / XP levels (BD-12, design-doc 003 D4) — the player reads their cumulative XP
// and computed level. XP is earned through rewards (quests/achievements/inbox stat grants to
// the game's xp_key) — server-authoritative, there is no client XP grant. The curve (how XP
// maps to a level) is operator config (MCP / dashboard).
import { type Ctx, need } from "./ctx";

export interface Progression {
  xp: number;
  level: number;
  xp_into_level: number;
  xp_for_next: number; // 0 at max_level
  max_level: number;
  /** How many level-up rewards were just delivered to the inbox on this read (0 if none). */
  leveled_up: number;
}

export function progression(ctx: Ctx) {
  return {
    /** The player's XP total + level (xp_into_level / xp_for_next toward the next level). */
    get: (): Promise<Progression> =>
      need(ctx.request<Progression>({ method: "GET", path: "/v1/progression", auth: "player" })),
  };
}
