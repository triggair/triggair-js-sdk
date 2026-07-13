// Remote config + deterministic RNG (BE-13/BE-14), both pk-only game reads. Config
// is the arbitrary tuning blob the developer sets (edge-cached ~10s). RNG returns a
// server-derived seed for a stream+period — `shared` scope is the same for every
// player (daily-challenge format); `player` scope mixes in the caller (needs a
// token). Analytics events go through the outbox, so they live on the client root.
import { type Ctx, need } from "./ctx";

export interface RngSeed {
  stream: string;
  period: string;
  period_key: string;
  scope: "shared" | "player";
  seed: string;
}

export interface LiveEvent {
  key: string;
  name: string;
  ends_at: string | null;
}

export function config(ctx: Ctx) {
  return {
    /** The resolved config document (base + flags + live-event overlays) + `_meta`. */
    get: () =>
      need(ctx.request<Record<string, unknown>>({ method: "GET", path: "/v1/config", auth: "pk" })),
    /** Events live now for the caller (server-time filtered; a token adds targeted ones). */
    liveEvents: async (): Promise<LiveEvent[]> =>
      (
        await need(
          ctx.request<{ events: LiveEvent[] }>({
            method: "GET",
            path: "/v1/liveops/events/live",
            auth: "pk",
          }),
        )
      ).events,
  };
}

export function rng(ctx: Ctx) {
  return {
    /** A deterministic seed for `stream` this period. `player` scope needs a token. */
    seed: (
      stream: string,
      opts?: { period?: "daily" | "weekly" | "all_time"; scope?: "shared" | "player" },
    ) =>
      need(
        ctx.request<RngSeed>({
          method: "GET",
          path: `/v1/rng/${stream}`,
          auth: opts?.scope === "player" ? "player" : "pk",
          query: { period: opts?.period, scope: opts?.scope },
        }),
      ),
  };
}
