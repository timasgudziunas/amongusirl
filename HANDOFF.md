# HANDOFF.md

Current state as of 2026-08-07 ~00:20 UTC (Phases 2-5 complete, pushed, Vercel deploying).

## Just completed — Phases 2-5, the whole game loop

- Server (`001b6e6`): `lib/game.ts` (occupancy resync, task-counter recompute with
  ghost_tasks/dead-player rules, win check, vote tally, idempotent voting->results
  advance) + routes `task/claim|complete|abandon`, `tick`, `meeting`, `bodies`, `here`,
  `force-meeting`, `dead`, `vote`, `reset`; `/state` extended for all phases; `/me` now
  returns `name` + `hasCalledMeeting`. All phase transitions are conditional UPDATEs
  (`WHERE phase=$expected AND phase_ends_at < now()`) — 12 simultaneous ticks produce
  one transition (verified with a concurrent tick storm).
- Client (`22ac021`): full RoomApp rewrite — playing screen (claims, occupancy n/cap,
  white 15s task screen, delayed task bar, emergency/report-body/I-was-killed),
  gathering red pulse (1Hz keyframe, `prefers-reduced-motion` -> solid red), meeting/
  voting/results/ended screens, ghost view, "You are {name}" identity line. HostLobby:
  force-meeting (gathering), two-step reset, loud `.au-error-banner` for settings/task/
  start errors.
- E2E: 73/73 checks green, run twice, against local dev + live Supabase at 4p/1imp and
  6p/2imp — capacity refusal at 2, claim expiry, delayed reveal (<=6s), death invisible
  during playing, bodies popup + double-report rejection, gathering unblock via /dead,
  tick-storm idempotency, tie->skip, open-voting ballots (and no `ballots` key when
  anonymous), all three win conditions. Test script: this session's scratchpad
  `test-phases2-5.mjs` (+ `cleanup-rooms.mjs`); test rooms deleted from live DB.

## The owner's reported bugs — root cause (settled, don't re-litigate)

- "Everyone got crewmate + same 3 tasks" (rooms NUE7/Q42Q): NOT a server bug. DB had
  correct roles (2 imposters) and distinct per-player samples. All tabs shared one
  localStorage token, so every tab rendered the last joiner's view. Signature: in both
  rooms the host ended up being the last joiner (claim-PIN flow on a shared token).
  On separate phones this cannot happen. Mitigation shipped: identity line everywhere.
- "Set 1 imposter but got 2": settings POST 403'd silently (tab had lost host identity).
  DB still had default `imposter_count=2`. Mitigation shipped: error banners. Host must
  re-set imposter count to 1 in the lobby before tonight's game.

## In progress / where it stopped

- Push `22ac021` done; Vercel production deploy for that exact sha reported
  **success** (GitHub deployment 5786345372, 00:11 UTC). **Public production URL:
  https://amongusirl-phi.vercel.app** (confirmed live at 00:21 UTC — room create,
  state, and tick all green; smoke room deleted). Note `amongusirl.vercel.app`
  (no `-phi`) is a DIFFERENT, unrelated project — never smoke-test against it.
- Old test rooms NUE7 / Q42Q / RL92 still exist in live DB in stale phases — harmless,
  but create a fresh room tonight.

## Next steps (priority order)

1. Verify deploy green, then a real 4-phone dry run (separate devices or browser
   profiles, never tabs) through a full round incl. a meeting — PLAN.md acceptance.
2. Pre-game checklist at the bottom of PLAN.md (author tasks for the house, set
   imposter count, QR/code on paper, cellular check).
3. Optional Phase 6 leftovers not built: QR code on host page, nicer end screen.
   (Open voting, reset, and reduced-motion ARE built.)

## Open decisions / blockers

- None. Reset intentionally clears `has_called_meeting` (reset = new game) while
  start-round preserves it across rounds of the same game (per GAMERULES).
- Meeting race loser gets their emergency button / body-report refunded (rollback in
  /api/meeting) — deliberate.

## Operational notes a fresh session would lack

- DB creds in `supabasedetails.md` (gitignored). Project ref `nxrgkcmnxetiyqnmrrqh`.
  Migrations push via pooler URL (see git history of this file or supabasedetails.md);
  no schema changes were needed this session.
- A stray `next dev` (PID 22644) may still hold port 3000 on the owner's machine.
- Deploys: push to `main` on GitHub -> Vercel production (no local vercel link).
