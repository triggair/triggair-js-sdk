// The low-level HTTP layer. Every call carries the publishable key
// (X-Triggair-Key), a correlation X-Request-Id, and — for player-scoped calls —
// the bearer token from the auth token provider. Mutating writes may carry an
// Idempotency-Key (forward-compat with the golden idempotency invariant) and
// saves an If-Match (OCC). Transient failures (429/5xx/network) back off honoring
// Retry-After; a 401 on a player call triggers exactly one silent token refresh.
import { TriggairError, networkError, parseError } from "./errors";

export type AuthMode = "none" | "pk" | "player";
export interface TokenProvider {
  token(): Promise<string | null>;
  refresh(): Promise<string | null>;
}
export interface RequestSpec {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined> | undefined;
  body?: unknown;
  auth?: AuthMode | undefined;
  /** Explicit Authorization bearer, overriding the player-token provider — used by the account
   *  session-exchange (BE-18), which carries the pk AND a Supabase session JWT. */
  bearer?: string | undefined;
  ifMatch?: number | undefined;
  idempotencyKey?: string | undefined;
  signal?: AbortSignal | undefined;
}
export interface TransportOptions {
  key: string;
  apiBase: string;
  fetchImpl: typeof fetch;
  tokenProvider?: TokenProvider;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ?? `req_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createTransport(o: TransportOptions) {
  const maxRetries = o.maxRetries ?? 3;
  const sleep = o.sleep ?? wait;

  function url(spec: RequestSpec): string {
    const u = new URL(o.apiBase.replace(/\/$/, "") + spec.path);
    for (const [k, v] of Object.entries(spec.query ?? {}))
      if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async function headers(spec: RequestSpec): Promise<Headers> {
    const h = new Headers({ Accept: "application/json", "X-Triggair-Key": o.key });
    h.set("X-Request-Id", uuid());
    if (spec.body !== undefined) h.set("Content-Type", "application/json");
    if (spec.ifMatch !== undefined) h.set("If-Match", `"${spec.ifMatch}"`);
    if (spec.idempotencyKey) h.set("Idempotency-Key", spec.idempotencyKey);
    if (spec.bearer) {
      h.set("Authorization", `Bearer ${spec.bearer}`);
    } else if (spec.auth === "player" && o.tokenProvider) {
      const t = await o.tokenProvider.token();
      if (t) h.set("Authorization", `Bearer ${t}`);
    }
    return h;
  }

  async function parse<T>(res: Response): Promise<T | undefined> {
    if (res.status === 204 || res.headers.get("content-length") === "0") return undefined;
    return (await res.json()) as T;
  }

  async function request<T>(spec: RequestSpec): Promise<T | undefined> {
    const target = url(spec);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const init: RequestInit = { method: spec.method, headers: await headers(spec) };
      if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
      if (spec.signal) init.signal = spec.signal;

      let res: Response;
      try {
        res = await o.fetchImpl(target, init);
      } catch (cause) {
        if (attempt < maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw networkError(cause);
      }

      if (res.ok) return parse<T>(res);
      if (res.status === 401 && spec.auth === "player" && o.tokenProvider && !refreshed) {
        refreshed = true;
        await o.tokenProvider.refresh();
        continue; // retry immediately with the fresh token
      }
      const err = await parseError(res);
      if (err.retryable && attempt < maxRetries) {
        await sleep(retryAfter(res) ?? backoff(attempt));
        continue;
      }
      throw err;
    }
  }

  return { request };
}

const backoff = (attempt: number) => Math.min(300 * 2 ** attempt, 4000);
function retryAfter(res: Response): number | null {
  const h = res.headers.get("retry-after");
  const s = h ? Number(h) : Number.NaN;
  return Number.isFinite(s) ? s * 1000 : null;
}

export { TriggairError };
