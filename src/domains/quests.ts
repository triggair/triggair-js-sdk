// Quests (BD-12, design-doc 003) — the player reads progress and claims. Progress is a
// server-side projection over the stat store; the client can't assert completion. Claim
// pays the reward into the inbox (claim it there). Quest DEFINITION is authoring (sk/MCP).
import { type Ctx, need } from "./ctx";

export interface QuestView {
  key: string;
  name: string;
  /** once = permanent; daily/weekly = recurring (claimable once per period, delta progress). */
  period: string;
  state: "active" | "completed" | "claimed";
  progress: { signal: string; op: string; target: number; current: number; met: boolean }[];
}

export function quests(ctx: Ctx) {
  return {
    /** The player's quests with per-objective progress + state. */
    list: async (): Promise<QuestView[]> =>
      (
        await need(
          ctx.request<{ quests: QuestView[] }>({
            method: "GET",
            path: "/v1/quests",
            auth: "player",
          }),
        )
      ).quests,
    /** Claim a completed quest → its reward lands in the inbox. `quest_not_complete` if
     *  the objectives aren't met; an already-claimed quest is a no-op ({claimed:false}). */
    claim: (key: string): Promise<{ claimed: boolean; reason?: string; reward?: unknown }> =>
      need(
        ctx.request<{ claimed: boolean; reason?: string; reward?: unknown }>({
          method: "POST",
          path: `/v1/quests/${key}/claim`,
          auth: "player",
        }),
      ),
  };
}
