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
  oauth_callback: string | null;
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

  // Where GoTrue should send the player after they click a confirm/reset link. Without this the link
  // lands on the players project's site_url (triggair.com) instead of the game. Defaults to the
  // current game page; an explicit value must be in the players project's uri_allow_list or GoTrue
  // ignores it and falls back to site_url (so a non-allowlisted dev origin is no worse than before).
  function emailRedirectQuery(opts?: { emailRedirectTo?: string }): string {
    const loc = (globalThis as { location?: { origin: string; pathname: string } }).location;
    const to = opts?.emailRedirectTo ?? (loc ? `${loc.origin}${loc.pathname}` : undefined);
    return to ? `?redirect_to=${encodeURIComponent(to)}` : "";
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

  // A token (re)mint for a logged-in player: refresh the Supabase session, then re-exchange it for a
  // fresh player token — so the account survives the 24h token expiry AND a page reload (this is
  // re-armed at init below when a stored session exists), instead of falling back to anonymous.
  async function reexchange(): Promise<Minted> {
    const cur = loadSb();
    if (!cur) throw new Error("No account session to refresh.");
    const refreshed = await goTrue<SbSession>("/auth/v1/token?grant_type=refresh_token", {
      refresh_token: cur.refresh_token,
    });
    storeSb(refreshed);
    const s = await sessionExchange(refreshed.access_token);
    return { player_id: s.player_id, token: s.token, expires_in: s.expires_in };
  }

  // Restore a persisted session on construction, so a reload keeps the player signed in.
  if (loadSb()) o.identity.setReexchange(reexchange);

  // Adopt a Supabase session → a player token, and wire the re-exchange so a later token (re)mint
  // refreshes the Supabase session instead of falling back to anonymous.
  async function adoptSession(sb: SbSession): Promise<LoginResult> {
    storeSb(sb);
    o.identity.setReexchange(reexchange);
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
    /** True if a player is currently signed in with an account (survives reloads). */
    isSignedIn: (): boolean => loadSb() !== null,
    /** The signed-in player's email (decoded from the session), or null. Best-effort, unverified. */
    email: (): string | null => {
      const sb = loadSb();
      if (!sb) return null;
      try {
        const seg = sb.access_token.split(".")[1] ?? "";
        const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
        const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const claims = JSON.parse(atob(pad)) as { email?: string };
        return typeof claims.email === "string" ? claims.email : null;
      } catch {
        return null;
      }
    },
    /** Register email/password. With email confirmation on (default), returns { needsConfirmation };
     *  the confirmation link returns the player to `emailRedirectTo` (defaults to the current game
     *  page) — it must be in the game's allowlisted origins, else it falls back to triggair.com. */
    signUp: async (
      email: string,
      password: string,
      opts?: { emailRedirectTo?: string },
    ): Promise<{ needsConfirmation: boolean }> => {
      const r = await goTrue<{ access_token?: string }>(
        `/auth/v1/signup${emailRedirectQuery(opts)}`,
        { email, password },
      );
      return { needsConfirmation: !r.access_token };
    },
    /** Sign in with email/password and exchange for a player token. */
    signInWithPassword: (email: string, password: string): Promise<LoginResult> =>
      goTrue<SbSession>("/auth/v1/token?grant_type=password", { email, password }).then(
        adoptSession,
      ),
    /** Sign in with Google via a popup + the centralized OAuth callback (BE-19). Must be called from
     *  a user gesture (click) or the browser blocks the popup. Resolves like signInWithPassword. */
    signInWithGoogle: async (): Promise<LoginResult> => {
      const g = globalThis as typeof globalThis & { open?: typeof window.open };
      if (typeof g.open !== "function" || typeof g.location === "undefined")
        throw new Error("signInWithGoogle requires a browser environment.");
      const c = await config();
      if (!c.supabase_url || !c.oauth_callback)
        throw new Error("Google sign-in is not configured for this game.");
      if (!c.providers.includes("google"))
        throw new Error("Google sign-in is not enabled for this game.");
      const callbackOrigin = new URL(c.oauth_callback).origin;
      // Pass the game origin AND the pk so the callback can verify (server-side) that this origin is in
      // the game's allowlist before it releases the session — an attacker can't redirect it elsewhere.
      const redirectTo = `${c.oauth_callback}?origin=${encodeURIComponent(g.location.origin)}&key=${encodeURIComponent(o.key)}`;
      const url = `${c.supabase_url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
      const popup = g.open(url, "tg-google-signin", "width=480,height=720,menubar=no,toolbar=no");
      if (!popup) throw new Error("Popup blocked — call signInWithGoogle() from a click handler.");

      const session = await new Promise<SbSession>((resolve, reject) => {
        const cleanup = () => {
          g.removeEventListener("message", onMsg);
          g.clearInterval(poll);
        };
        const onMsg = (e: MessageEvent) => {
          if (e.origin !== callbackOrigin || e.source !== popup) return; // only our callback popup
          const d = e.data as {
            type?: string;
            access_token?: string;
            refresh_token?: string;
            error?: string;
          };
          if (d?.type === "tg-oauth" && d.access_token) {
            cleanup();
            resolve({ access_token: d.access_token, refresh_token: d.refresh_token ?? "" });
          } else if (d?.type === "tg-oauth-error") {
            cleanup();
            reject(new Error(d.error || "Google sign-in failed."));
          }
        };
        g.addEventListener("message", onMsg);
        // Reject if the user closes the popup without finishing.
        const poll = g.setInterval(() => {
          if (popup.closed) {
            cleanup();
            reject(new Error("Sign-in was cancelled."));
          }
        }, 500);
      });
      const r = await adoptSession(session);
      popup.close();
      return r;
    },
    /** Email a password-reset link. `emailRedirectTo` (default: the current game page) is where the
     *  link lands; it must be in the game's allowlisted origins, else it falls back to triggair.com. */
    sendPasswordReset: async (
      email: string,
      opts?: { emailRedirectTo?: string },
    ): Promise<void> => {
      await goTrue(`/auth/v1/recover${emailRedirectQuery(opts)}`, { email });
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
