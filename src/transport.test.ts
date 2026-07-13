import { describe, expect, it, vi } from "vitest";
import { TriggairError } from "./errors";
import { type TokenProvider, createTransport } from "./transport";

type Handler = (url: string, init: RequestInit) => Response;
function rec(...script: (Response | Handler)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const q = [...script];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = q.shift();
    if (!next) return new Response("{}", { status: 200 });
    return typeof next === "function" ? next(String(url), init) : next;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const base = { key: "tg_pk_test", apiBase: "https://api.test", sleep: async () => {} };
const hdr = (init: RequestInit | undefined, name: string) =>
  init ? new Headers(init.headers).get(name) : null;

describe("transport", () => {
  it("sends pk + request-id headers and returns the parsed body", async () => {
    const r = rec(json(200, { ok: true }));
    const t = createTransport({ ...base, fetchImpl: r.fetchImpl });
    const out = await t.request<{ ok: boolean }>({ method: "GET", path: "/v1/config", auth: "pk" });
    expect(out).toEqual({ ok: true });
    expect(r.calls[0]?.url).toBe("https://api.test/v1/config");
    expect(hdr(r.calls[0]?.init, "x-triggair-key")).toBe("tg_pk_test");
    expect(hdr(r.calls[0]?.init, "x-request-id")).toMatch(/./);
  });

  it("attaches the bearer token for player-scoped calls", async () => {
    const provider: TokenProvider = { token: async () => "TKN", refresh: async () => "TKN2" };
    const r = rec(json(200, {}));
    const t = createTransport({ ...base, fetchImpl: r.fetchImpl, tokenProvider: provider });
    await t.request({ method: "GET", path: "/v1/players/me", auth: "player" });
    expect(hdr(r.calls[0]?.init, "authorization")).toBe("Bearer TKN");
  });

  it("maps the §4 error envelope to a TriggairError with agentHint", async () => {
    const r = rec(
      json(404, {
        error: { code: "not_found", message: "gone", agent_hint: "fix it", request_id: "req_1" },
      }),
    );
    const t = createTransport({ ...base, fetchImpl: r.fetchImpl });
    await expect(t.request({ method: "GET", path: "/v1/x", auth: "pk" })).rejects.toMatchObject({
      code: "not_found",
      agentHint: "fix it",
      requestId: "req_1",
    });
  });

  it("retries a 429 honoring Retry-After, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const r = rec(
      json(
        429,
        { error: { code: "rate_limited", message: "slow", agent_hint: "wait" } },
        { "retry-after": "2" },
      ),
      json(200, { ok: 1 }),
    );
    const t = createTransport({ ...base, fetchImpl: r.fetchImpl, sleep });
    const out = await t.request<{ ok: number }>({ method: "GET", path: "/v1/x", auth: "pk" });
    expect(out).toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("refreshes the token once on a 401 then retries", async () => {
    const refresh = vi.fn(async () => "NEW");
    const provider: TokenProvider = { token: async () => "OLD", refresh };
    const r = rec(
      json(401, { error: { code: "unauthorized", message: "no", agent_hint: "auth" } }),
      json(200, { ok: true }),
    );
    const t = createTransport({ ...base, fetchImpl: r.fetchImpl, tokenProvider: provider });
    const out = await t.request<{ ok: boolean }>({
      method: "GET",
      path: "/v1/players/me",
      auth: "player",
    });
    expect(out).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("wraps a fetch failure as a retryable network error", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const t = createTransport({ ...base, fetchImpl: boom, maxRetries: 0 });
    await expect(t.request({ method: "GET", path: "/v1/x", auth: "pk" })).rejects.toBeInstanceOf(
      TriggairError,
    );
  });
});
