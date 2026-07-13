# @triggair/sdk

The one-import browser client for the Triggair game backend. Anonymous-first player
identity, cloud saves, leaderboards, stats, achievements, daily rewards, inbox,
friends & share links, a server-authoritative economy (currency, stores, inventory,
loot boxes, energy), remote config & feature flags, moderation, age-gate/compliance,
analytics, crash reporting, tournaments/leagues/teams, UGC, battle-pass/quests/
progression, collections storage, promo codes, turn-based matches, and deterministic
RNG — every method typed, every error actionable.

> **Integrating into a game?** Read [`SKILL.md`](./SKILL.md) — the full agent-facing
> integration skill: the mental model, a step-by-step playbook, every feature with its exact
> signatures, and copy-paste recipes.

> **For agents:** this README is the integration contract. One import, one key.
> Player-scoped calls auto-authenticate (an anonymous token is minted on first use
> and silently refreshed). Every failure throws a `TriggairError` with an
> `agentHint` telling you how to fix the call. After wiring, run
> `triggair_verify_integration` (MCP) to confirm the integration end-to-end.

## Install

```bash
npm i @triggair/sdk
```

## Initialize

```ts
import { createClient } from "@triggair/sdk";

// The publishable key (tg_pk_…) is safe in client code. NEVER put a tg_sk_ key here.
const tg = createClient({ key: "tg_pk_your_key" });
```

`createClient` needs only `key`. Options: `apiBase` (defaults to production),
`storage`, `fetch`, `flushIntervalMs`, `autoStart`, `online` (all injectable for
SSR/testing).

## Core recipes

```ts
// 1. Identity — anonymous by default; the token is minted + refreshed for you.
const { playerId } = await tg.login();

// 2. Cloud save (OCC): pass ifMatch for a conflict-safe write; omit for LWW.
const ref = await tg.saves.put("slot1", { level: 4, coins: 120 });
const { data } = await tg.saves.get("slot1");

// 3. Leaderboard: submit a score, read the top.
await tg.leaderboards.submit("high_scores", 9000);
const { entries } = await tg.leaderboards.top("high_scores", { limit: 10 });

// 4. Achievements: report progress; the reward lands in the inbox on unlock.
await tg.achievements.report("first_win", 1);

// 5. Analytics: durable + coalesced; queued offline, flushed on reconnect.
tg.track("level_complete");
```

## Offline resilience (automatic)

`tg.track(...)` and `tg.saves.queue(slot, data)` write to a **durable outbox**
(persisted in `localStorage`): they survive a dropped connection and replay on
reconnect, each carrying an `Idempotency-Key`. Saves coalesce last-write-wins per
slot; events coalesce by name. Reads use `saves.get` directly. You never handle this.

## Cross-device recovery

```ts
const { code } = await tg.mintRecoveryCode(); // show/share this once
// …later, on a new device:
await tg.recover(code); // same player, new token
```

## Errors

Every method throws a `TriggairError` on failure:

```ts
import { TriggairError } from "@triggair/sdk";
try {
  await tg.daily.claim();
} catch (e) {
  if (e instanceof TriggairError) {
    console.error(e.code, e.message, e.agentHint, e.requestId);
    // e.g. code "conflict" → "Already claimed" → hint "wait a day"
  }
}
```

`code` is the machine-readable §4 code (`unauthorized`, `save_conflict`,
`rate_limited`, `quota_exceeded`, `not_found`, `network`, …); `agentHint` is the
fix; `requestId` is the correlation id to quote. Transient failures (429/5xx/
network) are retried automatically with backoff.

## The "works locally, 403s deployed" trap

Browser calls are CORS-checked. If a call fails only once deployed, add your game's
origin to the game's **allowed_origins** (dashboard → game → CORS allowlist).

## Surface

Player-facing calls are the SDK; server-side setup (board/economy/flag/quest
definitions, moderation & age-gate policy) lives in the dashboard and the MCP
server. Every group returns typed results with the same `TriggairError` contract.

**Core** `tg.players` · `tg.stats` · `tg.saves` · `tg.leaderboards` · `tg.keyedBoards`
**Engagement** `tg.achievements` · `tg.daily` · `tg.inbox` · `tg.quests` · `tg.battlePass` · `tg.progression`
**Social** `tg.social` · `tg.teams` · `tg.ugc`
**Economy** `tg.economy` (currency · stores · inventory · `economy.loot` · `economy.energy`) · `tg.codes`
**Competition** `tg.tournaments` · `tg.leagues` · `tg.asyncMatch`
**LiveOps** `tg.config` · `tg.flags` · `tg.segments`
**Trust & safety** `tg.moderation` · `tg.compliance`
**Insight** `tg.analytics` · `tg.crashes`
**Realtime** `tg.realtime` (WebSocket rooms — presence + broadcast)
**Platform** `tg.storage` · `tg.rng`

Plus the top-level helpers: `tg.login/logout/recover/mintRecoveryCode`,
`tg.track`, `tg.flush`, `tg.stop`, `tg.playerId`.
