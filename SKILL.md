---
name: triggair-integration
description: >-
  Integrate Triggair — the agent-first game backend for browser games — into a new or
  existing JS/TS game with @triggair/sdk. Covers identity, cloud saves, leaderboards,
  stats, an anti-cheat-safe economy (currency/stores/inventory/loot/energy), daily
  rewards, inbox, achievements, quests, battle-pass, progression, friends & share
  links, teams/clans, tournaments/leagues, turn-based & realtime multiplayer, UGC +
  remix, remote config & feature flags, segments, moderation, age-gate/compliance,
  analytics, crash reporting, promo codes, keyed boards, storage, and deterministic
  RNG. Use whenever a game needs a backend feature — one import, one publishable key.
---

# Integrating Triggair into a game

Triggair is a **full, agent-first backend for browser games**. Everything a game needs —
identity, saves, leaderboards, an economy, live-ops, competition, moderation, realtime —
is behind **one import (`@triggair/sdk`) and one publishable key**. Every method is typed;
every failure throws a `TriggairError` carrying an `agentHint` that tells you how to fix
the call. This document is the integration skill: read the **Mental model** first, then the
**Playbook**, then jump to the **Feature reference** for the exact call you need.

Works in any browser JS/TS game (vanilla, React, Phaser, Three.js, PixiJS, a raw `<canvas>`,
Astro/Vite, etc.) and in Node/tests (inject `fetch`/`storage`/`webSocket`).

---

## Install & initialize

```bash
npm i @triggair/sdk
```

```ts
import { createClient } from "@triggair/sdk";

// The publishable key (tg_pk_…) is SAFE in client code. NEVER put a secret key (tg_sk_…) here.
const tg = createClient({ key: "tg_pk_your_key" });

// Optional but recommended: establish a session up front (also returns the player id).
const { playerId } = await tg.login();
```

`createClient` needs only `key`. Other options (all optional, mostly for SSR/tests):
`apiBase` (defaults to `https://api.triggair.com`), `storage` (KV; defaults to
`localStorage` → in-memory), `fetch`, `flushIntervalMs` (outbox timer, default 15 s;
`0` disables), `autoStart` (default true), `online` (connectivity predicate),
`webSocket` (WS constructor for realtime; pass `ws` in Node).

**Two key types.** `tg_pk_…` (publishable) ships in the game client. `tg_sk_…` (secret) is
for server-side/CI/admin only and must never touch client code or a repo. If you only have a
secret key, stop and get the publishable one from the dashboard.

---

## Mental model — the rules that make an integration correct

1. **Identity is anonymous-first and automatic.** The first player-scoped call mints an
   anonymous player token (bound to a random device id in `localStorage`) and silently
   refreshes it. There is **no login wall**. `await tg.login()` just forces the mint early and
   returns `{ playerId }`. To move an account to a new device, use
   `tg.mintRecoveryCode()` → `tg.recover(code)`.

2. **`pk` calls vs `player` calls.** Read-only/public calls (leaderboard `top`, `config`,
   `flags`, `ugc.browse`, `resolveShare`, `compliance.policy`) work with just the publishable
   key — no token, so they run before login (great for share-link landing pages). Everything
   that reads or writes "me" needs a player token, which is auto-minted. The reference below
   marks each group's auth.

3. **The server is authoritative for anything valuable.** Currency, inventory, XP, energy,
   scores, achievement unlocks, quest/tier completion — the **client can never grant these**.
   There is deliberately no client "add currency" call. This kills the entire class of
   "player edited their balance" cheats. Your job is to *report* activity and *read* state.

4. **The inbox is the one hardened grant path.** Rewards from daily bonuses, achievements,
   quests, battle-pass tiers, tournaments, gifts, and level-ups **escrow to the player's
   inbox**, and the player claims them with `tg.inbox.claim(id)`. Claims are **exactly-once**
   (keyed by the message id) — a retry or double-tap never double-grants. Grant into your game
   only after a successful claim.

