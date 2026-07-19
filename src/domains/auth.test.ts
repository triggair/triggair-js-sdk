import { describe, expect, it } from "vitest";
import { createClient } from "../client";
import { memoryStorage } from "../storage";

/** A fake Triggair worker. Player auth now goes entirely through /v1/players/* — no identity service. */
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

    const outcome = opts.sessionOutcome ?? "linked";
    const exchange = () => {
      const base = { player_id: "acct_p", token: "ACCTTK", expires_in: 86_400, outcome };
      return outcome === "conflict"
        ? {
            ...base,
            merge: {
              ticket: "TICKET",
              account_player: { id: "acct_p" },
              anonymous_player: { id: "anon_p" },
            },
          }
        : base;
    };

    if (u.pathname === "/v1/players/auth-config")
      return j({
        providers: opts.providers ?? ["password"],
        oauth_callback: "https://triggair.com/auth/callback",
      });
    if (u.pathname === "/v1/players/anonymous")
      return j({ player_id: "anon_p", token: "ANONTK", expires_in: 86_400 });
    if (u.pathname === "/v1/players/signup") return j({ needs_confirmation: true });
    if (u.pathname === "/v1/players/login")
      return opts.passwordFails
        ? j({ error: { code: "unauthorized", message: "Invalid email or password" } }, 401)
        : j({ session: { access_token: "AT", refresh_token: "RT" }, ...exchange() });
    if (u.pathname === "/v1/players/token/refresh")
      return j({ session: { access_token: "AT2", refresh_token: "RT2" }, ...exchange() });
    if (u.pathname === "/v1/players/password-reset") return j({ ok: true });
    if (u.pathname === "/v1/players/session") return j(exchange()); // Google exchange
    if (u.pathname === "/v1/players/session/merge")
      return j({ player_id: "anon_p", token: "MERGETK", expires_in: 86_400, outcome: "replaced" });
    if (u.pathname === "/v1/players/logout") return j({ ok: true });
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

