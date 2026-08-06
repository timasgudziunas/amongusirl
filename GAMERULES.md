# GAMERULES.md

The physical, in-house rules for Real-Life Among Us. This file is the source of truth
for **what the app must model**. If PLAN.md and this file disagree about game behavior,
this file wins and PLAN.md should be corrected.

---

## Setup

- **Player count is variable.** However many people show up, join the lobby. The first
  session was 12 players with 2 imposters, but nothing in the game or the app assumes
  that number.
- **The host sets the imposter count** in the room settings before starting a round.
  Everyone else is a crewmate. Sensible ranges: 1 imposter for roughly 5-8 players,
  2 for 9-14, 3 for 15+. The host can override this freely; the app only enforces the
  two hard limits below.
- **Hard limits, enforced by the app at round start:**
  - At least 1 imposter.
  - `imposters × 2 < total players`. If imposters are half or more of the lobby, the
    imposter win condition is already met the instant the round begins.
- Played in a house with **all lights off** except a candle or two.
- Roles are assigned by the app. (Previously: drawing playing cards, plus an
  "everyone close your eyes / imposters open your eyes / 1-2-3-4-5 / imposters close
  your eyes" ritual so imposters could identify each other. The app replaces both —
  each imposter simply sees the names of their fellow imposters on their own screen.
  With 1 imposter there are no partners to show and the ritual is pointless anyway.)

## Movement and conduct

- **Walking only.** No running, no speed-walking.
- **No talking** while a round is live.
- **No exaggerated movements.**
- To open a door, you must **stand with your hand on it for 5 full seconds** first.
  Doors can be closed instantly.

## Tasks

- **The host writes the task list for each house**, in the lobby, before the round.
  There is no fixed set and no fixed number. Each task has:
  - a **name**
  - a **location** in the house
  - an optional **short description**, only where the task isn't self-explanatory
- Each task takes **15 seconds**.
- **Up to 2 people may occupy a task station at the same time.** (Changed from the first
  session, which allowed only 1. Two is a deliberate simplification — with one, a large
  group spends the round queuing, and station locking becomes the main source of
  frustration.)
- **While doing a task you may not look around.** Head down, eyes on the task.
- Imposters can do tasks exactly like crewmates, and must appear to.
- Previously tracked on a paper sheet you walked to and checked your name off.
  The app replaces the sheet.
- **The shared task bar does not update the instant a task is finished.** After a
  completion, the app waits a random **1 to 5 seconds** before the bar moves. You know
  your own task is done right away — it's only the number everyone else sees that lags.
  This is intentional: it keeps the bar from being a precise timestamp of who just
  finished what, giving imposters a little more cover.

### Task assignment

- **Current rule: every player must complete every task on the list.**
- **Desired rule, if there is time to build it:** each player is randomly assigned a
  subset of the task list — say 5 of 9 — rather than all of them. This is closer to the
  real game and stops everyone from converging on the same station in the same order.
  Imposters receive a subset too, so their screen is indistinguishable from a crewmate's.

## Lighting signal

- Phone flashlight **on** = "I am currently doing a task." Off the instant you finish.
- The app replaces the manual flashlight: the task screen goes **full white at maximum
  brightness** for the 15 seconds, then snaps back to black. Same signal, automatic.

## Killing

- A kill is performed by **extending a finger into the middle section of the victim's
  body** — front, back, or side. Nothing else counts as a kill.
- Imposters have a **15-second kill cooldown**, which they count themselves. The app
  does not mediate the kill and does not run the cooldown timer.
- **The victim taps "I was killed" on their own phone.** This is the app's only input
  for deaths. The app must never broadcast this to living players in real time.
- **No kills once a meeting has been called.** From the moment a meeting is called until
  the round resumes, the round is frozen — everyone is walking to the table with their
  screen flashing, and a kill during that walk is unfalsifiable.

## Bodies and meetings

- **You cannot report from where the body is.** You must walk to the emergency meeting
  table at the center of the map and report from there.
- At the table, you choose exactly one of the two:
  - **Call an emergency meeting.** Needs no body, no reason beyond suspicion. **Once per
    player per game.** Once used, it is gone for the rest of the game.
  - **Report a body.** You must **select which dead player you are reporting** from a
    list — the app shows a picker for this the moment you choose the option. **Unlimited
    uses**, by anyone, for as long as there are unreported bodies. Reporting a body never
    consumes your emergency meeting, and using your emergency meeting never consumes a
    body report.
- These are two different buttons leading to two different flows, not one button with a
  reason attached after the fact.

### When a meeting is called

1. **Every player's screen starts flashing red.** This is the signal, replacing someone
   shouting across a dark house.
2. **Any task in progress is immediately cancelled and reset.** No credit, station freed.
   You have to redo it after the meeting.
3. The screen displays instructions to **stay quiet and walk to the meeting spot** —
   the discussion has not started yet and talking on the way is not allowed.
4. On arrival, each player taps **"I am here."** Their screen stops flashing.
5. **The meeting begins automatically once every living player has checked in.** Nobody
   has to call it to order.
6. Dead players do not need to check in. If someone was killed and hasn't reported it
   yet, the host can force the meeting to start, and it starts on its own after a
   timeout regardless.
7. A body, once reported, is reported — it doesn't need reporting again. The picker in
   step "report a body" only ever lists dead players who haven't already been reported
   this round. A new round clears all deaths and reports; **it does not clear anyone's
   one-time emergency meeting** — that is spent for the whole game, not per round.

### The meeting itself

- Meetings last **exactly 90 seconds, not a second longer.**
- **Every player's screen shows three things for the whole 90 seconds:** who is alive,
  who is dead, and a live countdown of time remaining in the meeting. This is the one
  phase where alive/dead status is shown at all — it's withheld during `playing` and
  `gathering` specifically so this reveal only happens here, together, at the table.
  The countdown is synced from the server, not counted locally on each phone, so all
  screens agree.

## Voting

- After the 90-second discussion, everyone votes.
- Previously: slide your drawn card face-down toward the accused, with a "skip" pile in
  the center of the table. This system was slow, leaky, and biased by who moved first.
- The app replaces it: **simultaneous and auto-tallied.** Nobody sees any vote until all
  votes are in or the vote timer expires — this is true in both modes below.
- **The host chooses anonymous or open voting** in the room settings:
  - **Anonymous (default):** the result shows the tally and who was ejected, never who
    voted for whom.
  - **Open:** the result additionally shows each player's vote. More social pressure,
    more accountability, more grudges.
- **Ties are a skip.** Nobody is ejected.
- Dead players do not vote.

## Win conditions

- **Crewmates win** when the task bar reaches 100%, or when all imposters are ejected.
- **Imposters win** when the number of living imposters is greater than or equal to the
  number of living crewmates.

## Two rules that were ambiguous and need a decision before play

These are exposed as room settings. Defaults are listed; change them in the host panel
before starting the first round.

1. **Do imposter task completions count toward the task bar?**
   Default: **no.** The bar counts crewmate completions only. Imposters still get the
   identical 15-second white screen, so nobody can tell from watching a phone whether a
   completion was real. If imposter tasks counted, imposters would simply never do tasks
   and would be obvious.

2. **Do dead crewmates keep doing tasks (ghost tasks)?**
   Default: **no.** When a crewmate dies, their remaining incomplete tasks are removed
   from the denominator, so the bar does not stall. Set `ghost_tasks = true` if you want
   ghosts wandering the house completing tasks instead.
