# PLAN.md

Build order, schema, and API contract. Read `CLAUDE.md` for rules of engagement and
`GAMERULES.md` for game behavior.

**Constraint: this ships tonight.** Phases 0-5 are the game. Phase 6 is optional.
If time runs short, stop and ship — the paper sheet and playing cards are the fallback
for anything unbuilt. See the timing note at the bottom before you start.

---

## What the app replaces

| Physical thing | Replaced by |
|---|---|
| Drawing playing cards | Server-side role assignment |
| "Everyone close your eyes" ritual | Imposters see their fellow imposters' names |
| Paper task checklist | Per-player task tracking |
| Shouting "who already called a meeting?" | Meeting button that greys out permanently |
| Shouting "MEETING!" across a dark house | Every screen flashes red simultaneously |
| Waiting around wondering if everyone arrived | "I am here" check-in, auto-starts the meeting |
| Someone counting 90 seconds on a watch | Server-authoritative synced timer |
| Sliding cards face-down across a table | Simultaneous voting, auto-tallied |
| Arguing about whether crewmates won | Automatic win detection |
| Manually toggling your flashlight | Full-white task screen |

---

## Phase machine

```
lobby -> playing -> gathering -> meeting -> voting -> results -> playing
                                                                   |
                                                                 ended
```

`gathering` is new and sits between a meeting being called and the discussion starting.
See "Meeting gathering" below.

---

## Data model

Two tiers. **Public** tables are client-readable and Realtime-enabled. **Secret** tables
have RLS on with no anon policy and are touched only by the server with the service role.

### Public

**`rooms`** — one row per lobby.
```
code            text primary key         -- 4 chars, see alphabet below
phase           text not null            -- lobby|playing|gathering|meeting|voting|results|ended
round           int not null default 0
meeting_no      int not null default 0   -- increments per meeting within a round
phase_ends_at   timestamptz              -- null during lobby and playing
tasks_done      int not null default 0   -- aggregate only
tasks_total     int not null default 0
here_count      int not null default 0   -- checked in during gathering
expected_here   int not null default 0   -- living players at the moment the meeting was called
votes_cast      int not null default 0   -- count only, never who or for whom
last_result     jsonb                    -- see "Vote result shape"
winner          text                     -- null|crew|imposters
meeting_reason  text                     -- emergency|report
reported_body_name text                  -- set only when meeting_reason='report'
imposter_count  int not null default 2
task_capacity   int not null default 1   -- max simultaneous occupants per station (was 2 pre-2026-08-07)
tasks_per_player int                     -- null = every player does every task
anonymous_voting boolean not null default true
show_task_bar   boolean not null default true
imposter_tasks_count boolean not null default false
ghost_tasks     boolean not null default false
gathering_secs  int not null default 90  -- safety timeout, not the discussion timer
meeting_secs    int not null default 90
voting_secs     int not null default 15  -- (was 30 pre-2026-08-07)
results_secs    int not null default 15
created_at      timestamptz not null default now()
```

**`players`** — roster. Public columns only.
```
id                 uuid primary key default gen_random_uuid()
room_code          text not null references rooms(code) on delete cascade
name               text not null
has_called_meeting boolean not null default false
is_host            boolean not null default false
joined_at          timestamptz not null default now()
unique (room_code, lower(name))
```
Note what is **not** here: no role, no alive/dead, no task progress, no token, no
check-in flag.

**`tasks`** — authored by the host in the lobby. Count is variable, there is no fixed 8.
```
id           uuid primary key default gen_random_uuid()
room_code    text not null references rooms(code) on delete cascade
order_index  int not null
name         text not null
location     text not null
description  text                       -- optional, often blank
```

**`task_occupancy`** — how full a station is, with no identity attached.
```
room_code    text not null
task_id      uuid not null references tasks(id) on delete cascade
occupied     int not null default 0     -- 0..task_capacity
primary key (room_code, task_id)
```

### Secret

**`room_secrets`** — `room_code pk, host_pin text`

**`player_secrets`** — `player_id pk, token uuid unique, is_alive boolean default true, is_here boolean default false, reported boolean default false`

**`player_roles`** — `player_id, round, role text ('crew'|'imposter'), primary key (player_id, round)`

**`player_tasks`** — `player_id, task_id, round, completed_at timestamptz, reveal_at timestamptz, primary key (player_id, task_id, round)`
`reveal_at = completed_at + random(1..5) seconds`. See "Delayed task bar" below.
Rows exist only for tasks that player was **assigned** this round.