5. **Writes are idempotent / conflict-safe by construction.** Economy writes (`buy`,
   `loot.open`, `consume`, `energy.spend`, gifts), `codes.redeem`, and `inbox.claim` carry an
   idempotency key so a transport retry never double-applies. Mutable documents use optimistic
   concurrency: `saves.put`/`storage.put` take `{ ifMatch: version }` and throw
   `save_conflict`/`storage_conflict` on a stale write; `asyncMatch.turn` takes the `version`
   you last saw and throws `async_conflict`. On a conflict: re-read, merge, retry once.

6. **Offline is handled for you.** `tg.track(name)` (count events) and `tg.saves.queue(slot,
   data)` write to a **durable outbox** in `localStorage` that survives a dropped connection
   and replays on reconnect (saves coalesce last-write-wins per slot; events coalesce by
   name). Reads and immediate writes (`saves.put`) go direct. You never manage this.

7. **Every failure is a typed, self-describing `TriggairError`.** It carries `code`
   (machine-readable), `message` (human), `agentHint` (the fix), `doc` (a link), `requestId`
   (to quote), and `retryable`. Transient failures (429/5xx/network) are retried automatically
   with backoff — you only catch the *semantic* ones (`insufficient_funds`, `conflict`,
   `save_conflict`, `out_of_energy`, `age_restricted`-style gates, …).

8. **Time and randomness live on the server.** Daily resets, streaks, energy regen, and event
   windows are gated on **server time** (never `Date.now()`), so a clock change can't cheat
   them. Shared "same board for everyone today" randomness comes from `tg.rng.seed(...)` whose
   secret never leaves the server.

9. **Runtime is the SDK; definitions are the dashboard/MCP.** The SDK is the *player-facing
   runtime*. The *definitions* it reads — which boards/currencies/stores/items/loot tables/
   flags/quests/achievements/seasons/tournaments exist, moderation & age-gate policy — are
   authored in the Triggair **dashboard** or via the **MCP server** (`mcp.triggair.com`,
   `triggair_*` tools). If a call 404s on an unknown key, the definition hasn't been created
   yet.

10. **The "works locally, 403s in prod" trap.** Browser calls are CORS-checked. If a call
    fails only once deployed, add your deployed origin to the game's **allowed_origins**
    (dashboard → game → CORS allowlist). A `cors_forbidden` / `network` error with that hint
    means exactly this.

---

## Integration playbook

**Adding Triggair to a NEW game**
1. `npm i @triggair/sdk`; create the client once at boot with your `tg_pk_…` key; export the
   `tg` instance so the whole game shares it.
2. Call `await tg.login()` at startup so a player exists from frame one (optional — any
   player call also mints one).
3. Pick the features you need from the reference below and wire the *runtime* calls.
4. Create the matching *definitions* (board keys, currencies, items, stores, flags, quests,
   achievements, …) in the dashboard/MCP. Keys are just strings you choose; the first use of a
   board/stat/save-slot name typically auto-creates it, but economy/quest/achievement/flag
   *definitions* must exist server-side.
5. Add your deployed origin to allowed_origins before shipping.

**Adding Triggair to an EXISTING game**
1. Find the moments the game already has — game-over, level-complete, purchase, match-end,
   save-point — and attach the matching call there (`leaderboards.submit`, `achievements.report`,
   `stats.update`, `saves.put`/`queue`, `economy.buy`). Don't build new screens; hook the
   natural moment.
2. Replace any home-grown "cloud save"/"login"/"score table" with the Triggair equivalent and
   delete the custom backend. Migrate a local save by writing the current state once with
   `saves.put`.
3. Gate risky features behind `tg.flags` / `tg.config` so you can tune or kill them live.

**Verify.** After wiring, run the MCP tool `triggair_verify_integration` to confirm the
integration end-to-end (keys, CORS, a real round-trip). Locally, a quick smoke test:
`await tg.login(); await tg.leaderboards.submit("smoke", 1); await tg.leaderboards.top("smoke");`.

---