describe("tg.auth (player accounts over the worker proxy)", () => {
  it("exposes providers from auth-config", async () => {
    expect(await make(server()).auth.providers()).toEqual(["password"]);
  });

  it("signUp posts to the worker with the pk header + returns needsConfirmation", async () => {
    const s = server();
    expect(await make(s).auth.signUp("a@b.com", "pw123456")).toEqual({ needsConfirmation: true });
    const call = s.calls.find((c) => c.url === "/v1/players/signup");
    expect(call?.body).toMatchObject({ email: "a@b.com", password: "pw123456" });
    // NEVER hits the identity provider directly — only /v1/players/*.
    expect(s.calls.every((c) => c.url.startsWith("/v1/players/"))).toBe(true);
  });

  it("signUp defaults the confirm-link redirect to the current game page (in the body)", async () => {
    const g = globalThis as { location?: unknown };
    const saved = g.location;
    g.location = { origin: "https://game.example", pathname: "/play/" };
    try {
      const s = server();
      await make(s).auth.signUp("a@b.com", "pw123456");
      const call = s.calls.find((c) => c.url === "/v1/players/signup");
      expect((call?.body as { redirect_to?: string }).redirect_to).toBe(
        "https://game.example/play/",
      );
    } finally {
      g.location = saved;
    }
  });

  it("signUp + reset honour an explicit emailRedirectTo (body redirect_to)", async () => {
    const s = server();
    const tg = make(s);
    await tg.auth.signUp("a@b.com", "pw123456", {
      emailRedirectTo: "https://game.example/welcome",
    });
    expect(
      (s.calls.find((c) => c.url === "/v1/players/signup")?.body as { redirect_to?: string })
        .redirect_to,
    ).toBe("https://game.example/welcome");
    await tg.auth.sendPasswordReset("a@b.com", { emailRedirectTo: "https://game.example/reset" });
    expect(
      (
        s.calls.find((c) => c.url === "/v1/players/password-reset")?.body as {
          redirect_to?: string;
        }
      ).redirect_to,
    ).toBe("https://game.example/reset");
  });

  it("signInWithPassword logs in via /login (pk only, no bearer) and adopts the player", async () => {
    const s = server({ sessionOutcome: "linked" });
    const tg = make(s);
    const r = await tg.auth.signInWithPassword("a@b.com", "pw123456");
    expect(r).toMatchObject({ playerId: "acct_p", outcome: "linked" });
    expect(tg.playerId).toBe("acct_p");
    const login = s.calls.find((c) => c.url === "/v1/players/login");
    expect(login?.bearer).toBeNull(); // credentials go in the body, not a Bearer
    expect(login?.body).toMatchObject({ email: "a@b.com", password: "pw123456" });
  });

  it("surfaces bad credentials as an error", async () => {
    await expect(
      make(server({ passwordFails: true })).auth.signInWithPassword("a@b.com", "nope"),
    ).rejects.toThrow();
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
    expect(s.calls.find((c) => c.url === "/v1/players/session/merge")?.body).toEqual({
      ticket: "TICKET",
      choice: "use_anonymous",
    });
  });

  it("onIdentityChanged fires on login and signOut; signOut revokes + rotates the device", async () => {
    const s = server();
    const storage = memoryStorage();
    const tg = make(s, storage);
    let fired = 0;
    tg.auth.onIdentityChanged(() => fired++);
    const devBefore = storage.get("tg:tg_pk_test:device");
    await tg.auth.signInWithPassword("a@b.com", "pw123456");
    expect(tg.auth.isSignedIn()).toBe(true);
    await tg.auth.signOut();
    expect(tg.auth.isSignedIn()).toBe(false);
    expect(fired).toBe(2);
    expect(s.calls.some((c) => c.url === "/v1/players/logout")).toBe(true); // best-effort revoke
    expect(storage.get("tg:tg_pk_test:device")).not.toBe(devBefore);
  });

  it("a reload restores the session and re-exchanges via /token/refresh (never anonymous)", async () => {
    const s = server();
    const storage = memoryStorage();
    // Pre-seed a stored account session, as a prior login would have.
    storage.set(
      "tg:tg_pk_test:device",
      JSON.stringify({ id: "device-restore", createdAt: Date.now() }),
    );
    storage.set(
      "tg:tg_pk_test:sb",
      JSON.stringify({ access_token: "OLD", refresh_token: "OLD-RT" }),
    );
    const tg = make(s, storage);
    // Minting a token uses the restored session's re-exchange, not a fresh anonymous mint.
    expect(await tg.login()).toEqual({ playerId: "acct_p" });
    expect(s.calls.some((c) => c.url === "/v1/players/token/refresh")).toBe(true);
    expect(s.calls.some((c) => c.url === "/v1/players/anonymous")).toBe(false);
    expect(JSON.parse(storage.get("tg:tg_pk_test:sb") ?? "{}").refresh_token).toBe("RT2");
  });

  it("signInWithGoogle opens the WORKER start endpoint, exchanges the callback session, adopts", async () => {
    const s = server({ providers: ["google"] });
    const storage = memoryStorage();
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
    g.addEventListener = (_t: string, fn: (e: unknown) => void) => listeners.push(fn);
    g.removeEventListener = () => {};
    try {
      const tg = make(s, storage);
      const r = await tg.auth.signInWithGoogle();
      expect(r.playerId).toBe("acct_p");
      // opened the worker start endpoint (NOT the identity provider), with the pk + origin.
      expect(openedUrl).toContain("https://api.test/v1/players/oauth/google/start");
      expect(openedUrl).toContain("key=tg_pk_test");
      // the Google session was exchanged at /v1/players/session with the Google access token.
      const sess = s.calls.find((c) => c.url === "/v1/players/session");
      expect(sess?.bearer).toBe("Bearer GAT");
    } finally {
      Object.assign(g, saved);
    }
  });

  it("signInWithGoogle ignores a forged wrong-origin message and rejects when the popup closes", async () => {
    const s = server({ providers: ["google"] });
    const listeners: ((e: unknown) => void)[] = [];
    const popup = { closed: false, close: () => {} };
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = {
      open: g.open,
      location: g.location,
      addEventListener: g.addEventListener,
      removeEventListener: g.removeEventListener,
      setInterval: g.setInterval,
    };
    g.open = () => {
      // Attacker posts a session from the WRONG origin — must be ignored.
      setTimeout(() => {
        for (const l of listeners)
          l({
            origin: "https://evil.example",
            source: popup,
            data: { type: "tg-oauth", access_token: "STOLEN" },
          });
        popup.closed = true; // then the user closes the popup
      }, 0);
      return popup;
    };
    g.location = { origin: "https://game.example" };
    g.addEventListener = (_t: string, fn: (e: unknown) => void) => listeners.push(fn);
    g.removeEventListener = () => {};
    try {
      await expect(make(s).auth.signInWithGoogle()).rejects.toThrow(/cancelled/i);
      expect(s.calls.some((c) => c.url === "/v1/players/session")).toBe(false); // never exchanged STOLEN
    } finally {
      Object.assign(g, saved);
    }
  });
});