**`task_claims`** — `room_code, task_id, player_id, started_at, expires_at, primary key (room_code, task_id, player_id)`

**`votes`** — `room_code, round, meeting_no, voter_id, target_id (null = skip), primary key (room_code, round, meeting_no, voter_id)`

### Lobby codes

4 characters from `ACDEFGHJKLMNPQRTUVWXY23467 9` — **`O`, `0`, `I`, `1`, `S`, `5`, `8`,
`B` are excluded** because people will be reading this off a screen in a dark room.
Generate on create, retry on primary key collision.

### RLS

```sql
alter table rooms enable row level security;
alter table players enable row level security;
alter table tasks enable row level security;
alter table task_occupancy enable row level security;
create policy anon_read on rooms for select to anon using (true);
create policy anon_read on players for select to anon using (true);
create policy anon_read on tasks for select to anon using (true);
create policy anon_read on task_occupancy for select to anon using (true);
-- no insert/update/delete policies for anon anywhere

alter table room_secrets enable row level security;
alter table player_secrets enable row level security;
alter table player_roles enable row level security;
alter table player_tasks enable row level security;
alter table task_claims enable row level security;
alter table votes enable row level security;
-- deliberately NO policies at all: anon is locked out entirely,
-- service_role bypasses RLS
```

Note `player_tasks` is secret even though it seems harmless. Once tasks are randomly
assigned per player, knowing which tasks someone was assigned tells you where they had
legitimate reason to be — which is exactly the deduction the game is about.

### Realtime publication

```sql
alter publication supabase_realtime add table rooms, players, tasks, task_occupancy;
```
**Realtime is off by default per table.** If you skip this, subscriptions will connect
successfully and silently deliver nothing, and you will lose twenty minutes to it. Do
this in the very first migration and verify it before writing any UI.

---

## API contract

All under `app/api/`. All take `x-player-token` except `create` and `join`. All responses
include `serverTime`.