## Top-level client API

| Member | Purpose |
| --- | --- |
| `tg.login(): Promise<{ playerId }>` | Ensure a session (mint/refresh) → the player id. |
| `tg.logout(): void` | Drop the cached token (keeps device identity). |
| `tg.mintRecoveryCode(): Promise<{ code, expires_at }>` | Mint a single-use cross-device rescue code. |
| `tg.recover(code): Promise<{ playerId }>` | Consume a recovery code on this device → same player. |
| `tg.playerId: string \| null` | The current player id (or null before first login). |
| `tg.track(name, count?): void` | Queue a durable, coalesced count event (offline-safe). |
| `tg.flush(): Promise<void>` | Flush the durable outbox now. |
| `tg.stop(): void` | Stop the outbox timer (call on teardown). |

Plus the domain groups below.

---

## Feature reference

Auth is noted per group: **pk** = works tokenless (publishable key); **player** = needs a
player token (auto-minted). Mixed groups note it per method.

### Identity & profile — `tg.players` (player; lookups pk)
- `me()` → `{ id, created_at, display_name }`
- `updateProfile({ display_name?, handle?, avatar_seed? })` → public profile
- `lookup(handle)` / `profile(id)` → `{ id, display_name, handle, avatar_seed, created_at, stats: {key,value,updated_at}[] }` (pk)

```ts
const me = await tg.players.me();
if (!me.display_name) await tg.players.updateProfile({ display_name: "Ada" });
```

### Stats — `tg.stats` (player)
Structured numeric stats; the substrate quests/leaderboards/progression read from.
- `get()` → `{ key, value, visibility, updated_at }[]`
- `update(ops)` — 1–50 atomic ops applied as a batch → affected stats.
  `ops: { key, op: "increment" | "set", value, visibility?: "public"|"private" }[]`

```ts
await tg.stats.update([{ key: "coins_collected", op: "increment", value: 12 }]);
```

### Cloud saves — `tg.saves` (player)
Per-slot JSON blobs with optimistic concurrency + a durable offline queue.
- `put(slot, data, { ifMatch? })` → `{ slot, version, updated_at }` (omit `ifMatch` = last-write-wins; pass it for OCC → throws `save_conflict` on mismatch)
- `queue(slot, data): void` — durable, offline-tolerant write (replays on reconnect)
- `get(slot)` → `{ slot, version, updated_at, data }` (throws `not_found` if the slot is empty)
- `list()` → slot metadata `{ slot, version, updated_at, size }[]`
- `remove(slot)`

```ts
await tg.saves.put("main", { level: 12, gold: 3400 });      // immediate
tg.saves.queue("autosave", state);                          // offline-safe autosave
try { const { data } = await tg.saves.get("main"); resume(data); }
catch (e) { if (e.code === "not_found") startNewGame(); else throw e; }
```

### Leaderboards — `tg.leaderboards` (submit/aroundMe/friends = player; top = pk)
- `submit(board, score, { elapsedMs? })` → `{ ok, best_score, period_key }` (best-wins; `elapsedMs` is a tiebreaker + anti-cheat signal)
- `top(board, { limit?, periodKey? })` → `{ board, period_key, entries: BoardEntry[] }` (pk)
- `aroundMe(board, { window? })` → entries centered on the caller + `me`
- `friends(board)` → the caller's friends' entries + `me`

`BoardEntry` = `{ rank, player_id, display_name, handle, avatar_seed, score, elapsed_ms }`.
Daily/weekly/all-time resets are built in — read a period via `periodKey`, or omit for the
current one. Anti-cheat (z-score, min-elapsed, rate caps, proof/replay) is configured per
board server-side; submissions are silently filtered, never revealed to the client.

```ts
await tg.leaderboards.submit("high_score", 9000);
const { entries } = await tg.leaderboards.top("high_score", { limit: 10 });
```

