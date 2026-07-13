// Feature flags (BD-03, design-doc 008 §11) — pk-only reads resolved server-side on top
// of the base config. `get(key, fallback)` is fail-safe (D4): an undefined/off flag (or
// any read error) resolves to the caller's safe default, so a config hiccup degrades to
// "the game runs with safe defaults", never a brick. `all()` returns the resolved map.
import { type Ctx, need } from "./ctx";

export interface FlagsResult {
  flags: Record<string, unknown>;
  _meta: { config_version: number; flags: Record<string, string> };
}

export function flags(ctx: Ctx) {
  return {
    /** All active flags resolved for this game (killed → safe_value, off → absent). */
    all: async (): Promise<Record<string, unknown>> =>
      (await need(ctx.request<FlagsResult>({ method: "GET", path: "/v1/flags", auth: "pk" })))
        .flags,
    /** One flag's resolved value, falling back to `fallback` if it's absent/off/errored
     *  (D4 fail-safe: an unknown flag 404s and any read error degrades to the default). */
    get: async <T>(key: string, fallback: T): Promise<T> => {
      try {
        const res = await ctx.request<{ key: string; value: T }>({
          method: "GET",
          path: `/v1/flags/${key}`,
          auth: "pk",
        });
        return res ? res.value : fallback;
      } catch {
        return fallback;
      }
    },
    /** Convenience typed reads (2nd arg is the safe default). */
    bool: (key: string, fallback = false): Promise<boolean> =>
      flags(ctx).get<boolean>(key, fallback),
    variant: <T extends string>(key: string, fallback: T): Promise<T> =>
      flags(ctx).get<T>(key, fallback),
  };
}
