// A/B experiments (feature #3) — player-authed. `assign(key)` buckets the player into a
// variant (deterministic + sticky server-side, so the same player always gets the same
// branch across sessions and devices) and logs the exposure once; `track(key, metric?)`
// records their conversion. Fail-safe (D4): if the experiment is unknown / not running /
// the player isn't targeted, assign resolves to `{ variant: null, in_experiment: false }`
// — treat that as the control branch and ship your default. Authoring is dashboard/MCP.
import { type Ctx, need } from "./ctx";

export interface Assignment {
  key: string;
  /** The bucketed variant name, or null when the player isn't in the experiment. */
  variant: string | null;
  in_experiment: boolean;
}
export interface TrackResult {
  ok: true;
  /** Whether this call recorded a (first) conversion for an enrolled player. */
  counted: boolean;
}

export function experiments(ctx: Ctx) {
  return {
    /** Bucket the player into a variant (sticky) and log the exposure. On any error it
     *  degrades to the control branch ({ variant: null, in_experiment: false }). */
    assign: async (key: string): Promise<Assignment> => {
      try {
        const res = await ctx.request<Assignment>({
          method: "POST",
          path: `/v1/experiments/${key}/assign`,
          auth: "player",
        });
        return res ?? { key, variant: null, in_experiment: false };
      } catch {
        return { key, variant: null, in_experiment: false };
      }
    },
    /** Record a conversion for this player. `metric` names the goal reached; it counts
     *  when it matches the experiment's measured metric (omit to match the primary one). */
    track: (key: string, metric?: string): Promise<TrackResult> =>
      need(
        ctx.request<TrackResult>({
          method: "POST",
          path: `/v1/experiments/${key}/track`,
          auth: "player",
          body: metric ? { metric } : {},
        }),
      ),
  };
}
