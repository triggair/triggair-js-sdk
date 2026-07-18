// @triggair/sdk — the one-import browser client for the Triggair game backend
// (BE-15). `createClient({ key })` is the whole entry point; every method returns
// typed results and every failure is a TriggairError carrying an `agentHint`. See
// README.md — written for agents first.
export { createClient } from "./client";
export type { ClientOptions, TriggairClient } from "./client";
export { TriggairError } from "./errors";
export type { TriggairErrorCode } from "./errors";
export { memoryStorage } from "./storage";
export type { KVStorage } from "./storage";

// Domain result/input types (for consumers typing their own code).
export type * from "./domains/auth";
export type * from "./domains/players";
export type * from "./domains/stats";
export type * from "./domains/saves";
export type * from "./domains/keyed-boards";
export type * from "./domains/leaderboards";
export type * from "./domains/social";
export type * from "./domains/inbox";
export type * from "./domains/achievements";
export type * from "./domains/analytics";
export type * from "./domains/crashes";
export type * from "./domains/daily";
export type * from "./domains/economy";
export type * from "./domains/moderation";
export type * from "./domains/config";

export const SDK_VERSION = "0.1.0" as const;
