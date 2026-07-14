// Realtime rooms client (BD-01). `tg.realtime.join(room)` opens an authenticated WebSocket to a
// broadcast room (presence + fan-out messaging) and returns a small typed connection. A browser
// WebSocket can't set headers, so the pk + player token ride in the query string. The WebSocket
// impl is injectable (browser global by default) so it runs under `ws` in Node and a mock in tests.
import type { Auth } from "../identity";

export interface WSLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WSCtor = new (url: string) => WSLike;

export interface Presence {
  event: "join" | "leave";
  player: string;
  members: string[];
}
export interface RoomMessage {
  from: string;
  data: unknown;
  ts: number;
}
export interface Typing {
  player: string;
  state: boolean;
}
interface RoomEvents {
  message: RoomMessage;
  presence: Presence;
  typing: Typing;
  close: { code?: number };
  error: { message: string };
  /** The link dropped; a reconnect attempt is scheduled (with 1-based `attempt`). */
  reconnecting: { attempt: number };
  /** The socket reconnected and re-welcomed; `members`/`history` are refreshed. */
  reconnected: Record<string, never>;
}
type Handler<E extends keyof RoomEvents> = (payload: RoomEvents[E]) => void;

export interface RoomConnection {
  /** The caller's own player id in this room. */
  readonly you: string;
  /** Current roster (deduped, updated on every presence frame). */
  readonly members: string[];
  /** Recent chat replayed on join (oldest→newest), so a joiner has context immediately. */
  readonly history: RoomMessage[];
  on<E extends keyof RoomEvents>(event: E, handler: Handler<E>): () => void;
  send(data: unknown): void;
  /** Broadcast an ephemeral typing indicator (not stored, not moderated). */
  typing(state: boolean): void;
  close(): void;
}

// Reconnect + heartbeat tuning. The heartbeat keeps the server's idle reaper from closing a quiet
// but live socket; reconnect uses capped exponential backoff with jitter to avoid thundering herds.
const HEARTBEAT_MS = 25_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 8;

export function realtime(opts: {
  key: string;
  apiBase: string;
  auth: Auth;
  WebSocketImpl?: WSCtor;
}) {
  const wsBase = opts.apiBase.replace(/\/$/, "").replace(/^http/, "ws");
  return {
    /** Connect to a room. Resolves once the server welcome arrives (so `you`/`members` are set).
     *  The connection self-heals: an unexpected drop reconnects with backoff, re-joins, and
     *  re-welcomes (history + roster replay), emitting `reconnecting` then `reconnected`. */
    join(room: string): Promise<RoomConnection> {
      const Ctor = opts.WebSocketImpl ?? (globalThis as { WebSocket?: WSCtor }).WebSocket;
      if (!Ctor) throw new Error("No WebSocket available — pass `WebSocket` to createClient.");
      return opts.auth.token().then(
        (token) =>
          new Promise<RoomConnection>((resolve, reject) => {
            if (!token) return reject(new Error("Not authenticated — call tg.login() first."));
            const url = `${wsBase}/v1/realtime/rooms/${encodeURIComponent(room)}?key=${encodeURIComponent(opts.key)}&token=${encodeURIComponent(token)}`;
            const handlers = new Map<keyof RoomEvents, Set<Handler<never>>>();
            const state = {
              you: "",
              members: [] as string[],
              history: [] as RoomMessage[],
            };
            let ws: WSLike;
            let everWelcomed = false;
            let closedByUser = false;
            let attempt = 0;
            let heartbeat: ReturnType<typeof setInterval> | undefined;

            const emit = <E extends keyof RoomEvents>(e: E, p: RoomEvents[E]) => {
              for (const h of handlers.get(e) ?? []) (h as Handler<E>)(p);
            };
            const stopHeartbeat = () => {
              if (heartbeat !== undefined) clearInterval(heartbeat);
              heartbeat = undefined;
            };
            const startHeartbeat = () => {
              stopHeartbeat();
              heartbeat = setInterval(() => {
                try {
                  ws.send(JSON.stringify({ type: "ping" }));
                } catch {
                  /* the socket is gone; onclose will drive the reconnect */
                }
              }, HEARTBEAT_MS);
              // Don't let the heartbeat keep a Node process alive (no-op in the browser).
              (heartbeat as unknown as { unref?: () => void }).unref?.();
            };

            const conn: RoomConnection = {
              get you() {
                return state.you;
              },
              get members() {
                return state.members;
              },
              get history() {
                return state.history;
              },
              on(event, handler) {
                const set = handlers.get(event) ?? new Set();
                set.add(handler as Handler<never>);
                handlers.set(event, set);
                return () => set.delete(handler as Handler<never>);
              },
              send(data) {
                ws.send(JSON.stringify({ type: "msg", data }));
              },
              typing(typingState) {
                ws.send(JSON.stringify({ type: "typing", state: typingState === true }));
              },
              close() {
                closedByUser = true;
                stopHeartbeat();
                ws.close();
              },
            };

            const scheduleReconnect = () => {
              attempt++;
              if (attempt > MAX_RECONNECT_ATTEMPTS) {
                emit("close", {}); // gave up — terminal
                return;
              }
              const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
              const delay = backoff + Math.floor(Math.random() * backoff * 0.3);
              emit("reconnecting", { attempt });
              setTimeout(connect, delay);
            };

            const connect = () => {
              ws = new Ctor(url);
              ws.onmessage = (ev) => {
                let f: { type?: string; [k: string]: unknown };
                try {
                  f = JSON.parse(String(ev.data));
                } catch {
                  return;
                }
                if (f.type === "welcome") {
                  state.you = String(f.you);
                  state.members = (f.members as string[]) ?? [];
                  state.history = (f.history as RoomMessage[]) ?? [];
                  const wasReconnect = everWelcomed;
                  everWelcomed = true;
                  attempt = 0;
                  startHeartbeat();
                  if (wasReconnect) emit("reconnected", {});
                  else resolve(conn);
                } else if (f.type === "presence") {
                  state.members = (f.members as string[]) ?? state.members;
                  emit("presence", f as unknown as Presence);
                } else if (f.type === "msg") {
                  emit("message", { from: String(f.from), data: f.data, ts: Number(f.ts) });
                } else if (f.type === "typing") {
                  emit("typing", { player: String(f.player), state: f.state === true });
                } // "pong" is a heartbeat ack — nothing to do
              };
              ws.onerror = () => {
                emit("error", { message: "Realtime connection error." });
              };
              ws.onclose = (ev) => {
                stopHeartbeat();
                const code = (ev as { code?: number })?.code;
                if (closedByUser) {
                  emit("close", code === undefined ? {} : { code });
                  return;
                }
                if (!everWelcomed) {
                  // The initial connect never succeeded — fail the join rather than retry forever.
                  reject(new Error(`Realtime closed before ready (code ${code}).`));
                  return;
                }
                scheduleReconnect();
              };
            };
            connect();
          }),
      );
    },
  };
}
