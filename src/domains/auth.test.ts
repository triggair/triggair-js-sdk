import { describe, expect, it } from "vitest";
import { createClient } from "../client";
import { memoryStorage } from "../storage";

const SB = "https://players.supabase.co";

/** A fake players-GoTrue + worker. `sessionOutcome` lets a test choose what /session returns. */
function server(
  opts: {
    sessionOutcome?: "linked" | "conflict" | "created";
    providers?: string[];
    passwordFails?: boolean;
  } = {},
) {
  const calls: { url: string; bearer: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(String(url));
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u.pathname + u.search, bearer: headers.get("authorization"), body });
    const j = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

    // worker
    if (u.pathname === "/v1/players/auth-config")
      return j({
        supabase_url: SB,
        anon_key: "ANON",
        oauth_callback: "https://triggair.com/auth/callback",
        providers: opts.providers ?? ["password"],
      });
    if (u.pathname === "/v1/players/anonymous")
      return j({ player_id: "anon_p", token: "ANONTK", expires_in: 86_400 });
    if (u.pathname === "/v1/players/session") {
      const outcome = opts.sessionOutcome ?? "linked";
      const base = { player_id: "acct_p", token: "ACCTTK", expires_in: 86_400, outcome };
      if (outcome === "conflict")
        return j({
          ...base,
          merge: {
            ticket: "TICKET",
            account_player: { id: "acct_p" },
            anonymous_player: { id: "anon_p" },
          },
        });
      return j(base);
    }
    if (u.pathname === "/v1/players/session/merge")
      return j({ player_id: "anon_p", token: "MERGETK", expires_in: 86_400, outcome: "replaced" });

    // GoTrue (players project)
    if (u.pathname === "/auth/v1/token" && u.search.includes("grant_type=password"))
      return opts.passwordFails
        ? j({ error_description: "Invalid login credentials" }, 400)
        : j({ access_token: "AT", refresh_token: "RT" });
    if (u.pathname === "/auth/v1/token" && u.search.includes("grant_type=refresh_token"))
      return j({ access_token: "AT2", refresh_token: "RT2" });
    if (u.pathname === "/auth/v1/signup") return j({}); // confirmation required (no session)
    if (u.pathname === "/auth/v1/recover") return j({});
    if (u.pathname === "/auth/v1/logout") return j({});
    return j({});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const make = (s: ReturnType<typeof server>, storage = memoryStorage()) =>
  createClient({
    key: "tg_pk_test",
    apiBase: "https://api.test",
    fetch: s.fetchImpl,
    storage,
    autoStart: false,
  });