### Keyed boards — `tg.keyedBoards` (submit = player; reads = pk)
Rank arbitrary entities (a UGC level, a team, any key), not just players.
- `submit(board, entityId, score, { entryMeta? })` → aggregated `{ ok, score, samples, period_key }`
- `top(board, { limit?, periodKey? })` → `{ board, entity_type, period_key, entries }`
- `entry(board, entityId)` → `{ board, period_key, entry | null }`

### Achievements — `tg.achievements` (player)
Configured in the dashboard; report progress from the natural gameplay moment.
- `list()` → trophies `{ key, name, description, target, rewards, secret, progress, unlocked, unlocked_at }[]`
- `report(key, amount, { op?: "increment"|"set" })` → `{ key, progress, target, unlocked, unlocked_at, reward_granted }`

Unlock fires **exactly once**; a reward escrows to the inbox (`reward_granted: true`). Reporting past the target never re-fires.

```ts
function onEnemyKilled(e) { tg.achievements.report("kills_total", 1); }
```

### Daily rewards & streaks — `tg.daily` (player)
- `status()` → `{ streak_count, longest_streak, claimable, day_index, cycle_length, next_reward, server_day, … }`
- `claim()` → `{ claimed, streak_count, day_index, reward }` — server-time gated, exactly-once per server-day (re-claim throws `conflict`); reward escrows to the inbox.

```ts
const s = await tg.daily.status();
if (s.claimable) { await tg.daily.claim(); /* then inbox.claim */ }
```

### Inbox — `tg.inbox` (player)
The unified, hardened grant path. Every escrowed reward lands here.
- `list({ limit? })` → `InboxItem[]` (`{ id, kind, body, rewards, read, claimed, claimable, created_at, expires_at }`)
- `read(id)` — mark read
- `claim(id)` → `{ applied: true, rewards, stats }` **or** `{ applied: false, reason }` where reason ∈ `already_claimed | no_rewards | expired`. Exactly-once; safe to retry (a no-op returns `applied:false` rather than throwing).

```ts
for (const m of await tg.inbox.list()) {
  const r = await tg.inbox.claim(m.id);
  if (r.applied) applyRewards(r.rewards);
}
```

### Economy — `tg.economy` (player; `loot.odds` = pk)
Server-authoritative wallet, inventory, storefront, loot, gifts, energy. Currency only enters
via a reward, a validated purchase, or an operator grant — **never from the client**.

**Wallet & inventory**
- `wallet()` → `{ currency, balance }[]` · `balance(currency)` → one balance
- `history({ limit?, cursor? })` → ledger `{ lines, next_cursor }`
- `inventory()` → `{ item_id, qty, equipped, expires_at }[]`
- `equip(itemId)` / `unequip(itemId)` · `consume(itemId, qty, { idem? })`

**Store** (definitions in dashboard)
- `stores()` → `{ key, name }[]` · `listings(storeKey)` → `{ id, item_id, grant_qty, price:[{currency,amount}], purchase_limit, stock, sort }[]`
- `buy(storeKey, listingId, { idem? })` → `{ kind: "applied"|"replay", txn_id, lines }` — atomic spend→grant, idempotent. Throws `insufficient_funds`, `out_of_stock`, `store_limit_reached`.

**Loot boxes**
- `loot.odds(key)` → `{ target, weight, probability }[]` (pk — always disclose these)
- `loot.open(key, { idem? })` → `{ kind:"opened"|"replay", txn_id, result:{target,amount}, lines }` — server-rolled, idempotent; **age-gated** (throws when the player is a minor / unknown age — see compliance).

**Gifts** — `gifts.send(to, item, { qty?, idem? })` → escrows a tradable item into the recipient's inbox.

**Energy** (regen off server time) — `energy.all()` / `energy.get(meter)` → `{ meter, current, max, regen_period_sec, next_regen_at, full_at }`; `energy.spend(meter, amount, { idem? })` (fail-closed `out_of_energy`); `energy.refill(meter, { idem? })` (pays the configured price).

