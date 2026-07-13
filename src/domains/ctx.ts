// Shared wiring for the typed domain method groups: the low-level requester (from
// transport), the outbox (durable writes), and the auth manager. `need` unwraps a
// response that must have a body (a 204 where JSON was expected is a contract bug).
import type { Auth } from "../identity";
import type { Outbox } from "../outbox";
import type { RequestSpec } from "../transport";

export type Requester = <T>(spec: RequestSpec) => Promise<T | undefined>;

export interface Ctx {
  request: Requester;
  outbox: Outbox;
  auth: Auth;
}

export async function need<T>(p: Promise<T | undefined>): Promise<T> {
  const v = await p;
  if (v === undefined) throw new Error("Expected a response body but got none.");
  return v;
}
