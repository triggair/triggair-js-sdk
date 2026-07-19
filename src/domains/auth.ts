// Player accounts & login (BE-18, BE-21). Every credential call goes through the Triggair worker —
// signup, password login, token refresh, password reset, logout, and the Google OAuth start — so the
// SDK only ever talks to api.triggair.com; the identity provider is never contacted or named here. The
// worker returns the account session (kept client-side, in storage) AND the per-game player token. A
// first login LINKS the current anonymous player; a real conflict returns a `merge` choice. The login
// survives token/session expiry via a re-exchange wired into identity. Anonymous stays the default.
import type { Auth, Minted } from "../identity";
import type { RequestSpec } from "../transport";

type Requester = <T>(spec: RequestSpec) => Promise<T | undefined>;
interface KV {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

interface AuthConfig {
  providers: string[];
}
interface AccountSession {
  access_token: string;
  refresh_token: string;
}
interface ExchangeResult {
  player_id: string;
  token: string;
  expires_in: number;
  outcome: string;
  merge?: { ticket: string; account_player: { id: string }; anonymous_player: { id: string } };
}
type LoginResponse = ExchangeResult & { session: AccountSession };

export interface LoginResult {
  playerId: string;
  /** resumed | adopted | linked | created | conflict */
  outcome: string;
  /** Present only on `conflict` — call resolveMerge() to pick. */
  merge?: { accountPlayerId: string; anonymousPlayerId: string };
}

export function createAuthApi(o: {
  request: Requester;
  apiBase: string;
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
  const post = <T>(path: string, body: unknown, bearer?: string): Promise<T | undefined> =>
    o.request<T>({ method: "POST", path, auth: "pk", body, ...(bearer ? { bearer } : {}) });

  async function config(): Promise<AuthConfig> {
    if (!cfg)
      cfg = (await o.request<AuthConfig>({
        method: "GET",
        path: "/v1/players/auth-config",
        auth: "pk",
      })) as AuthConfig;
    return cfg;
  }

  function loadSb(): AccountSession | null {
    try {
      const raw = o.storage.get(`${ns}sb`);
      return raw ? (JSON.parse(raw) as AccountSession) : null;
    } catch {
      return null;
    }
  }
  function storeSb(s: AccountSession | null): void {
    if (s)
      o.storage.set(
        `${ns}sb`,
        JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token }),
      );
    else o.storage.remove(`${ns}sb`);
  }

  // Where the confirm/reset email link should land — defaults to the current game page. Must be one of
  // the game's allowlisted origins, else the link falls back to triggair.com.
  function emailRedirect(opts?: { emailRedirectTo?: string }): string | undefined {
    const loc = (globalThis as { location?: { origin: string; pathname: string } }).location;
    return opts?.emailRedirectTo ?? (loc ? `${loc.origin}${loc.pathname}` : undefined);
  }

  // Exchange an account session (Bearer) for a player token — used by the Google callback flow.
  async function exchangeSession(accessToken: string): Promise<ExchangeResult> {
    return (await post<ExchangeResult>(
      "/v1/players/session",
      { device_id: o.identity.deviceId() },
      accessToken,
    )) as ExchangeResult;
  }

  // A token (re)mint for a logged-in player: refresh the account session AND re-mint the player token
  // in one worker call — so the account survives the 24h token expiry AND a reload (re-armed at init).
  async function reexchange(): Promise<Minted> {
    const cur = loadSb();
    if (!cur) throw new Error("No account session to refresh.");
    const res = (await post<LoginResponse>("/v1/players/token/refresh", {
      refresh_token: cur.refresh_token,
      device_id: o.identity.deviceId(),
    })) as LoginResponse;
    storeSb(res.session);
    return { player_id: res.player_id, token: res.token, expires_in: res.expires_in };
  }

  // Restore a persisted session on construction, so a reload keeps the player signed in.
  if (loadSb()) o.identity.setReexchange(reexchange);

