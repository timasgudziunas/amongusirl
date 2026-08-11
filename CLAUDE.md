# CLAUDE.md

Companion web app for an in-person Real-Life Among Us game. A group of friends, one dark
house, one evening. Read `GAMERULES.md` for game behavior and `PLAN.md` for scope and schema.

**Player count, imposter count, and task count are all variable.** Never hardcode 12
players, 2 imposters, or 8 tasks anywhere — not in role assignment, not in win checks,
not in copy strings, not in seed data. Player count is whoever is in the lobby; imposter
count is a room setting; **the task list is authored by the host per room** and lives in
the database, not in a config file. Anything that says "the two imposters", "10
crewmates", or "all 8 tasks" in UI text is a bug.

**This is being built in a two-hour window for a game tonight.** Prefer boring, working
code over elegant code. Do not refactor. Do not add abstractions for a second use case
that will never exist.

## Stack

- Next.js 16 (App Router), React 19, TypeScript strict
- Tailwind CSS v4 (CSS-first `@theme` in `globals.css`, no `tailwind.config.js`)
- Supabase (Postgres + Realtime)
- Deployed on Vercel
- Package manager: **npm**. Do not use Bun — it is unstable on this Windows machine.

## Security invariants — these are the whole point of the app

The Supabase anon key ships to the browser. Anyone at the party can open devtools.
Violating any of these makes the app pointless:

1. **Roles, votes, alive/dead status, and task-claim ownership are never readable by
   the browser.** They live in tables with RLS enabled and no anon policy, reachable
   only via server route handlers using `SUPABASE_SERVICE_ROLE_KEY`.
2. **`SUPABASE_SERVICE_ROLE_KEY` is never prefixed `NEXT_PUBLIC_`** and is never
   imported into any file under a `"use client"` boundary.
3. **Realtime is enabled only on `rooms`, `players`, `tasks`, and `task_occupancy`**
   (`task_occupancy` is public counts only). Never on `player_roles`, `player_secrets`,
   `votes`, `player_tasks`, or `task_claims` (secret: who actually holds a claim).
4. **The client never calls `supabase.from(...)` for anything except `rooms`,
   `players`, `tasks`, and `task_occupancy`.** Everything else goes through `/api/*`.
5. **Deaths are not published during the `playing` or `gathering` phases.** Alive/dead is
   only ever returned by `/api/state` when `phase` is `meeting`, `voting`, `results`, or
   `ended`. **The one deliberate exception is `GET /api/bodies`**, which a living player
   hits only when they actively choose "Report Body" — it returns names of the dead not
   yet reported, and nothing else. It is opt-in and narrow; it must not be folded into
   `/api/state` or fetched automatically.
6. **A player's assigned task list is secret.** Once tasks are randomly assigned, knowing
   someone's assignment tells you where they had legitimate reason to be — that is the
   core deduction of the game. `player_tasks` is server-only; `/api/me` returns your own
   list and nobody else's.
7. **Station occupancy is published as a count, never as names.** `task_occupancy.occupied`
   is an integer. Who is standing there lives in `task_claims`, server-side.
8. **When `anonymous_voting` is true, the `ballots` field is omitted at the server.**
   Never sent-and-hidden, never sent-and-conditionally-rendered. If it is in the JSON
   payload, the vote is not anonymous, regardless of what the UI draws.

If you are about to write a client-side query and you are unsure whether the data is
secret, it is secret. Route it through the server.

## Identity

There is **no auth**. No Supabase Auth, no magic links, no anonymous sign-in.

On join, the server issues a random `player_token` (uuid). The client stores it in
`localStorage` under `au:token` and `au:code`, and sends it as an `x-player-token`
header on every `/api/*` call. That token *is* the identity. This is a party game for
twelve friends, not a bank. Do not build more than this.

## Conventions

- All route handlers live under `app/api/**/route.ts` and run on the Node runtime.
- Validate every request body with zod. Return `{ ok: false, error: string }` with a
  4xx on failure; never throw raw.
- Every API response includes `serverTime: string` (ISO). Clients compute countdowns as
  `endsAt - (Date.now() + clockOffset)`, never from raw local time. Phones are not synced.
- All timestamps are `timestamptz`. All time math happens in Postgres or on the server.
- Phase transitions are driven by `POST /api/tick`, which every client calls every 2s.
  It must be **idempotent**: advance using a conditional `UPDATE ... WHERE phase = $expected
  AND ends_at < now()` so that twelve simultaneous ticks produce exactly one transition.
- Server-authoritative for everything. The client renders state; it never decides state.
- The task bar's 1-5s reveal delay (see `PLAN.md` "Delayed task bar") is a server-side
  timestamp comparison inside `/api/tick`, never a client `setTimeout`. A player's own
  task list updates instantly; the shared `tasks_done` number does not.

## UI constraints

The house is dark and everyone is holding a phone. Screen glow is an information leak.

- Default palette is near-black background with dim red text. Low contrast is correct here.
- During the `playing` phase, never show *who* is occupying a task station. As of
  2026-08-07 the owner tightened this further: occupancy is not rendered at all (no
  counts, no "full") — a station filling up is itself a location leak. The server still
  publishes counts and enforces capacity; a claim on a busy station just 409s. Never
  show per-player task counts. Aggregate bar only, drawn as a bar without numbers.
- The active-task screen is the one exception: pure white, full brightness, for the
  host-configured task duration (default 15 seconds), then back to black. It doubles as
  the in-game flashlight signal.
- Big tap targets. People are using this one-handed, in the dark, walking.
- No animations, no transitions, no toasts. Instant state changes. **The one deliberate
  animation in the app is the red pulse during `gathering`** — roughly 1Hz, full screen,
  and it must respect `prefers-reduced-motion` by falling back to a solid red field.

## Commands

```bash
npm run dev        # local dev
npm run build      # must pass before deploying
npm run lint
npx supabase db push   # apply migrations in supabase/migrations/
```

## Environment

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

## Out of scope — do not build these

Do not build them even if they seem easy, and do not leave TODOs for them:

- Imposter kill flow or kill-cooldown timers (a kill is a finger to the victim's midsection;
  imposters count their own 15-second cooldown; the victim self-reports via one button)
- Sabotage, vents, security cameras, admin table
- Player accounts, stats, or match history
- Sound, haptics, or push notifications
- Multiple concurrent rounds per room beyond a simple round counter
- Any test suite

## Verification before you say a phase is done

Run `npm run build` and open four browser profiles (not four tabs in one profile —
`localStorage` is shared per profile) against the same lobby code. Confirm the specific
acceptance criteria listed for that phase in `PLAN.md`.

Because counts are variable, test each phase at **two different lobby sizes with two
different imposter counts** — e.g. 4 players / 1 imposter and 6 players / 2 imposters.
Off-by-one bugs in win detection only appear when the numbers change.
