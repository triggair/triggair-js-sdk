// Analytics props events (009 slice 1). A direct, typed way to send custom events with a property
// map — distinct from the count-only `track()` outbox (counts coalesce by name; prop-bearing events
// don't). Props are sanitized + PII-stripped server-side; pass `consent: true` to have them retained
// (without it only the anonymous count is kept, D10). `dropped_props` echoes any PII the server
// dropped so an agent can stop sending it. For pure counters keep using the reliable outbox track().
import { type Ctx, need } from "./ctx";

export type PropValue = string | number | boolean;
export interface AnalyticsEvent {
  name: string;
  props?: Record<string, PropValue>;
  ts?: number; // client unix seconds; clamped server-side
}
export interface EventsResult {
  ok: true;
  dropped_props?: string[];
  agent_hint?: string;
}

export function analytics(ctx: Ctx) {
  return {
    // Send one or more props events. `consent` gates whether props are retained (D10).
    send: (events: AnalyticsEvent[], opts?: { consent?: boolean }) =>
      need(
        ctx.request<EventsResult>({
          method: "POST",
          path: "/v1/events",
          auth: "player",
          body: { events, consent: opts?.consent ?? false },
        }),
      ),
    // Convenience for a single event.
    event: (
      name: string,
      props?: Record<string, PropValue>,
      opts?: { ts?: number; consent?: boolean },
    ) =>
      need(
        ctx.request<EventsResult>({
          method: "POST",
          path: "/v1/events",
          auth: "player",
          body: {
            events: [{ name, ...(props ? { props } : {}), ...(opts?.ts ? { ts: opts.ts } : {}) }],
            consent: opts?.consent ?? false,
          },
        }),
      ),
  };
}
