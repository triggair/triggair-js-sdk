// Player segment membership (BD-03, design-doc 008 §6) — the caller's own materialized
// segments. Segment DEFINITION/targeting is authoring (sk/MCP), not in the client SDK;
// this read is what a game uses to reflect membership (and it's what personalizes
// tg.config.get() / tg.flags automatically when a token is present).
import { type Ctx, need } from "./ctx";

export interface SegmentMembership {
  segment_id: string;
  key: string;
  source: string;
}

export function segments(ctx: Ctx) {
  return {
    /** The player's segment memberships (key + id + source). */
    mine: async (): Promise<SegmentMembership[]> =>
      (
        await need(
          ctx.request<{ segments: SegmentMembership[] }>({
            method: "GET",
            path: "/v1/players/me/segments",
            auth: "player",
          }),
        )
      ).segments,
  };
}
