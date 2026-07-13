// Anonymous-first identity (§3.4). A random opaque device id is generated once and
// persisted; it's exchanged for a 24h player token via POST /players/anonymous
// (the same call silently refreshes — an existing device is never quota/Turnstile
// gated, §8.3). Tokens are cached with an expiry margin and re-minted lazily or on
// a 401; concurrent needs share ONE in-flight mint (single-flight). A recovery
// code rescues the same player on a fresh device. The token provider for transport.
import type { RequestSpec } from "./transport";

type Requester = <T>(spec: RequestSpec) => Promise<T | undefined>;
interface KV {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}
interface Minted {
  player_id: string;
  token: string;
  expires_in: number;
}
interface Cached {
  token: string;
  playerId: string;
  exp: number;
}

function randomId(bytes: number): string {
  const a = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createAuth(o: {
  request: Requester;
  storage: KV;
  namespace: string;
  marginSec?: number;
}) {
  const ns = o.namespace;
  const margin = (o.marginSec ?? 60) * 1000;
  let mem = load();
  let inflight: Promise<string> | null = null;

  function load(): Cached | null {
    try {
      const raw = o.storage.get(`${ns}token`);
      return raw ? (JSON.parse(raw) as Cached) : null;
    } catch {
      return null;
    }
  }
  function persist(m: Minted): string {
    mem = { token: m.token, playerId: m.player_id, exp: Date.now() + m.expires_in * 1000 };
    o.storage.set(`${ns}token`, JSON.stringify(mem));
    return m.token;
  }
  function deviceId(): string {
    let d = o.storage.get(`${ns}device`);
    if (!d) {
      d = randomId(16);
      o.storage.set(`${ns}device`, d);
    }
    return d;
  }
  async function mint(): Promise<string> {
    const m = await o.request<Minted>({
      method: "POST",
      path: "/v1/players/anonymous",
      auth: "pk",
      body: { device_id: deviceId() },
    });
    return persist(m as Minted);
  }
  function fresh(): string | null {
    return mem && mem.exp - margin > Date.now() ? mem.token : null;
  }
  function single(): Promise<string> {
    if (!inflight)
      inflight = mint().finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    /** A valid token, minting/refreshing lazily. */
    token: async (): Promise<string | null> => fresh() ?? (await single()),
    /** Force a re-mint (called by transport on a 401). */
    refresh: async (): Promise<string | null> => {
      mem = null;
      return single();
    },
    /** Ensure a session and return the player id. */
    login: async (): Promise<{ playerId: string }> => {
      await (fresh() ? Promise.resolve() : single());
      return { playerId: mem?.playerId ?? "" };
    },
    get playerId(): string | null {
      return mem?.playerId ?? null;
    },
    /** Mint a single-use recovery code (player-scoped). */
    mintRecoveryCode: () =>
      o.request<{ code: string; expires_at: string }>({
        method: "POST",
        path: "/v1/players/me/recovery-code",
        auth: "player",
      }),
    /** Consume a recovery code on this device → same player, new token. */
    recover: async (code: string): Promise<{ playerId: string }> => {
      const m = (await o.request<Minted>({
        method: "POST",
        path: "/v1/players/recover",
        auth: "pk",
        body: { code, device_id: deviceId() },
      })) as Minted;
      persist(m);
      return { playerId: m.player_id };
    },
    /** Drop the cached token (keeps the device identity). */
    logout: (): void => {
      mem = null;
      o.storage.remove(`${ns}token`);
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
