import { describe, expect, it } from "vitest";
import { createClient } from "../client";
import { memoryStorage } from "../storage";

const SB = "https://players.supabase.co";

/** A fake players-GoTrue + worker. `sessionOutcome` lets a test choose what /session returns. */
function server(opts: { sessionOutcome?: "linked" | "conflict" | "created" } = {}) {
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
      return j({ supabase_url: SB, anon_key: "ANON", providers: ["password"] });
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
      return j({ access_token: "AT", refresh_token: "RT" });
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

  it("signUp with email confirmation on returns needsConfirmation", async () => {
    const s = server();
    expect(await make(s).auth.signUp("a@b.com", "pw123456")).toEqual({ needsConfirmation: true });
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
    await tg.auth.signInWithPassword("a@b.com", "pw123456");
    await tg.auth.signOut();
    expect(fired).toBe(2);
    // device rotated → next anonymous login is a fresh player
    const devAfter = storage.get("tg:tg_pk_test:device");
    expect(devAfter).not.toBe(devBefore);
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
