// Web Push (feature #4) — browser-first. `subscribe()` fetches the game's VAPID public key,
// asks the browser's push service for a PushSubscription (via a service-worker registration),
// and registers it server-side; `unsubscribe()` reverses it. The actual notifications are sent
// from the dashboard / MCP to a player, a segment, or everyone. Minors are refused at subscribe
// (the server's behavioral_push compliance gate throws parental_consent_required / age_*).
import { type Ctx, need } from "./ctx";

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function push(ctx: Ctx) {
  /** The game's VAPID public key (the applicationServerKey), base64url. */
  const vapidKey = async (): Promise<string> =>
    (
      await need(
        ctx.request<{ key: string }>({ method: "GET", path: "/v1/push/vapid-key", auth: "pk" }),
      )
    ).key;

  return {
    vapidKey,
    /** Subscribe this device to push. Pass a ServiceWorkerRegistration, or rely on
     *  navigator.serviceWorker.ready. Refused server-side for minors (compliance). */
    subscribe: async (registration?: ServiceWorkerRegistration) => {
      const reg =
        registration ??
        (typeof navigator !== "undefined" ? await navigator.serviceWorker?.ready : undefined);
      if (!reg?.pushManager)
        throw new Error(
          "Web Push needs a service worker — register one and pass its registration to subscribe().",
        );
      const key = await vapidKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast past the TS 5.7+ `Uint8Array<ArrayBufferLike>` vs `BufferSource` variance quirk —
        // the raw key bytes are exactly what pushManager.subscribe expects at runtime.
        applicationServerKey: b64urlToBytes(key) as BufferSource,
      });
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      await need(
        ctx.request<{ ok: true }>({
          method: "POST",
          path: "/v1/push/subscribe",
          auth: "player",
          body: {
            endpoint: json.endpoint,
            keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
          },
        }),
      );
      return sub;
    },
    /** Unsubscribe this device (server-side + in the browser). */
    unsubscribe: async (registration?: ServiceWorkerRegistration): Promise<boolean> => {
      const reg =
        registration ??
        (typeof navigator !== "undefined" ? await navigator.serviceWorker?.ready : undefined);
      const sub = await reg?.pushManager?.getSubscription();
      if (!sub) return false;
      await ctx
        .request({
          method: "POST",
          path: "/v1/push/unsubscribe",
          auth: "player",
          body: { endpoint: sub.endpoint },
        })
        .catch(() => undefined);
      return sub.unsubscribe();
    },
  };
}