describe("tg.auth (player accounts)", () => {
  it("exposes providers from auth-config", async () => {
    const s = server();
    expect(await make(s).auth.providers()).toEqual(["password"]);
  });

  it("signUp with email confirmation on returns needsConfirmation, carrying the game key", async () => {
    const s = server();
    expect(await make(s).auth.signUp("a@b.com", "pw123456")).toEqual({ needsConfirmation: true });
    const call = s.calls.find((c) => c.url.startsWith("/auth/v1/signup"));
    // the game pk rides along as user_metadata so the email hook can resolve the game
    expect((call?.body as { data?: { tg_game_key?: string } })?.data?.tg_game_key).toBe(
      "tg_pk_test",
    );
  });

  it("signUp defaults the confirm-link redirect to the current game page", async () => {
    const g = globalThis as { location?: unknown };
    const saved = g.location;
    g.location = { origin: "https://game.example", pathname: "/play/" };
    try {
      const s = server();
      await make(s).auth.signUp("a@b.com", "pw123456");
      const call = s.calls.find((c) => c.url.startsWith("/auth/v1/signup"));
      expect(call?.url).toBe(
        `/auth/v1/signup?redirect_to=${encodeURIComponent("https://game.example/play/")}`,
      );
    } finally {
      g.location = saved;
    }
  });

  it("signUp honours an explicit emailRedirectTo, and reset carries redirect_to too", async () => {
    const s = server();
    const tg = make(s);
    await tg.auth.signUp("a@b.com", "pw123456", {
      emailRedirectTo: "https://game.example/welcome",
    });
    expect(s.calls.find((c) => c.url.startsWith("/auth/v1/signup"))?.url).toBe(
      `/auth/v1/signup?redirect_to=${encodeURIComponent("https://game.example/welcome")}`,
    );
    await tg.auth.sendPasswordReset("a@b.com", { emailRedirectTo: "https://game.example/reset" });
    expect(s.calls.find((c) => c.url.startsWith("/auth/v1/recover"))?.url).toBe(
      `/auth/v1/recover?redirect_to=${encodeURIComponent("https://game.example/reset")}`,
    );
  });

  it("signInWithPassword exchanges the session with a Supabase bearer and adopts the player", async () => {
    const s = server({ sessionOutcome: "linked" });
    const tg = make(s);
    const r = await tg.auth.signInWithPassword("a@b.com", "pw123456");
    expect(r).toMatchObject({ playerId: "acct_p", outcome: "linked" });
    expect(tg.playerId).toBe("acct_p"); // adopted into the identity
    // the session-exchange carried the Supabase access token, not a player token
    const sess = s.calls.find((c) => c.url === "/v1/players/session");
    expect(sess?.bearer).toBe("Bearer AT");
    expect(sess?.body).toMatchObject({ device_id: expect.any(String) });
  });

  it("surfaces a conflict with a merge block, and resolveMerge replaces", async () => {
    const s = server({ sessionOutcome: "conflict" });
    const tg = make(s);
    const r = await tg.auth.signInWithPassword("a@b.com", "pw123456");
    expect(r.outcome).toBe("conflict");
    expect(r.merge).toEqual({ accountPlayerId: "acct_p", anonymousPlayerId: "anon_p" });
    const merged = await tg.auth.resolveMerge("use_anonymous");
    expect(merged.playerId).toBe("anon_p");
    expect(tg.playerId).toBe("anon_p");
    const mergeCall = s.calls.find((c) => c.url === "/v1/players/session/merge");
    expect(mergeCall?.body).toEqual({ ticket: "TICKET", choice: "use_anonymous" });
  });

  it("onIdentityChanged fires on login and signOut; signOut rotates the device", async () => {
    const s = server();
    const storage = memoryStorage();
    const tg = make(s, storage);
    let fired = 0;
    tg.auth.onIdentityChanged(() => fired++);
    const devBefore = storage.get("tg:tg_pk_test:device");
    expect(tg.auth.isSignedIn()).toBe(false);
    await tg.auth.signInWithPassword("a@b.com", "pw123456");
    expect(tg.auth.isSignedIn()).toBe(true);
    await tg.auth.signOut();
    expect(tg.auth.isSignedIn()).toBe(false);
    expect(fired).toBe(2);
    // device rotated → next anonymous login is a fresh player
    const devAfter = storage.get("tg:tg_pk_test:device");
    expect(devAfter).not.toBe(devBefore);
  });

  it("signInWithGoogle opens a popup, exchanges the callback session, and adopts the player", async () => {
    const s = server({ providers: ["google"] });
    const storage = memoryStorage();
    // Fake the browser popup + postMessage plumbing on globalThis.
    const listeners: ((e: unknown) => void)[] = [];
    const popup = { closed: false, close: () => {} };
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = {
      open: g.open,
      location: g.location,
      addEventListener: g.addEventListener,
      removeEventListener: g.removeEventListener,
    };
    let openedUrl = "";
    g.open = (url: string) => {
      openedUrl = url;
      // The callback delivers the session on the next tick.
      setTimeout(() => {
        for (const l of listeners)
          l({
            origin: "https://triggair.com",
            source: popup,
            data: { type: "tg-oauth", access_token: "GAT", refresh_token: "GRT" },
          });
      }, 0);
      return popup;
    };
    g.location = { origin: "https://game.example" };
    g.addEventListener = (_t: string, cb: (e: unknown) => void) => listeners.push(cb);
    g.removeEventListener = () => {};
    try {
      const tg = make(s, storage);
      const r = await tg.auth.signInWithGoogle();
      expect(r).toMatchObject({ playerId: "acct_p", outcome: "linked" });
      expect(openedUrl).toContain("/auth/v1/authorize?provider=google");
      // redirect_to is a nested URL, so the game origin is double-encoded; decode twice to check.
      const decoded = decodeURIComponent(decodeURIComponent(openedUrl));
      expect(decoded).toContain("https://triggair.com/auth/callback?origin=https://game.example");
      // the session-exchange used the Google access token
      expect(s.calls.find((c) => c.url === "/v1/players/session")?.bearer).toBe("Bearer GAT");
    } finally {
      Object.assign(g, saved);
    }
  });

  it("signInWithGoogle rejects when the provider is not enabled", async () => {
    const s = server({ providers: ["password"] });
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { open: g.open, location: g.location, addEventListener: g.addEventListener };
    g.open = () => ({ closed: false, close: () => {} });
    g.location = { origin: "https://game.example" };
    g.addEventListener = () => {};
    try {
      await expect(make(s).auth.signInWithGoogle()).rejects.toThrow(/not enabled/i);
    } finally {
      Object.assign(g, saved);
    }
  });

  it("restores a persisted account session on construction (reload) and re-exchanges — not anonymous", async () => {
    const s = server();
    const storage = memoryStorage();
    storage.set("tg:tg_pk_test:sb", JSON.stringify({ access_token: "OLD", refresh_token: "RT" }));
    const tg = make(s, storage); // construction arms the re-exchange from the persisted session
    await tg.players.me(); // a player-scoped call → token minted via re-exchange, not anonymous
    expect(s.calls.find((c) => c.url === "/v1/players/me")?.bearer).toBe("Bearer ACCTTK");
    expect(s.calls.some((c) => c.url.startsWith("/auth/v1/token?grant_type=refresh_token"))).toBe(
      true,
    );
    expect(s.calls.some((c) => c.url === "/v1/players/anonymous")).toBe(false);
    expect(tg.auth.isSignedIn()).toBe(true);
  });

  it("signInWithPassword surfaces GoTrue's error message on bad credentials", async () => {
    await expect(
      make(server({ passwordFails: true })).auth.signInWithPassword("a@b.com", "wrong"),
    ).rejects.toThrow(/invalid login credentials/i);
  });

  it("signInWithGoogle ignores a forged wrong-origin message and rejects when the popup closes", async () => {
    const s = server({ providers: ["google"] });
    const popup = { closed: false, close: () => {} };
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = {
      open: g.open,
      location: g.location,
      addEventListener: g.addEventListener,
      removeEventListener: g.removeEventListener,
    };
    const listeners: ((e: unknown) => void)[] = [];
    g.location = { origin: "https://game.example" };
    g.addEventListener = (_t: string, cb: (e: unknown) => void) => listeners.push(cb);
    g.removeEventListener = (_t: string, cb: (e: unknown) => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
    g.open = () => {
      // A rogue frame forges a tg-oauth message from the WRONG origin — must be ignored.
      setTimeout(() => {
        for (const l of listeners)
          l({
            origin: "https://evil.example",
            source: popup,
            data: { type: "tg-oauth", access_token: "STOLEN" },
          });
      }, 0);
      return popup;
    };
    try {
      const p = make(s, memoryStorage()).auth.signInWithGoogle();
      setTimeout(() => {
        popup.closed = true;
      }, 20); // no valid message ever arrives → the poll detects the close
      // If the forged message were accepted, this would RESOLVE with STOLEN; instead it rejects.
      await expect(p).rejects.toThrow(/cancelled/i);
      expect(s.calls.some((c) => c.url === "/v1/players/session")).toBe(false); // never exchanged STOLEN
    } finally {
      Object.assign(g, saved);
    }
  });

  it("after login, player-scoped calls use the adopted account token (no anonymous mint)", async () => {
    const s = server();
    const tg = make(s);
    await tg.auth.signInWithPassword("a@b.com", "pw123456");
    await tg.players.me(); // a player-scoped GET → token provider supplies the account token
    const me = s.calls.find((c) => c.url === "/v1/players/me");
    expect(me?.bearer).toBe("Bearer ACCTTK");
    expect(s.calls.some((c) => c.url === "/v1/players/anonymous")).toBe(false);
  });
});
