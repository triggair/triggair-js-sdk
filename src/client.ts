// The client factory — composes transport + auth + outbox and the typed domain
// groups into the one object a game holds. Zero config beyond the publishable key;
// storage and fetch are injectable (browser defaults: localStorage + global fetch;
// Node/tests pass their own). The token provider is late-bound to auth so the
// pk-only mint call can run through the same transport without a token.
import { achievements } from "./domains/achievements";
import { analytics } from "./domains/analytics";
import { asyncMatch } from "./domains/async-match";
import { createAuthApi } from "./domains/auth";
import { battlePass } from "./domains/battle-pass";
import { codes } from "./domains/codes";
import { compliance } from "./domains/compliance";
import { config, rng } from "./domains/config";
import { crashes } from "./domains/crashes";
import type { Ctx } from "./domains/ctx";
import { daily } from "./domains/daily";
import { economy } from "./domains/economy";
import { experiments } from "./domains/experiments";
import { flags } from "./domains/flags";
import { inbox } from "./domains/inbox";
import { keyedBoards } from "./domains/keyed-boards";
import { leaderboards } from "./domains/leaderboards";
import { leagues } from "./domains/leagues";
import { moderation } from "./domains/moderation";
import { players } from "./domains/players";
import { progression } from "./domains/progression";
import { push } from "./domains/push";
import { quests } from "./domains/quests";
import { type WSCtor, realtime } from "./domains/realtime";
import { saves } from "./domains/saves";
import { segments } from "./domains/segments";
import { social } from "./domains/social";
import { stats } from "./domains/stats";
import { storage as storageDomain } from "./domains/storage";
import { teams } from "./domains/teams";
import { tournaments } from "./domains/tournaments";
import { ugc } from "./domains/ugc";
import { createAuth } from "./identity";
import { createOutbox } from "./outbox";
import { type KVStorage, defaultStorage } from "./storage";
import { type TokenProvider, createTransport } from "./transport";

const DEFAULT_API = "https://api.triggair.com";

export interface ClientOptions {
  /** Publishable key (`tg_pk_…`). The only required option. */
  key: string;
  /** API base URL. Defaults to production. */
  apiBase?: string;
  /** Override the KV store (defaults to localStorage → memory). */
  storage?: KVStorage;
  /** Override fetch (defaults to the global). */
  fetch?: typeof fetch;
  /** Outbox flush interval; 0 disables the timer. Default 15s. */
  flushIntervalMs?: number;
  /** Start the outbox (interval + online listener). Default true. */
  autoStart?: boolean;
  /** Connectivity predicate for opportunistic flush (SSR/testing). Default navigator.onLine. */
  online?: () => boolean;
  /** WebSocket constructor for realtime (BD-01). Defaults to the global; pass `ws` in Node/tests. */
  webSocket?: WSCtor;
}

export function createClient(options: ClientOptions) {
  if (!options.key) throw new Error("createClient requires a publishable `key`.");
  const storage = options.storage ?? defaultStorage();
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error("No fetch available — pass `options.fetch`.");
  const namespace = `tg:${options.key}:`;

  const provider: TokenProvider = { token: async () => null, refresh: async () => null };
  const transport = createTransport({
    key: options.key,
    apiBase: options.apiBase ?? DEFAULT_API,
    fetchImpl,
    tokenProvider: provider,
  });
  const auth = createAuth({ request: transport.request, storage, namespace });
  provider.token = auth.token;
  provider.refresh = auth.refresh;
  const outbox = createOutbox({
    request: transport.request,
    storage,
    namespace,
    intervalMs: options.flushIntervalMs ?? 15_000,
    ...(options.online ? { online: options.online } : {}),
  });
  if (options.autoStart !== false) outbox.start();

  const ctx: Ctx = { request: transport.request, outbox, auth };
  // Player accounts & login (BE-18) — email/password over the triggair-players project, then the
  // worker session-exchange. Additive: anonymous play (login/logout/recover below) is unchanged.
  const authApi = createAuthApi({
    request: transport.request,
    fetchImpl,
    key: options.key,
    identity: auth,
    storage,
    namespace,
  });

  return {
    /** Ensure a player session (mint/refresh a token) → the player id. */
    login: auth.login,
    /** Player accounts: signUp / signInWithPassword / resolveMerge / signOut / onIdentityChanged. */
    auth: authApi,
    /** Drop the cached token (keeps the device identity). */
    logout: auth.logout,
    /** Consume a recovery code → same player on this device. */
    recover: auth.recover,
    /** Mint a single-use recovery code for cross-device rescue. */
    mintRecoveryCode: auth.mintRecoveryCode,
    get playerId(): string | null {
      return auth.playerId;
    },
    /** Queue a durable, coalesced analytics event (flushed on reconnect). */
    track: (name: string, count?: number): void => outbox.track(name, count),
    /** Flush the durable outbox now. */
    flush: (): Promise<void> => outbox.flush(),
    /** Stop the outbox timer (call on teardown). */
    stop: (): void => outbox.stop(),
    players: players(ctx),
    stats: stats(ctx),
    saves: saves(ctx),
    leaderboards: leaderboards(ctx),
    keyedBoards: keyedBoards(ctx),
    social: social(ctx),
    inbox: inbox(ctx),
    achievements: achievements(ctx),
    analytics: analytics(ctx),
    daily: daily(ctx),
    economy: economy(ctx),
    moderation: moderation(ctx),
    compliance: compliance(ctx),
    crashes: crashes(ctx),
    config: config(ctx),
    flags: flags(ctx),
    experiments: experiments(ctx),
    push: push(ctx),
    segments: segments(ctx),
    codes: codes(ctx),
    quests: quests(ctx),
    progression: progression(ctx),
    battlePass: battlePass(ctx),
    teams: teams(ctx),
    tournaments: tournaments(ctx),
    leagues: leagues(ctx),
    ugc: ugc(ctx),
    asyncMatch: asyncMatch(ctx),
    storage: storageDomain(ctx),
    rng: rng(ctx),
    realtime: realtime({
      key: options.key,
      apiBase: options.apiBase ?? DEFAULT_API,
      auth,
      ...(options.webSocket ? { WebSocketImpl: options.webSocket } : {}),
    }),
  };
}

export type TriggairClient = ReturnType<typeof createClient>;