  // Adopt an account session + its exchange result: store the session, wire re-exchange, adopt the
  // player token, and surface any merge conflict.
  function adopt(session: AccountSession | null, r: ExchangeResult): LoginResult {
    if (session) storeSb(session);
    o.identity.setReexchange(reexchange);
    o.identity.adopt({ player_id: r.player_id, token: r.token, expires_in: r.expires_in });
    pendingTicket = r.outcome === "conflict" && r.merge ? r.merge.ticket : null;
    fire();
    return {
      playerId: r.player_id,
      outcome: r.outcome,
      ...(r.merge
        ? {
            merge: {
              accountPlayerId: r.merge.account_player.id,
              anonymousPlayerId: r.merge.anonymous_player.id,
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
     *  if a session is issued immediately the player is signed in. `emailRedirectTo` (default: the
     *  current game page) is where the confirmation link lands — it must be an allowlisted origin. */
    signUp: async (
      email: string,
      password: string,
      opts?: { emailRedirectTo?: string },
    ): Promise<{ needsConfirmation: boolean }> => {
      const res = (await post<{
        needs_confirmation: boolean;
        session?: AccountSession;
        player?: ExchangeResult;
      }>("/v1/players/signup", {
        email,
        password,
        device_id: o.identity.deviceId(),
        redirect_to: emailRedirect(opts),
      })) as { needs_confirmation: boolean; session?: AccountSession; player?: ExchangeResult };
      if (res.session && res.player) adopt(res.session, res.player);
      return { needsConfirmation: res.needs_confirmation };
    },
    /** Sign in with email/password and exchange for a player token. */
    signInWithPassword: async (email: string, password: string): Promise<LoginResult> => {
      const res = (await post<LoginResponse>("/v1/players/login", {
        email,
        password,
        device_id: o.identity.deviceId(),
      })) as LoginResponse;
      return adopt(res.session, res);
    },
    /** Sign in with Google via a popup + the centralized OAuth callback. Must be called from a user
     *  gesture (click) or the browser blocks the popup. Resolves like signInWithPassword. */
    signInWithGoogle: async (): Promise<LoginResult> => {
      const g = globalThis as typeof globalThis & { open?: typeof window.open };
      if (typeof g.open !== "function" || typeof g.location === "undefined")
        throw new Error("signInWithGoogle requires a browser environment.");
      const c = await config();
      if (!c.providers.includes("google"))
        throw new Error("Google sign-in is not enabled for this game.");
      const apiOrigin = new URL(o.apiBase).origin;
      // The whole OAuth flow runs on the worker (PKCE): the popup starts at api.triggair.com, the
      // worker exchanges the code server-side, and the callback (also on api.triggair.com) posts the
      // session back. So the trusted postMessage origin is the API origin — never the provider's.
      const startUrl = `${o.apiBase.replace(/\/$/, "")}/v1/players/oauth/google/start?key=${encodeURIComponent(o.key)}&origin=${encodeURIComponent(g.location.origin)}`;
      const popup = g.open(
        startUrl,
        "tg-google-signin",
        "width=480,height=720,menubar=no,toolbar=no",
      );
      if (!popup) throw new Error("Popup blocked — call signInWithGoogle() from a click handler.");

      const session = await new Promise<AccountSession>((resolve, reject) => {
        const cleanup = () => {
          g.removeEventListener("message", onMsg);
          g.clearInterval(poll);
        };
        const onMsg = (e: MessageEvent) => {
          if (e.origin !== apiOrigin || e.source !== popup) return; // only our callback popup
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
      const r = adopt(session, await exchangeSession(session.access_token));
      popup.close();
      return r;
    },
    /** Email a password-reset link. `emailRedirectTo` (default: the current game page) is where the
     *  link lands; it must be an allowlisted origin, else it falls back to triggair.com. */
    sendPasswordReset: async (
      email: string,
      opts?: { emailRedirectTo?: string },
    ): Promise<void> => {
      await post("/v1/players/password-reset", { email, redirect_to: emailRedirect(opts) });
    },
    /** Resolve a login conflict: keep the account's data, or replace it with the anonymous progress. */
    resolveMerge: async (
      choice: "keep_account" | "use_anonymous",
    ): Promise<{ playerId: string }> => {
      if (!pendingTicket) throw new Error("No pending merge to resolve.");
      const s = (await post<ExchangeResult>(
        "/v1/players/session/merge",
        { ticket: pendingTicket, choice },
        loadSb()?.access_token,
      )) as ExchangeResult;
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
          await post("/v1/players/logout", {}, sb.access_token); // best-effort revoke
        } catch {
          /* the local session is cleared regardless */
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
