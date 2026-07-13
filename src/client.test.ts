import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { TriggairError } from "./errors";
import { memoryStorage } from "./storage";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}
function server() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    calls.push({
      url: u.pathname,
      method,
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const j = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/players/anonymous")
      return j({ player_id: "p_9", token: "TOKEN", expires_in: 86_400 });
    if (u.pathname === "/v1/players/me")
      return j({ id: "p_9", created_at: "t", display_name: null });
    if (u.pathname === "/v1/saves/slot1")
      return j({ slot: "slot1", version: 4, updated_at: "t" }, 200);
    if (u.pathname === "/v1/leaderboards/hi/top")
      return j({ board: "hi", period_key: "all", entries: [] });
    if (u.pathname === "/v1/events") return j({ ok: true });
    if (u.pathname === "/v1/daily/claim")
      return j(
        { error: { code: "conflict", message: "Already claimed", agent_hint: "wait a day" } },
        409,
      );
    return j({});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const make = (s: ReturnType<typeof server>, online?: () => boolean) =>
  createClient({
    key: "tg_pk_test",
    apiBase: "https://api.test",
    fetch: s.fetchImpl,
    storage: memoryStorage(),
    autoStart: false,
    ...(online ? { online } : {}),
  });

describe("createClient", () => {
  it("requires a key and a fetch", () => {
    expect(() => createClient({ key: "" })).toThrow(/key/);
  });

  it("logs in, then attaches the bearer to player-scoped calls", async () => {
    const s = server();
    const c = make(s);
    const { playerId } = await c.login();
    expect(playerId).toBe("p_9");
    await c.players.me();
    const me = s.calls.find((x) => x.url === "/v1/players/me");
    expect(me?.headers.get("authorization")).toBe("Bearer TOKEN");
    expect(me?.headers.get("x-triggair-key")).toBe("tg_pk_test");
  });

  it("saves.put sends an If-Match header for OCC", async () => {
    const s = server();
    const c = make(s);
    const ref = await c.saves.put("slot1", { hp: 3 }, { ifMatch: 3 });
    expect(ref.version).toBe(4);
    const put = s.calls.find((x) => x.url === "/v1/saves/slot1");
    expect(put?.method).toBe("PUT");
    expect(put?.headers.get("if-match")).toBe('"3"');
  });

  it("leaderboards.top is pk-only (no bearer required)", async () => {
    const s = server();
    const c = make(s);
    const top = await c.leaderboards.top("hi");
    expect(top.board).toBe("hi");
    const call = s.calls.find((x) => x.url === "/v1/leaderboards/hi/top");
    expect(call?.headers.get("authorization")).toBeNull();
  });

  it("track() routes through the durable outbox and flush posts events", async () => {
    const s = server();
    const c = make(s, () => false); // offline ⇒ no opportunistic flush; we flush explicitly
    await c.login();
    c.track("boot");
    c.track("boot");
    expect(s.calls.some((x) => x.url === "/v1/events")).toBe(false); // queued, not sent
    await c.flush();
    const evt = s.calls.find((x) => x.url === "/v1/events");
    expect((evt?.body as { events: { name: string; count: number }[] }).events).toEqual([
      { name: "boot", count: 2 },
    ]);
  });

  it("surfaces a 409 as a TriggairError carrying the agent hint", async () => {
    const s = server();
    const c = make(s);
    await c.login();
    await expect(c.daily.claim()).rejects.toMatchObject({
      code: "conflict",
      agentHint: "wait a day",
    });
    await expect(c.daily.claim()).rejects.toBeInstanceOf(TriggairError);
  });
});
