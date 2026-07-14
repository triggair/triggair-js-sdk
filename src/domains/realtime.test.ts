import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth } from "../identity";
import { type WSLike, realtime } from "./realtime";

// join() awaits auth.token() before constructing the socket, so let that microtask run first.
const flush = () => new Promise((r) => setTimeout(r, 0));

// A controllable mock WebSocket that records the URL and lets the test drive server frames.
class MockWS implements WSLike {
  static last: MockWS | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    MockWS.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  recv(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const auth = { token: async () => "tok123" } as unknown as Auth;
const rt = () =>
  realtime({ key: "tg_pk_abc", apiBase: "https://api.example", auth, WebSocketImpl: MockWS });

describe("realtime SDK client", () => {
  beforeEach(() => {
    MockWS.last = null;
  });

  it("opens an authed wss URL and resolves join on the welcome frame", async () => {
    const p = rt().join("lobby");
    await flush();
    const ws = MockWS.last as MockWS;
    expect(ws.url).toBe("wss://api.example/v1/realtime/rooms/lobby?key=tg_pk_abc&token=tok123");
    ws.recv({ type: "welcome", you: "p1", members: ["p1"] });
    const conn = await p;
    expect(conn.you).toBe("p1");
    expect(conn.members).toEqual(["p1"]);
  });

  it("exposes recent history delivered in the welcome frame", async () => {
    const p = rt().join("chat");
    await flush();
    const ws = MockWS.last as MockWS;
    ws.recv({
      type: "welcome",
      you: "p1",
      members: ["p1"],
      history: [{ from: "p2", data: { text: "earlier" }, ts: 5 }],
    });
    const conn = await p;
    expect(conn.history).toEqual([{ from: "p2", data: { text: "earlier" }, ts: 5 }]);
  });

  it("dispatches presence + message frames and updates members", async () => {
    const p = rt().join("lobby");
    await flush();
    const ws = MockWS.last as MockWS;
    ws.recv({ type: "welcome", you: "p1", members: ["p1"] });
    const conn = await p;

    const presence = vi.fn();
    const message = vi.fn();
    conn.on("presence", presence);
    conn.on("message", message);

    ws.recv({ type: "presence", event: "join", player: "p2", members: ["p1", "p2"] });
    expect(presence).toHaveBeenCalledWith({
      type: "presence",
      event: "join",
      player: "p2",
      members: ["p1", "p2"],
    });
    expect(conn.members).toEqual(["p1", "p2"]);

    ws.recv({ type: "msg", from: "p2", data: { hi: true }, ts: 42 });
    expect(message).toHaveBeenCalledWith({ from: "p2", data: { hi: true }, ts: 42 });
  });

  it("send wraps data in a msg envelope; close closes the socket", async () => {
    const p = rt().join("lobby");
    await flush();
    const ws = MockWS.last as MockWS;
    ws.recv({ type: "welcome", you: "p1", members: ["p1"] });
    const conn = await p;
    conn.send({ move: "up" });
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: "msg", data: { move: "up" } });
    conn.close();
    expect(ws.closed).toBe(true);
  });

  it("rejects join if the socket closes before the welcome", async () => {
    const p = rt().join("lobby");
    await flush();
    const ws = MockWS.last as MockWS;
    ws.onclose?.({ code: 1006 });
    await expect(p).rejects.toThrow(/before ready/);
  });

  it("rejects join when there is no token", async () => {
    const noAuth = { token: async () => null } as unknown as Auth;
    await expect(
      realtime({ key: "k", apiBase: "https://x", auth: noAuth, WebSocketImpl: MockWS }).join("r"),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("sends + receives typing frames", async () => {
    const p = rt().join("lobby");
    await flush();
    const ws = MockWS.last as MockWS;
    ws.recv({ type: "welcome", you: "p1", members: ["p1"] });
    const conn = await p;
    const typing = vi.fn();
    conn.on("typing", typing);

    conn.typing(true);
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: "typing", state: true });
    ws.recv({ type: "typing", player: "p2", state: true });
    expect(typing).toHaveBeenCalledWith({ player: "p2", state: true });
    conn.close();
  });

  it("auto-reconnects after an unexpected close, re-welcomes, and emits events", async () => {
    vi.useFakeTimers();
    try {
      const p = rt().join("lobby");
      await vi.advanceTimersByTimeAsync(0); // resolve auth.token()
      const ws1 = MockWS.last as MockWS;
      ws1.recv({ type: "welcome", you: "p1", members: ["p1"] });
      const conn = await p;

      const reconnecting = vi.fn();
      const reconnected = vi.fn();
      const close = vi.fn();
      conn.on("reconnecting", reconnecting);
      conn.on("reconnected", reconnected);
      conn.on("close", close);

      // Unexpected drop (not conn.close()) → schedules a reconnect.
      ws1.onclose?.({ code: 1006 });
      expect(reconnecting).toHaveBeenCalledWith({ attempt: 1 });
      expect(close).not.toHaveBeenCalled(); // not terminal — it's healing

      // Backoff elapses → a fresh socket is opened.
      await vi.advanceTimersByTimeAsync(1000);
      const ws2 = MockWS.last as MockWS;
      expect(ws2).not.toBe(ws1);
      ws2.recv({ type: "welcome", you: "p1", members: ["p1", "p2"] });
      expect(reconnected).toHaveBeenCalledOnce();
      expect(conn.members).toEqual(["p1", "p2"]); // roster refreshed on re-welcome

      conn.close(); // user close after healing → terminal, no more reconnects
      ws2.onclose?.({ code: 1000 });
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a user close() does not reconnect", async () => {
    const p = rt().join("lobby");
    await flush();
    const ws = MockWS.last as MockWS;
    ws.recv({ type: "welcome", you: "p1", members: ["p1"] });
    const conn = await p;
    const reconnecting = vi.fn();
    conn.on("reconnecting", reconnecting);
    conn.close();
    ws.onclose?.({ code: 1000 });
    expect(reconnecting).not.toHaveBeenCalled();
  });
});
