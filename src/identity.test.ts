import { describe, expect, it, vi } from "vitest";
import { createAuth } from "./identity";
import { memoryStorage } from "./storage";
import type { RequestSpec } from "./transport";

// A fake requester that mints a fresh token each call and records the bodies.
function fakeMint() {
  let n = 0;
  const bodies: unknown[] = [];
  const request = (async (spec: RequestSpec) => {
    bodies.push(spec.body);
    if (spec.path === "/v1/players/anonymous")
      return { player_id: "p_1", token: `tok_${++n}`, expires_in: 86_400 };
    if (spec.path === "/v1/players/recover")
      return { player_id: "p_rec", token: `rec_${++n}`, expires_in: 86_400 };
    return {};
  }) as <T>(s: RequestSpec) => Promise<T | undefined>;
  return { request, bodies, mintCount: () => n };
}

describe("identity", () => {
  it("mints once, caches, and reuses a valid token", async () => {
    const m = fakeMint();
    const auth = createAuth({ request: m.request, storage: memoryStorage(), namespace: "t:" });
    expect(await auth.token()).toBe("tok_1");
    expect(await auth.token()).toBe("tok_1"); // cached, no second mint
    expect(m.mintCount()).toBe(1);
    expect(auth.playerId).toBe("p_1");
  });

  it("shares one in-flight mint across concurrent callers (single-flight)", async () => {
    const m = fakeMint();
    const auth = createAuth({ request: m.request, storage: memoryStorage(), namespace: "t:" });
    const [a, b] = await Promise.all([auth.token(), auth.token()]);
    expect(a).toBe(b);
    expect(m.mintCount()).toBe(1);
  });

  it("refresh() forces a re-mint", async () => {
    const m = fakeMint();
    const auth = createAuth({ request: m.request, storage: memoryStorage(), namespace: "t:" });
    await auth.token();
    expect(await auth.refresh()).toBe("tok_2");
    expect(m.mintCount()).toBe(2);
  });

  it("persists + reuses the device id across instances", async () => {
    const store = memoryStorage();
    const m = fakeMint();
    const a1 = createAuth({ request: m.request, storage: store, namespace: "t:" });
    await a1.token();
    const dev1 = (m.bodies[0] as { device_id: string }).device_id;
    const a2 = createAuth({ request: m.request, storage: store, namespace: "t:" });
    await a2.refresh();
    const dev2 = (m.bodies.at(-1) as { device_id: string }).device_id;
    expect(dev1).toBe(dev2);
    expect(dev1).toHaveLength(32);
  });

  it("recover() consumes a code and adopts the recovered player", async () => {
    const m = fakeMint();
    const auth = createAuth({ request: m.request, storage: memoryStorage(), namespace: "t:" });
    const out = await auth.recover("ABCD-EFGH-JKLM");
    expect(out.playerId).toBe("p_rec");
    expect((m.bodies.at(-1) as { code: string }).code).toBe("ABCD-EFGH-JKLM");
  });

  it("logout drops the token but keeps the device", async () => {
    const store = memoryStorage();
    const m = fakeMint();
    const auth = createAuth({ request: m.request, storage: store, namespace: "t:" });
    await auth.token();
    auth.logout();
    expect(store.get("t:token")).toBeNull();
    expect(store.get("t:device")).not.toBeNull();
  });
});

it("token margin triggers a refresh near expiry", async () => {
  const m = fakeMint();
  const auth = createAuth({
    request: m.request,
    storage: memoryStorage(),
    namespace: "t:",
    marginSec: 86_400, // margin == full TTL ⇒ the cached token is always "near expiry"
  });
  await auth.token();
  await auth.token();
  expect(m.mintCount()).toBe(2);
  vi.restoreAllMocks();
});