| Route | Body | Behavior |
|---|---|---|
| `POST /room` | `{hostName}` | Creates room + host player, returns `{code, token, playerId}` |
| `POST /join` | `{code, name}` | Rejects duplicate names and non-`lobby` phases. Returns `{token, playerId}` |
| `GET /state?code=` | — | Phase-appropriate view. See below. |
| `POST /tasks` | `{pin, tasks: [{name, location, description?}]}` | Host only, `lobby` only. Replaces the whole task list. Simplest correct approach — no per-row edit endpoints. |
| `POST /settings` | `{pin, ...partial}` | Host only, `lobby` only. `imposterCount`, `anonymousVoting`, `tasksPerPlayer`, `taskCapacity`, `showTaskBar`, `ghostTasks`, `imposterTasksCount`, timer lengths. Validates and returns readable errors. |
| `POST /start-round` | `{pin}` | Host only. Resets `is_alive=true`, `reported=false`, `is_here=false` for every player. Validates counts, assigns roles, assigns each player's task subset, seeds `task_occupancy` at 0, computes `tasks_total`, `phase='playing'`, `round++`, `meeting_no=0`. **`has_called_meeting` is NOT reset** — it is once per game, per `GAMERULES.md`, and persists across rounds within the same lobby. |
| `GET /me` | — | `{role, partnerNames: string[], isAlive, isHere, myTasks: [{taskId, name, location, description, done}]}` |
| `POST /task/claim` | `{taskId}` | Capacity-checked insert, see below. 409 if full or not assigned to you. |
| `POST /task/complete` | `{taskId}` | Requires your own claim >= 14s old. Marks `player_tasks.completed_at=now()`, `reveal_at = now() + random(1..5)s`, decrements occupancy immediately (the station frees right away — the delay is only on the bar, not on gameplay). Does **not** touch `tasks_done` and does **not** check win itself — see "Delayed task bar" below. |
| `POST /tick` | — | Idempotent phase advance. Also recomputes `rooms.tasks_done` = count of `player_tasks` with `reveal_at <= now()` (crewmates only, unless `imposter_tasks_count`), and runs the win check against that number. Called by every client every 2s. |
| `POST /task/abandon` | `{taskId}` | Frees your claim early, decrements occupancy |
| `GET /bodies` | — | Living players only. Returns `[{playerId, name}]` for dead players **not yet reported this game** — powers the report-a-body popup. This is the one place a living player is told anyone is dead outside `meeting`/`voting`/`results`/`ended`, and it's deliberately narrow: names only, at the moment they choose to report, nothing pushed. |
| `POST /meeting` | `{reason, bodyPlayerId?}` | `emergency`: consumes `has_called_meeting`, 409 if already used, `bodyPlayerId` ignored. `report`: **requires `bodyPlayerId`**, 400 if missing; server verifies that player `is_alive=false` and `reported=false`, 409 if not (stale popup, someone else already reported it, or they're not actually dead); sets that player's `reported=true`; never consumes `has_called_meeting`. Both: cancels every active claim, zeroes all occupancy, sets `meeting_reason`, `reported_body_name` (report only, else null), `meeting_no++`, `expected_here` = current living count, `here_count=0`, all `is_here=false`, `phase='gathering'`, `phase_ends_at = now() + gathering_secs` |
| `POST /here` | — | Sets your `is_here`, increments `here_count`. When `here_count >= expected_here`, immediately advances to `meeting`. |
| `POST /force-meeting` | `{pin}` | Host only. Skips the rest of the check-in and starts the discussion now. |
| `POST /finish-meeting` | `{pin}` | Host only, `meeting` only. Ends the discussion early — same meeting->voting transition `/tick` makes on timeout. |
| `POST /dead` | — | Victim self-reports. Sets `is_alive=false`. During `gathering`, decrements `expected_here` so the meeting isn't blocked waiting on a corpse. Drops their incomplete tasks from `tasks_total` unless `ghost_tasks`. Checks win. **Returns nothing to anyone else until the meeting starts.** |
| `POST /vote` | `{targetId or null}` | Upsert into `votes`, increment `votes_cast`. Rejects if dead or phase != `voting`. If all living players have voted, immediately advance to `results`. |
| `POST /reset` | `{pin}` | Back to `lobby`, wipes round state, keeps roster and task list. |

### `/state` returns by phase

- **lobby** — roster, task list, `isHost`, all settings, live count validation
- **playing** — `tasks_done/tasks_total` (only if `show_task_bar`), occupancy per station, your own `myTasks`. **No alive/dead for anyone.**
- **gathering** — `here_count/expected_here`, seconds until the safety timeout, `meeting_reason`, `reported_body_name` if applicable. **Still no alive/dead roster** — that arrives when the discussion starts.
- **meeting** — full alive/dead roster (name + status for every player, not just
  living ones — this is the one phase where death is shown at all), `phase_ends_at`
  for a synced countdown, `meeting_reason`, `reported_body_name` if applicable
- **voting** — living roster as vote targets, `votes_cast` count only, seconds remaining
- **results** — `last_result` (see below)
- **ended** — `winner`, full role reveal for every player

### Vote result shape

```ts
last_result = {
  ejectedName: string | null,   // null on skip or tie
  wasImposter: boolean | null,
  skipped: boolean,
  tied: boolean,
  tally: { name: string, count: number }[],   // includes a "Skip" entry
  ballots?: { voterName: string, targetName: string }[]  // ONLY when anonymous_voting is false
}
```

`ballots` must be omitted from the payload entirely when `anonymous_voting` is true —
not sent-and-hidden, not sent-and-null-checked in the component. Omitted at the server.

Build the anonymous path first and completely. Open voting is one extra field on an
object that already exists; if the clock runs out it is the correct thing to lose.

### Task claiming with capacity

`task_capacity` defaults to 2. Claiming is a single server-side transaction:

```
delete expired claims for this task
count remaining claims for this task
if count >= task_capacity -> 409
if the task is not in this player's assigned list -> 403
insert claim (expires_at = now() + 25s)
set task_occupancy.occupied = count + 1
```

Do not compute capacity on the client. Two people tapping the last slot within the same
second is the normal case in a dark house, not an edge case.

`expires_at` handles the player who claims a station and is then killed: `/tick` clears
expired claims and recomputes occupancy. No cleanup job needed.

### Delayed task bar

**A completed task doesn't move the visible task bar right away.** On `/task/complete`,
`reveal_at` is set to `completed_at + a random 1-5 seconds`. The player's own checkmark
in `myTasks` (from `/me`) updates immediately — they know they finished it — but the
public `rooms.tasks_done` that everyone sees does not increment until `reveal_at` passes.

This is a deliberate fairness mechanic, not a bug: it blurs the exact moment a completion
happened, so the bar can't be used to time-stamp who was where. It gives imposters a
sliver more cover.

Implementation: don't increment `tasks_done` inline inside `/task/complete`. Instead
`/tick` recomputes it from scratch every 2 seconds — `count(player_tasks where
reveal_at <= now())`, filtered to crewmates unless `imposter_tasks_count` — and runs the
win check against that recomputed number. This reuses the tick's existing idempotent
recompute pattern instead of adding a second timer mechanism, and it guarantees every
phone sees the bar move at the same moment rather than 1-5 seconds apart depending on
when each phone happens to poll.

Do not implement this delay with a client-side `setTimeout`. If the delay lives in the
browser, a player who inspects the network tab sees the real completion instant in the
response and the whole point of the mechanic is gone — the delay has to be a fact about
when the server changes the number, not about when the UI chooses to redraw it.

Because of this delay, **the crew's win condition can trigger up to 5 seconds after the
task that actually completed it** — that's expected, not a bug to fix.

### Meeting gathering

The interesting failure mode: **a killed player who hasn't tapped "I was killed" blocks
the meeting forever.** Three independent guards, build all three:

1. `/dead` decrements `expected_here` when called during `gathering`
2. `gathering_secs` safety timeout auto-starts the discussion via `/tick`
3. Host `/force-meeting` button

Client behavior during `gathering`: full-screen red pulse (a CSS animation, roughly 1Hz,
respecting `prefers-reduced-motion`), the words **STAY QUIET — WALK TO THE TABLE**, an
"I AM HERE" button, and an "I WAS KILLED" button. Nothing else. No task list, no roster,
no counts beyond `here_count/expected_here`. The pulse stops the instant `is_here` is set,
and the screen goes to a still "waiting for others" state.

### Role assignment, task assignment, and count validation

Player count is whatever is in the lobby. Imposter count is `rooms.imposter_count`, set
by the host. Task count is `tasks.length`. **None of these are ever hardcoded.**

`/start-round` rejects with a readable error unless all hold:

- `imposter_count >= 1`
- `imposter_count * 2 < player_count`
- `tasks.length >= 1`
- `tasks_per_player` is null, or `1 <= tasks_per_player <= tasks.length`

The second is not cosmetic: the imposter win condition is `living imposters >= living
crewmates`, so a lobby of 6 with 3 imposters is already won at the moment roles are
dealt. The host panel shows the same validation live as players join, so Start Round is
disabled with an explanation rather than failing on tap.

Suggested imposter default shown in the host panel, overridable: 1 below 9 players,
2 from 9 to 14, 3 at 15+.

Assignment: shuffle the player list, first `imposter_count` become imposters, rows
written to `player_roles` for the current `round`.

Task assignment, per player:
- `tasks_per_player` null -> every task, for everyone
- otherwise -> an **independent random sample** of that size, drawn separately for each
  player. Imposters get a sample too, so their screen is indistinguishable.

`tasks_total` is computed from the resulting assignment, never from a constant:
sum of assigned task counts across the players who count toward the bar (crewmates only,
unless `imposter_tasks_count`).

### Win check

Run inside `/tick` (task-driven wins, since `tasks_done` is only current there — see
"Delayed task bar") and inline after `/dead` and after an ejection in `/vote` (these
aren't delayed, so no reason to wait for the next tick):
- `tasks_done >= tasks_total` -> `winner='crew'`
- living imposters `== 0` -> `winner='crew'`
- living imposters `>= living crewmates` -> `winner='imposters'`

Set `phase='ended'` and stop.

---

## Screens

- `/` — Create room (name + 4-digit host PIN) or Join
- `/join/[code]?` — Name entry, code prefilled from the URL so a QR scan is one tap
- `/host/[code]` — Lobby code huge, QR to `/join/[code]`, live roster with player count,
  **task editor** (add / edit / reorder / delete rows of name + location + description),
  imposter count stepper with live validation, tasks-per-player control, anonymous
  voting toggle, other settings, Start Round, Force Meeting, Reset. **The host also
  plays** — this is a second tab, not a separate person.
- `/room/[code]` — The player app. Single component switching on `phase`:
  - **lobby** — "waiting", roster
  - **playing** — role at top (`CREWMATE` dim red / `IMPOSTER` with fellow imposters
    listed beneath, nothing listed if solo), your assigned task list showing name,
    location and description with full stations greyed, task bar, an **Emergency
    Meeting** button (disabled once used, no popup needed), a **Report Body** button
    that opens a popup listing candidates from `GET /bodies` and requires picking one
    before it submits, and an "I was killed" button
  - **task active** — full white, 15s countdown, no other UI
  - **gathering** — red pulse, STAY QUIET, I AM HERE, I WAS KILLED
  - **meeting** — synced 90s countdown, full roster each marked alive or dead,
    `reported_body_name` shown if that's why the meeting was called
  - **voting** — tap a name or Skip, then locked with "waiting for others (n/m)"
  - **results** — ejection, whether they were an imposter, tally, plus per-voter ballots
    if open voting
  - **ended** — winner, full role reveal
  - **ghost overlay** — if dead, all action buttons disabled

---

## Build phases

**Phase 0 — Skeleton (20 min).** `create-next-app` with TS + Tailwind v4. Supabase
project. Migration with all tables, RLS, Realtime publication. Server and browser
Supabase clients. `.env.local`.
*Accept: `npm run build` passes; the anon key cannot select from `player_roles` or
`player_tasks` in the SQL editor.*

**Phase 1 — Lobby, tasks, roles (45 min).** Create, join, roster with Realtime, task
editor, settings, start-round with validation and task assignment, `/me`.
*Accept: four profiles join one code; host authors 5 tasks; with `imposterCount=1`
exactly one sees IMPOSTER with no partners, re-run at 2 and each sees the other;
`imposterCount=2` on a 4-player lobby is rejected before the round starts; the network
tab on a crewmate profile contains no imposter names in either configuration.*

**Phase 2 — Tasks in play (30 min).** Task list with location and description, claim /
complete / abandon, capacity of 2, white screen, task bar, delayed reveal.
*Accept: a third profile is refused a station holding 2; occupancy shows a count and
never a name; a claim abandoned by closing the tab frees itself within 25s; the bar
advances only on crewmate completions; the completing profile's own task list checks
off instantly on `/task/complete` while `rooms.tasks_done` on every profile's screen
visibly lags by 1-5 seconds before incrementing; two completions seconds apart can
reveal out of order.*

**Phase 3 — Gathering (25 min).** `/meeting`, `GET /bodies`, claim cancellation, red
pulse screen, `/here`, auto-start, `gathering_secs` timeout, `/force-meeting`.
*Accept: calling a meeting cancels an in-progress task on another profile mid-countdown
and returns no credit; all four screens pulse; the discussion starts the moment the last
one taps I AM HERE; with one profile never tapping, it starts anyway on timeout; a
profile tapping I WAS KILLED during gathering unblocks the others immediately; after one
profile dies, Report Body on a living profile shows exactly that name in the popup and
requires picking it before submitting; reporting that body does not disable the emergency
meeting button on any profile; calling emergency meeting on a different profile does not
disable Report Body or require picking a body; a second attempt to report the same body
after it's already been reported is rejected.*

**Phase 4 — Meeting and voting (35 min).** 90s and 30s timers, anonymous vote, tally,
tie-is-skip, ejection, results reveal.
*Accept: all four phones show the same countdown within one second; every phone's
meeting screen correctly marks the one dead profile as dead and the rest as alive;
no vote is visible until reveal; a 2-2 tie skips; ejection marks dead; with
`anonymousVoting` true the `/state` response contains no `ballots` key at all.*

**Phase 5 — Death and win detection (20 min).** "I was killed" during play, win checks,
ghost view, end screen with role reveal.
*Accept: a death during `playing` produces no visible change on any other phone;
imposters win the moment living imposters equal living crewmates — verify at both 1v1
and 2v2; crew wins at 100% of a `tasks_total` computed from the actual roster.*

**Phase 6 — Optional, in this order.** Open (non-anonymous) voting ballots. Reset flow.
QR generation. `prefers-reduced-motion`. Nicer end screen.

### Timing, honestly

Phases 0-5 total roughly two and a half hours, not two. The task editor and the gathering
phase are the additions. If you are behind at the 90-minute mark, the cuts in order are:
`tasks_per_player` (ship "everyone does every task", exactly like the first session),
open voting, and the host force-meeting button — the timeout covers that case anyway.

Do not cut the gathering phase to save time. Half-built, it deadlocks the game.

---

## Pre-game checklist

- [ ] Task list authored in the host panel for **this house** — walk the rooms and write
      them in place, don't guess locations from memory
- [ ] Imposter count set for the number of people who actually showed up (adjust it
      between rounds if people leave or arrive)
- [ ] Anonymous vs open voting decided
- [ ] Both ambiguous rules in `GAMERULES.md` decided and set in host settings
- [ ] Deployed to Vercel, env vars set in the dashboard, opened on a phone over
      **cellular** to confirm it works if house WiFi is congested
- [ ] Lobby code + QR written large, taped somewhere reachable in the dark
- [ ] Host PIN written down
- [ ] Four-profile dry run of a full round including a meeting
- [ ] **Playing cards and the paper task sheet in the room as a fallback**
