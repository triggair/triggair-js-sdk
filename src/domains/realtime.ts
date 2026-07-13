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
interface RoomEvents {
  message: RoomMessage;
  presence: Presence;
  close: { code?: number };
  error: { message: string };
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
  close(): void;
}

export function realtime(opts: {
  key: string;
  apiBase: string;
  auth: Auth;
  WebSocketImpl?: WSCtor;
}) {
  const wsBase = opts.apiBase.replace(/\/$/, "").replace(/^http/, "ws");
  return {
    /** Connect to a room. Resolves once the server welcome arrives (so `you`/`members` are set). */
    join(room: string): Promise<RoomConnection> {
      const Ctor = opts.WebSocketImpl ?? (globalThis as { WebSocket?: WSCtor }).WebSocket;
      if (!Ctor) throw new Error("No WebSocket available — pass `WebSocket` to createClient.");
      return opts.auth.token().then(
        (token) =>
          new Promise<RoomConnection>((resolve, reject) => {
            if (!token) return reject(new Error("Not authenticated — call tg.login() first."));
            const url = `${wsBase}/v1/realtime/rooms/${encodeURIComponent(room)}?key=${encodeURIComponent(opts.key)}&token=${encodeURIComponent(token)}`;
            const ws = new Ctor(url);
            const handlers = new Map<keyof RoomEvents, Set<Handler<never>>>();
            const state = {
              you: "",
              members: [] as string[],
              history: [] as RoomMessage[],
              welcomed: false,
            };
            const emit = <E extends keyof RoomEvents>(e: E, p: RoomEvents[E]) => {
              for (const h of handlers.get(e) ?? []) (h as Handler<E>)(p);
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
              close() {
                ws.close();
              },
            };
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
                if (!state.welcomed) {
                  state.welcomed = true;
                  resolve(conn);
                }
              } else if (f.type === "presence") {
                state.members = (f.members as string[]) ?? state.members;
                emit("presence", f as unknown as Presence);
              } else if (f.type === "msg") {
                emit("message", { from: String(f.from), data: f.data, ts: Number(f.ts) });
              }
            };
            ws.onerror = () => {
              if (!state.welcomed) reject(new Error("Realtime connection failed."));
              emit("error", { message: "Realtime connection error." });
            };
            ws.onclose = (ev) => {
              const code = (ev as { code?: number })?.code;
              if (!state.welcomed)
                reject(new Error(`Realtime closed before ready (code ${code}).`));
              emit("close", code === undefined ? {} : { code });
            };
          }),
      );
    },
  };
}
