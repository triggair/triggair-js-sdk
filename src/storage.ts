// A tiny synchronous key/value abstraction so the SDK runs anywhere: the browser
// uses localStorage (persists identity + outbox across reloads), Node/SSR/tests
// use an in-memory map. localStorage access is guarded — a disabled/absent store
// (private mode, no window) silently degrades to memory rather than throwing on
// import, so `createClient` never crashes the game just by loading.
export interface KVStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function memoryStorage(): KVStorage {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => {
      m.set(k, v);
    },
    remove: (k) => {
      m.delete(k);
    },
  };
}

/** localStorage if usable, else an in-memory fallback (never throws). */
export function defaultStorage(): KVStorage {
  try {
    const ls = globalThis.localStorage;
    const probe = "__tg_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return {
      get: (k) => ls.getItem(k),
      set: (k, v) => ls.setItem(k, v),
      remove: (k) => ls.removeItem(k),
    };
  } catch {
    return memoryStorage();
  }
}