```ts
const wallet = await tg.economy.wallet();               // [{ currency, balance }]
try {
  await tg.economy.buy("main_store", listingId);        // atomic spend → grant
} catch (e) {
  if (e.code === "insufficient_funds") promptTopUp(); else throw e;
}
```

### Promo codes — `tg.codes` (player)
- `redeem(code)` → `{ redeemed, campaign, granted:[{target,delta,balance_after}] }` — exactly-once; fail-closed with `code_invalid | code_expired | code_already_redeemed | code_campaign_exhausted | code_wrong_audience`.

### Quests — `tg.quests` (player)
- `list()` → `{ key, name, period, state:"active"|"completed"|"claimed", progress:[{signal,op,target,current,met}] }[]` (progress is a server projection over your stats)
- `claim(key)` → `{ claimed, reason?, reward? }` — reward escrows to the inbox; `quest_not_complete` if unmet.

### Progression (XP & levels) — `tg.progression` (player)
- `get()` → `{ xp, level, xp_into_level, xp_for_next, max_level, leveled_up }` — XP is server-authoritative (granted via the game's xp reward key); level-up rewards deliver to the inbox and `leveled_up` counts how many landed on this read.

### Battle pass — `tg.battlePass` (player)
- `get(season)` → `{ season_key, name, state, bp, tier, has_premium, claimed_free[], claimed_premium[], tiers:[{tier,bp_required}], starts_at, ends_at }`
- `claim(season, tier, lane = "free"|"premium")` → `{ claimed, reason?, reward? }` — reward escrows to the inbox; `tier_not_earned`/`premium_required` if ineligible.

### Friends & share links — `tg.social` (player; `resolveShare` = pk)
- `friends()` / `requests()` → `FriendProfile[]`
- `request(id)` → `{ state:"pending"|"accepted" }` · `remove(id)` · `block(id)`
- `share(context?, { expiresInSeconds? })` → `{ code, expires_at }` — mint a context-carrying code (≤4 KB)
- `resolveShare(code)` → `{ code, player_id, context, created_at, expires_at }` (**pk — resolves before login**, so a share-link landing page shows the challenge first, then mints the account)

A friends-only leaderboard slice is `tg.leaderboards.friends(board)`.

```ts
const { code } = await tg.social.share({ board: "daily", score: 8420 });
// landing page (?s=code), before login:
const { context } = await tg.social.resolveShare(code);
```

### Teams / clans — `tg.teams` (writes = player; `get`/`browse`/`leaderboard` = pk)
- Create/discover: `create(name, tag, { privacy:"open"|"closed"|"invite_only" })` → `{ team }`; `browse({ q?, limit? })`; `get(id)`; `mine()`
- Membership: `join(id)` · `leave(id)` · `requestJoin(id)` · `requests(id)` / `approveRequest(id,reqId)` / `rejectRequest(id,reqId)`
- Invites: `invite(id,playerId)` · `myInvites()` / `acceptInvite(inviteId)` / `rejectInvite(inviteId)`
- Admin (role-gated): `setRole(id,playerId,"admin"|"member")` · `kick` · `ban`/`unban`/`bans` · `transfer` · `disband`
- **Team leaderboard:** `leaderboard(board, { agg:"sum"|"max"|"avg", period?, limit? })` → `{ team_id, name, tag, value, members }[]`, aggregating your existing player board.

> Caveat: `teams.leaderboard` always returns **highest aggregate first**, regardless of the
> underlying board's direction — sort client-side for lower-is-better boards. Role-gated
> actions throw `team_forbidden`; a taken tag throws `conflict`; a full roster `team_full`.

### Tournaments — `tg.tournaments` (browse/standings = pk; join/mine/me = player)
- `list()` / `get(id)` / `standings(id, { limit? })` (pk)
- `join(id)` → `{ joined, reason?, fee_txn? }` (pays any entry fee; `already_entered`, `tournament_not_open/closed`, `insufficient_funds`)
- `mine()` · `me(id)` → live rank + prize once closed (prize escrows to the inbox). Scores go through `tg.leaderboards.submit`.

### Leagues (promotion/relegation) — `tg.leagues` (join/me = player; `divisionTop` = pk)
- `join(key)` → `{ joined }` (placed in the lowest division; idempotent)
- `me(key)` → `{ member, season, division, division_name, rank, members, zone:"promoting"|"safe"|"relegating" }`
- `divisionTop(key, tier)` → `{ player_id, score, rank }[]`

A league rides a leaderboard — submit round scores with `tg.leaderboards.submit`; season
advance (promotion/relegation) runs server-side.

### Turn-based multiplayer — `tg.asyncMatch` (player)
Server-enforced turn order + optimistic concurrency; the next player is notified via inbox.
The game owns the opaque `state`.
- `create(players, { type?, state? })` → `{ match }` (include yourself; first player moves first)
- `get(id)` / `mine()`
- `turn(id, { version, state, next?, end?: { winner? } })` → `{ match }` — pass the `version` you last saw; `not_your_turn` / `async_conflict` (stale version) on rejection; `end:{winner}` finishes.
- `forfeit(id)` → `{ forfeited, winner }`

`AsyncMatch` = `{ id, type, turn_order, current_turn, state, version, turn_number, status, winner }`.

### Realtime rooms — `tg.realtime` (player)
Authenticated WebSocket broadcast rooms: presence + message fan-out (client-authoritative;
no server simulation).
- `join(room)` → resolves a `RoomConnection` once the server welcome arrives.

`RoomConnection`:
- `you: string`, `members: string[]`, `history: RoomMessage[]` (readonly)
- `on(event, handler) => unsubscribe` — events: `'message'` → `{ from, data, ts }`;
  `'presence'` → `{ event:"join"|"leave", player, members }`; `'close'` → `{ code? }`; `'error'` → `{ message }`
- `send(data): void` — broadcast · `close(): void`

```ts
const room = await tg.realtime.join("arena-1");
room.on("message", ({ from, data }) => moveGhost(from, data));
room.on("presence", ({ event, player }) => event === "leave" && removeGhost(player));
const id = setInterval(() => room.send({ x: p.x / W, y: p.y / H }), 80); // ~12 Hz
// teardown: clearInterval(id); room.close();
```

In Node/tests pass a WS impl: `createClient({ key, webSocket: WebSocket })`.

### User-generated content — `tg.ugc` (author/rate = player; `browse`/`lineage` = pk)
Draft → moderated publish → browse → play-gated rate → remix with lineage. `payload` is
structured JSON ≤256 KB.
- `create(type, { title?, description?, payload?, tags?, allow_remix? })` → `{ item }` (private draft)
- `update(id, patch)` (resets to draft) · `delete(id)` · `mine()` · `get(id)`
- `submit(id)` → `{ state, moderation_state }` (runs moderation on title/description)
- `browse({ type?, sort:"new"|"top"|"popular", limit? })` (pk) · `get`/`lineage(id)` (pk)
- `play(id)` (unlocks rating) → then `rate(id, 1..5)` · `like(id)`/`unlike(id)`
- `remix(id)` → forks a public remix-allowed item into your draft with attribution;
  `lineage(id)` → `{ remix_of, root_id, remixes:[{id,author_id,title}] }`

Pair a per-item record with `tg.keyedBoards` keyed by the UGC id.

### Remote config & feature flags — `tg.config`, `tg.flags`, `tg.segments` (pk; personalized with a token)
- `config.get()` → the resolved config blob (base + flags + live-event overlays) + `_meta`; read on boot and default every value.
- `config.liveEvents()` → `{ key, name, ends_at }[]` live now for the caller.
- `flags.get(key, fallback)` / `flags.bool(key, fallback?)` / `flags.variant(key, fallback)` / `flags.all()` — **fail-safe**: an unknown/off/errored flag returns your fallback. Use a boolean flag as a kill switch.
- `segments.mine()` → the player's segments (auto-personalize config/flags when a token is present).

```ts
const cfg = await tg.config.get();
const mult = cfg.scrip_multiplier ?? 1;                 // live-tunable, no redeploy
if (await tg.flags.bool("new_arena_enabled")) enableArena(); else showClassic();
```

### Deterministic RNG — `tg.rng` (pk; `scope:"player"` = player)
- `seed(stream, { period?: "daily"|"weekly"|"all_time", scope?: "shared"|"player" })` → `{ stream, period, period_key, scope, seed }`

`scope:"shared"` gives every player the *same* seed this period (the Wordle "same board for
everyone today" trick); `scope:"player"` is per-player-but-unpredictable. The secret behind
the seed never leaves the server, so tomorrow's board can't be datamined. Derive content
deterministically from the hex `seed`.

### Moderation — `tg.moderation` (player)
- `check(surface, text)` → `{ verdict:"allow"|"mask"|"block"|"review", masked_text?, categories, severity, tier }`
  surfaces: `"player_name" | "team_name" | "chat" | "dm" | "ugc"`. Enforcement is yours per
  surface: **block** a name (reject the field), **mask** chat (send `masked_text`), route
  **review** to a queue. Defeats leet/homoglyph/spacing evasion. Check names *before* display.
- `report(target_type, target_id, reason, note?)` → `{ report }` (a duplicate open report is a 409 no-op = success)
- `appeal(banId, body)` · `myStatus()` → `{ banned, bans, restrictions }` (render "muted until…")

### Age-gate & compliance — `tg.compliance` (player; `policy` = pk)
- `setAge({ bracket })` or `setAge({ birthYear })` → the gated map. A birth year is mapped to a bracket and **discarded — no DOB stored**. Brackets: `"unknown"|"under13"|"13_15"|"16_17"|"adult"`.
- `status()` → `{ bracket, jurisdiction, consent_state, gated: Record<Feature, boolean> }` — read `gated` to pre-disable UI. Features: `lootbox, real_money_iap, open_chat, public_ugc, behavioral_push, friend_from_stranger`.
- `policy()` (pk) · `requestConsent(parentEmail)` / `consent()` — verifiable parental consent for minors.

Gates **fail closed**: unknown age → every sensitive feature is `false`. Enforcement is
server-side too (e.g. `loot.open` throws for a minor); the `gated` map lets you hide the UI
first. Ask a neutral birth-year screen once, early.

```ts
const { gated } = await tg.compliance.status();
if (!gated.lootbox) hideLootStore();
if (!gated.open_chat) useQuickChatOnly();
```

### Analytics & crashes — `tg.analytics`, `tg.crashes` (player); count events via `tg.track`
- `tg.track(name, count?)` — durable, coalesced count events (offline outbox). The default for funnels.
- `analytics.event(name, props?, { ts?, consent? })` / `analytics.send(events, { consent? })` — typed prop-bearing events; props are PII-stripped unless `consent:true`.
- `crashes.report(message, { stack?, platform?, appVersion?, ts? })` → `{ group_id, status }` (server fingerprints/groups; throttle re-reporting a resolved group).

### Keyed storage — `tg.storage` (player; shared/team scopes)
General keyed-JSON document store with OCC and atomic field ops — for state that isn't a
save slot (settings, collections, per-level records).
- Player: `get/put/delete(collection, key, …)` (OCC via `{ ifMatch }`), `incr(collection, key, field, by?)`, `append(collection, key, field, value)`, `list(collection)`, `getOther(collection, key, ownerId)`
- `storage.shared.get/put(collection, key, …)` — one game-global doc per key (write gated by policy)
- `storage.team.get/put/delete/list(teamId, collection, key, …)` — team-owned docs (member-gated)

---

## End-to-end recipes

**Leaderboard on game-over**
```ts
await tg.leaderboards.submit("high_score", score, { elapsedMs });
const { entries } = await tg.leaderboards.top("high_score", { limit: 10 });
```

**Daily-reward retention loop**
```ts
const s = await tg.daily.status();
if (s.claimable) {
  await tg.daily.claim();                       // escrows to inbox
  for (const m of await tg.inbox.list()) {      // then claim it into the game
    const r = await tg.inbox.claim(m.id);
    if (r.applied) applyRewards(r.rewards);
  }
}
```

**Server-authoritative store purchase**
```ts
const listings = await tg.economy.listings("main_store");
try { const res = await tg.economy.buy("main_store", listings[0].id); grant(res); }
catch (e) { if (e.code === "insufficient_funds") openCoinStore(); else throw e; }
```

**Loot box with the age gate**
```ts
async function openCrate(key) {
  try { return await tg.economy.loot.open(key); }
  catch (e) {
    if (e.code === "age_restricted" || e.code === "forbidden") {
      const ok = await showAdultAgeScreen();      // ask a real birth year
      if (ok) { await tg.compliance.setAge({ bracket: "adult" }); return tg.economy.loot.open(key); }
    }
    throw e;
  }
}
```

**Turn-based move with conflict handling**
```ts
const { match } = await tg.asyncMatch.get(id);
try {
  await tg.asyncMatch.turn(id, { version: match.version, state: next, end: won ? { winner: tg.playerId } : undefined });
} catch (e) {
  if (e.code === "async_conflict") { const fresh = await tg.asyncMatch.get(id); rerender(fresh.match); }
  else throw e;
}
```

**Provably-fair daily challenge**
```ts
const { seed, period_key } = await tg.rng.seed("daily", { period: "daily", scope: "shared" });
const board = deriveBoard(seed);                 // same for everyone today, unpredictable ahead
```

---

## Error handling

```ts
import { TriggairError } from "@triggair/sdk";
try {
  await tg.economy.buy("store", "listing_1");
} catch (e) {
  if (e instanceof TriggairError) {
    // e.code, e.message, e.agentHint (the fix), e.doc, e.requestId, e.retryable
    if (e.code === "insufficient_funds") return promptTopUp();
    console.error(e.code, e.agentHint, e.requestId);
  }
  throw e;
}
```

Transport-level `code`s: `bad_request`, `unauthorized`, `forbidden`, `cors_forbidden`,
`conflict`, `save_conflict`, `not_found`, `payload_too_large`, `quota_exceeded`,
`rate_limited`, `internal`, `network`. Domain calls add semantic codes shown per group above
(`insufficient_funds`, `out_of_stock`, `out_of_energy`, `async_conflict`, `not_your_turn`,
`quest_not_complete`, `tier_not_earned`, `code_*`, `team_*`, `storage_conflict`, …).
`rate_limited`/`network`/5xx are `retryable` and retried for you — don't loop on the rest.

---

## What's in the SDK vs the dashboard/MCP

| In the game (this SDK) | In the dashboard / MCP (`triggair_*`) |
| --- | --- |
| Runtime player calls: submit/read/claim/buy/report/join/… | Definitions: boards, currencies, items, stores, loot tables, energy meters |
| Reading config/flags/segments | Authoring config, flags, segments, live events |
| Reporting achievement/quest progress | Achievement/quest/battle-pass/season/tournament definitions |
| `moderation.check`, `compliance.setAge/status` | Moderation policy, custom term lists, age-gate policy |
| — | Keys (pk/sk), CORS allowlist (allowed_origins), `triggair_verify_integration` |

## Quick checklist

- [ ] `createClient({ key: "tg_pk_…" })` once; share the instance. No `tg_sk_` in client code.
- [ ] `await tg.login()` early (optional; any player call also mints).
- [ ] Hook calls to moments the game already has (game-over, level-complete, purchase, save).
- [ ] Rewards: escrow → `inbox.claim` (exactly-once) → grant into the game.
- [ ] Never trust the client for value; report activity, read authoritative state.
- [ ] Wrap value/gate calls and handle their semantic `code`s; let transient ones auto-retry.
- [ ] Create the matching server-side definitions (dashboard/MCP) for any keyed feature.
- [ ] Add your deployed origin to allowed_origins; run `triggair_verify_integration`.
