# HANDOFF.md — Session Handoff (updated 2026-08-12 ~00:35 UTC, supersedes all 2026-08-11 and earlier versions)

> For a fresh Claude session with no memory of prior conversations: read this file first,
> then the repo CLAUDE.md (rules + security invariants), then GAMERULES.md if touching
> game behavior. PLAN.md is the original build plan; the game is built and has been
> played successfully.

## Current state

- Game is **live and played**: first real game night (2026-08-10 or so) "worked
  perfectly" per the owner. Production: **https://amongusirl-phi.vercel.app**.
- Latest commit `69007c3` (sabotage) deployed to production, state READY, and
  E2E smoke-tested live 00:30 UTC 08-12: 21/21 checks green (room Y3UN) — trigger
  secrecy, early resolve on all-checked-in, timeout auto-kill, no bodies-list leak.
- DB migrations applied to live: `rooms.task_secs` (15), `rooms.door_secs` (5),
  `rooms.meeting_caller_name` (nullable), `rooms.sabotage_secs` (30).
- Supabase CLI is now **linked** on this machine (login + link done by owner in own
  terminal 2026-08-11; DB password in Windows keyring). `npx supabase db push` works
  non-interactively from this repo. `supabase/.temp/` is gitignored.

## Just completed (commit `69007c3`) — SABOTAGE

- New phase `"sabotage"`, new setting `sabotage_secs` (10-300s stepper, default 30).
- A living imposter's playing-phase "I was killed" button (same `/api/dead` call as
  crew — server branches on role, client NEVER does) secretly triggers it: claims
  canceled, check-ins reset, `expected_here` = living count, gathering-style red
  overlay on every phone with countdown + "x/y" + I AM HERE + I WAS KILLED.
- All living checked in (via `/api/here` or deaths via `/api/dead`) -> back to
  `playing`. Timer expiry (`/api/tick`, conditional claim) -> everyone living and
  not checked in is auto-killed with `reported=true` (rule deaths are NOT reportable
  bodies), then win check.
- No caller attribution anywhere (deliberate — unlike meetings). `/api/state`
  sabotage payload is counts + deadline only.
- Known accepted quirk: no cooldown/limit — an imposter can retrigger sabotage
  immediately after one resolves. Social-contract territory; flag to owner if abused.

## Earlier this session (commit `f3b0337`)

- **Waiting players see the lobby size**: "Players (N)" heading on the player waiting
  screen; "N players joined" under the room code on the host screen.
- **Host settings panel reorganized into grouped cards** (Roles / Tasks / Meetings and
  voting / Screens) with big +/- steppers (`Stepper` component local to HostLobby):
  imposters, tasks per player, **task duration** (5-120s, was hardcoded 15), **players
  per station** (task_capacity, existed server-side but had no UI), show-task-bar,
  imposter-tasks-count, ghost tasks, gathering/discussion/voting/results timers
  (existed server-side, no UI before), anonymous voting, **door screen duration**
  (2-30s, was a client constant; now served in the playing-state payload).
- Task duration wiring: `/api/task/claim` returns `secondsRequired: room.task_secs`,
  claim TTL = task_secs + 10s grace, `/api/task/complete` min hold = task_secs - 1.
- **Meeting attribution**: `rooms.meeting_caller_name` set by `/api/meeting`, cleared
  on results->playing and every lobby reset. Gathering + meeting screens now show
  "{caller} called an emergency meeting" / "{caller} found {victim}'s body".
- GAMERULES.md and CLAUDE.md updated where they stated fixed 15s/5s durations.
- Implementation delegated to Sonnet subagents, QA'd + built + deployed by orchestrator.

## In progress / where it stopped

- Nothing in flight. Build green, lint clean, deploy READY, sabotage E2E green.
- Not yet exercised in a browser: the reorganized host settings UI and the sabotage
  overlay have only been verified by build + live API, not a multi-profile visual pass.

## Next steps (priority order)

1. Owner opens host screen + a player profile on the live site and eyeballs the new
   grouped settings and (with a test round) the sabotage overlay.
2. Next game night: agree on the sabotage room as a group before starting (GAMERULES
   has the new Sabotage section).
3. Still-unbuilt niceties from Phase 6: QR code on host page, nicer end screen.
4. Declined for now (offer stands): per-player emergency-meeting count setting;
   sabotage cooldown/limit if retrigger spam becomes a problem.

## Open decisions / blockers

- None. Settings only change in the lobby (server-enforced) — mid-round edits are
  impossible by design, so task-duration changes can't desync a running round.
- Reset clears `has_called_meeting` (reset = new game); start-round preserves it
  across rounds of the same game — settled per GAMERULES, don't re-litigate.
- 2026-08-07 "everyone got crewmate/same tasks" and "settings silently 403" reports:
  settled root causes (shared localStorage across tabs; lost host identity). Not
  server bugs; mitigations shipped (identity line, error banners). Don't re-open.

## Where everything lives

| path | what it is |
|---|---|
| `app/host/[code]/HostLobby.tsx` | host screen incl. grouped settings + `Stepper` |
| `app/room/[code]/RoomApp.tsx` | player app, all phases |
| `lib/game.ts` | shared game logic (win check, tally, resets, `LOBBY_RESET_FIELDS`) |
| `lib/validation.ts` | start-round validation, shared by /state and /start-round |
| `app/api/settings/route.ts` | host settings endpoint (all zod-bounded) |
| `supabase/migrations/` | schema; latest two are task/door secs + meeting caller |
| `supabasedetails.md` (gitignored) | DB creds, project ref `nxrgkcmnxetiyqnmrrqh` |

## Operational landmines (numbered, never drop)

1. `amongusirl.vercel.app` (no `-phi`) is a DIFFERENT unrelated project — never
   smoke-test against it. Production is `amongusirl-phi.vercel.app`.
2. Browser tabs share localStorage — always test with separate profiles/devices,
   never tabs (root cause of the 08-07 game-night confusion).
3. `npm run build` fails inside the sandboxed shell (Google Fonts fetch blocked) —
   run it with network access.
4. Supabase CLI login cannot run in the in-session shell (non-TTY) — owner runs
   `npx supabase login` / `link` in a real terminal; after that `db push` works here.
5. Stale junk rooms in live DB (NUE7, Q42Q, RL92 from 08-07 testing; 7HEP and Y3UN
   from 08-11/12 smoke tests) — harmless, no delete endpoint exists; ignore them.
6. The API now selects `task_secs`/`door_secs`/`meeting_caller_name`/`sabotage_secs`
   — code deployed without those migrations hard-breaks the API. Always `db push`
   before `git push`.
7. Role secrecy in the sabotage flow lives entirely in `/api/dead`'s server-side
   branch. Never add client-side role branching to that button, and never add a
   separate sabotage endpoint — the identical request IS the secrecy.

## Quick health check

```bash
curl -s -X POST https://amongusirl-phi.vercel.app/api/room \
  -H "Content-Type: application/json" -d '{"hostName":"Health","pin":"0000"}'
# then with the returned code+token:
curl -s "https://amongusirl-phi.vercel.app/api/state?code=CODE" -H "x-player-token: TOKEN"
```
Healthy ≈ first call returns `{"ok":true,"code":...}`, second returns lobby state whose
`settings` object includes `taskSecs` and `doorSecs`.
