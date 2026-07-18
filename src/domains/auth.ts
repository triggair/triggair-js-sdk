// Player accounts & login (BE-18 / design-doc 016). The credential layer is a dedicated Supabase
// (triggair-players) project; this module drives its GoTrue REST directly (zero deps) for
// email/password, then exchanges the session with the worker's POST /v1/players/session for the usual
// per-game player token. First login LINKS the current anonymous player; a real conflict returns a
// `merge` choice (keep the account's data, or replace it with the anonymous progress). The account
// survives the 24h player-token expiry via a re-exchange wired into identity. Anonymous stays default.
import type { Auth, Minted } from "../identity";
import type { RequestSpec } from "../transport";

type Requester = <T>(spec: RequestSpec) => Promise<T | undefined>;
interface KV {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

interface AuthConfig {
  supabase_url: string | null;
  anon_key: string | null;
  providers: string[];
}
interface SessionResult {
  player_id: string;
  token: string;
  expires_in: number;
  outcome: string;
  merge?: { ticket: string; account_player: { id: string }; anonymous_player: { id: string } };
}
interface SbSession {
  access_token: string;
  refresh_token: string;
}

export interface LoginResult {
  playerId: string;
  /** resumed | adopted | linked | created | conflict */
  outcome: string;
  /** Present only on `conflict` — call resolveMerge() to pick. */
  merge?: { accountPlayerId: string; anonymousPlayerId: string };
}

export function createAuthApi(o: {
  request: Requester;
  fetchImpl: typeof fetch;
  key: string;
  identity: Auth;
  storage: KV;
  namespace: string;
}) {
  const ns = o.namespace;
  let cfg: AuthConfig | null = null;
  let pendingTicket: string | null = null;
  const listeners = new Set<() => void>();
  const fire = () => {
    for (const l of listeners) l();
  };

  async function config(): Promise<AuthConfig> {
    if (!cfg)
      cfg = (await o.request<AuthConfig>({
        method: "GET",
        path: "/v1/players/auth-config",
        auth: "pk",
      })) as AuthConfig;
    return cfg;
  }

  function loadSb(): SbSession | null {
    try {
      const raw = o.storage.get(`${ns}sb`);
      return raw ? (JSON.parse(raw) as SbSession) : null;
    } catch {
      return null;
    }
  }
  function storeSb(s: SbSession | null): void {
    if (s)
      o.storage.set(
        `${ns}sb`,
        JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token }),
      );
    else o.storage.remove(`${ns}sb`);
  }

  // A GoTrue call against the triggair-players project (apikey = its public anon key).
  async function goTrue<T>(path: string, body: unknown, accessToken?: string): Promise<T> {
    const c = await config();
    if (!c.supabase_url || !c.anon_key)
      throw new Error("Player accounts are not enabled for this game.");
    const res = await o.fetchImpl(`${c.supabase_url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: c.anon_key,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok)
      throw new Error(
        String(
          data.error_description ||
            data.msg ||
            data.message ||
            data.error ||
            `auth error ${res.status}`,
        ),
      );
    return data as T;
  }

  async function sessionExchange(accessToken: string): Promise<SessionResult> {
    return (await o.request<SessionResult>({
      method: "POST",
      path: "/v1/players/session",
      auth: "pk",
      bearer: accessToken,
      body: { device_id: o.identity.deviceId() },
    })) as SessionResult;
  }

  // Adopt a Supabase session → a player token, and wire the re-exchange so a later token (re)mint
  // refreshes the Supabase session instead of falling back to anonymous.
  async function adoptSession(sb: SbSession): Promise<LoginResult> {
    storeSb(sb);
    o.identity.setReexchange(async (): Promise<Minted> => {
      const cur = loadSb();
      if (!cur) throw new Error("No account session to refresh.");
      const refreshed = await goTrue<SbSession>("/auth/v1/token?grant_type=refresh_token", {
        refresh_token: cur.refresh_token,
      });
      storeSb(refreshed);
      const s = await sessionExchange(refreshed.access_token);
      return { player_id: s.player_id, token: s.token, expires_in: s.expires_in };
    });
    const s = await sessionExchange(sb.access_token);
    o.identity.adopt({ player_id: s.player_id, token: s.token, expires_in: s.expires_in });
    pendingTicket = s.outcome === "conflict" && s.merge ? s.merge.ticket : null;
    fire();
    return {
      playerId: s.player_id,
      outcome: s.outcome,
      ...(s.merge
        ? {
            merge: {
              accountPlayerId: s.merge.account_player.id,
              anonymousPlayerId: s.merge.anonymous_player.id,
            },
          }
        : {}),
    };
  }

  return {
    /** Providers this game offers players (empty ⇒ accounts off; hide the login UI). */
    providers: async (): Promise<string[]> => (await config()).providers,
    /** Register email/password. With email confirmation on (default), returns { needsConfirmation }. */
    signUp: async (email: string, password: string): Promise<{ needsConfirmation: boolean }> => {
      const r = await goTrue<{ access_token?: string }>("/auth/v1/signup", { email, password });
      return { needsConfirmation: !r.access_token };
    },
    /** Sign in with email/password and exchange for a player token. */
    signInWithPassword: (email: string, password: string): Promise<LoginResult> =>
      goTrue<SbSession>("/auth/v1/token?grant_type=password", { email, password }).then(
        adoptSession,
      ),
    /** Email a password-reset link. */
    sendPasswordReset: async (email: string): Promise<void> => {
      await goTrue("/auth/v1/recover", { email });
    },
    /** Resolve a login conflict: keep the account's data, or replace it with the anonymous progress. */
    resolveMerge: async (
      choice: "keep_account" | "use_anonymous",
    ): Promise<{ playerId: string }> => {
      if (!pendingTicket) throw new Error("No pending merge to resolve.");
      const s = (await o.request<SessionResult>({
        method: "POST",
        path: "/v1/players/session/merge",
        auth: "pk",
        bearer: loadSb()?.access_token,
        body: { ticket: pendingTicket, choice },
      })) as SessionResult;
      pendingTicket = null;
      o.identity.adopt({ player_id: s.player_id, token: s.token, expires_in: s.expires_in });
      fire();
      return { playerId: s.player_id };
    },
    /** Sign out: clear the account session and rotate to a fresh anonymous identity. */
    signOut: async (): Promise<void> => {
      const sb = loadSb();
      if (sb) {
        try {
          await goTrue("/auth/v1/logout", {}, sb.access_token);
        } catch {
          /* best-effort — the local session is cleared regardless */
        }
      }
      storeSb(null);
      pendingTicket = null;
      o.identity.rotateDevice();
      fire();
    },
    /** Fired whenever the player identity switches (login/merge/signOut) — refetch player resources. */
    onIdentityChanged: (cb: () => void): (() => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
