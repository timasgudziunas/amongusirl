"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getCode, getToken } from "@/lib/client";
import { supabaseBrowser } from "@/lib/supabase/browser";

// ---- Types mirror app/api/state and app/api/me response shapes exactly. ----

type RosterEntry = { playerId: string; name: string };
type LobbyState = { phase: "lobby"; roster: RosterEntry[] };

type OccupancyEntry = { taskId: string; occupied: number };
type PlayingState = {
  phase: "playing";
  round: number;
  roster: RosterEntry[];
  occupancy: OccupancyEntry[];
  taskCapacity: number;
  hasCalledMeeting: boolean;
  tasksDone?: number;
  tasksTotal?: number;
};

type GatheringState = {
  phase: "gathering";
  hereCount: number;
  expectedHere: number;
  phaseEndsAt: string | null;
  meetingReason: string | null;
  reportedBodyName: string | null;
};

type MeetingRosterEntry = { playerId: string; name: string; isAlive: boolean };
type MeetingState = {
  phase: "meeting";
  roster: MeetingRosterEntry[];
  phaseEndsAt: string | null;
  meetingReason: string | null;
  reportedBodyName: string | null;
};

type VotingState = {
  phase: "voting";
  roster: RosterEntry[];
  votesCast: number;
  livingCount: number;
  phaseEndsAt: string | null;
  myVoteCast: boolean;
};

type TallyEntry = { name: string; count: number };
type Ballot = { voterName: string; targetName: string };
type LastResult = {
  ejectedName: string | null;
  wasImposter: boolean | null;
  skipped: boolean;
  tied: boolean;
  tally: TallyEntry[];
  ballots?: Ballot[];
};
type ResultsState = {
  phase: "results";
  lastResult: LastResult | null;
  phaseEndsAt: string | null;
  winnerPending: string | null;
};

type EndedRosterEntry = { playerId: string; name: string; role: "crew" | "imposter" | null; isAlive: boolean };
type EndedState = { phase: "ended"; winner: "crew" | "imposters" | null; roster: EndedRosterEntry[] };

type StateResponse =
  | LobbyState
  | PlayingState
  | GatheringState
  | MeetingState
  | VotingState
  | ResultsState
  | EndedState;

type MyTask = { taskId: string; name: string; location: string; description: string | null; done: boolean };
type MeResponse = {
  name: string;
  role: "crew" | "imposter" | null;
  partnerNames?: string[];
  isAlive: boolean;
  isHere: boolean;
  hasCalledMeeting: boolean;
  myTasks: MyTask[];
};

type BodyEntry = { playerId: string; name: string };

type ActiveClaim = { taskId: string; startedAt: number; totalSecs: number };

function formatCountdown(totalSecs: number): string {
  const secs = Math.max(0, totalSecs);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function RoomApp({ code }: { code: string }) {
  const router = useRouter();
  const [state, setState] = useState<StateResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  // A ticking clock read from state (never Date.now() directly in render/handlers —
  // that's an impure call outside the one effect below that's allowed to make it).
  const [nowMs, setNowMs] = useState(0);

  // Active (claimed, in-progress) task — drives the full-white 15s screen.
  const [activeClaim, setActiveClaim] = useState<ActiveClaim | null>(null);
  const completingRef = useRef(false);

  // Door screen: purely client-side, reuses the same white-screen render path
  // as an active task claim. startedAt is read from the shared nowMs clock.
  const [doorStartedAt, setDoorStartedAt] = useState<number | null>(null);
  const DOOR_SECS = 5;

  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [deadError, setDeadError] = useState<string | null>(null);
  const [hereError, setHereError] = useState<string | null>(null);
  const [killConfirm, setKillConfirm] = useState(false);
  const [emergencyConfirm, setEmergencyConfirm] = useState(false);
  const [roleRevealed, setRoleRevealed] = useState(false);

  const [bodiesOpen, setBodiesOpen] = useState(false);
  const [bodiesLoading, setBodiesLoading] = useState(false);
  const [bodiesList, setBodiesList] = useState<BodyEntry[] | null>(null);
  const [bodiesError, setBodiesError] = useState<string | null>(null);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>(null);

  const [voteBusy, setVoteBusy] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [votedLocally, setVotedLocally] = useState(false);

  const bounceToHome = useCallback(() => {
    router.push("/");
  }, [router]);

  const fetchState = useCallback(async () => {
    const res = await api<StateResponse>(`/api/state?code=${code}`);
    if (!res.ok) {
      const lower = res.error.toLowerCase();
      if (lower.includes("token") || lower.includes("member")) {
        bounceToHome();
        return;
      }
      setError(res.error);
      return;
    }
    setError(null);
    setClockOffset(new Date(res.serverTime).getTime() - Date.now());
    setState(res);
  }, [code, bounceToHome]);

  const fetchMe = useCallback(async () => {
    const res = await api<MeResponse>("/api/me");
    if (!res.ok) {
      const lower = res.error.toLowerCase();
      if (lower.includes("token")) {
        bounceToHome();
        return;
      }
      return;
    }
    setMe(res);
  }, [bounceToHome]);

  const tick = useCallback(async () => {
    await api("/api/tick", { method: "POST" });
  }, []);

  useEffect(() => {
    const token = getToken();
    const storedCode = getCode();
    if (!token || !storedCode || storedCode.toUpperCase() !== code) {
      bounceToHome();
      return;
    }
    // Deferred so the fetch's eventual setState isn't called synchronously
    // from within the effect body.
    const timeout = setTimeout(fetchState, 0);
    return () => clearTimeout(timeout);
  }, [code, bounceToHome, fetchState]);

  // Tick + state, every 2s, from the same interval. Tick drives server phase
  // transitions; state polling picks up the result (Realtime is an accelerant below).
  useEffect(() => {
    const interval = setInterval(() => {
      tick();
      fetchState();
    }, 2000);
    return () => clearInterval(interval);
  }, [tick, fetchState]);

  // Realtime accelerant: refetch immediately on any room update.
  useEffect(() => {
    const client = supabaseBrowser();
    const channel = client
      .channel(`room-${code}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rooms", filter: `code=eq.${code}` },
        () => fetchState()
      )
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [code, fetchState]);

  // /me is cheap and drives role/isAlive/task state — poll it in every phase but lobby.
  useEffect(() => {
    const phase = state?.phase;
    if (!phase || phase === "lobby") return;
    const timeout = setTimeout(fetchMe, 0);
    const interval = setInterval(fetchMe, 2000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [state?.phase, fetchMe]);

  // The one place Date.now() is read: a 1s clock, fed into state so every other
  // read (render or handler) is a pure state read instead of an impure call.
  useEffect(() => {
    const initial = setTimeout(() => setNowMs(Date.now()), 0);
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);

  // A meeting being called cancels claims server-side. If we're on the white task
  // or door screen when the phase leaves "playing", drop back immediately.
  useEffect(() => {
    if (!state || state.phase === "playing") return;
    if (!activeClaim && doorStartedAt === null) return;
    const timeout = setTimeout(() => {
      setActiveClaim(null);
      setDoorStartedAt(null);
    }, 0);
    return () => clearTimeout(timeout);
  }, [state, activeClaim, doorStartedAt]);

  // The door screen is a plain client-side countdown off the shared 1s clock —
  // no API calls, no claim. At 0, drop back to the playing screen.
  useEffect(() => {
    if (doorStartedAt === null) return;
    if (nowMs - doorStartedAt < DOOR_SECS * 1000) return;
    const timeout = setTimeout(() => setDoorStartedAt(null), 0);
    return () => clearTimeout(timeout);
  }, [doorStartedAt, nowMs]);

  // Reset transient per-phase UI state whenever the phase changes.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setKillConfirm(false);
      setEmergencyConfirm(false);
      setRoleRevealed(false);
      setDoorStartedAt(null);
      setMeetingError(null);
      setDeadError(null);
      setHereError(null);
      setClaimError(null);
      setBodiesOpen(false);
      setBodiesList(null);
      setBodiesError(null);
      setSelectedBodyId(null);
      setVoteError(null);
      if (state?.phase !== "voting") setVotedLocally(false);
    }, 0);
    return () => clearTimeout(timeout);
  }, [state?.phase]);

  // Lock voting choices on reload too, from the server's own record of my vote.
  useEffect(() => {
    if (state?.phase !== "voting") return;
    const timeout = setTimeout(() => setVotedLocally(state.myVoteCast), 0);
    return () => clearTimeout(timeout);
  }, [state]);

  // Fire /task/complete once the required hold time has elapsed. Re-checked every
  // time the 1s clock above ticks.
  useEffect(() => {
    if (!activeClaim) {
      completingRef.current = false;
      return;
    }
    const elapsedMs = nowMs + clockOffset - activeClaim.startedAt;
    if (elapsedMs >= activeClaim.totalSecs * 1000 && !completingRef.current) {
      completingRef.current = true;
      (async () => {
        const res = await api("/api/task/complete", { body: { taskId: activeClaim.taskId } });
        if (!res.ok) setClaimError(res.error);
        setActiveClaim(null);
        fetchMe();
        fetchState();
      })();
    }
  }, [activeClaim, nowMs, clockOffset, fetchMe, fetchState]);

  async function claimTask(taskId: string) {
    setEmergencyConfirm(false);
    setClaimError(null);
    setBusyTaskId(taskId);
    const res = await api<{ secondsRequired: number }>("/api/task/claim", { body: { taskId } });
    setBusyTaskId(null);
    if (!res.ok) {
      setClaimError(res.error);
      return;
    }
    setActiveClaim({ taskId, startedAt: nowMs + clockOffset, totalSecs: res.secondsRequired });
  }

  async function cancelActiveTask() {
    if (!activeClaim) return;
    const taskId = activeClaim.taskId;
    setActiveClaim(null);
    await api("/api/task/abandon", { body: { taskId } });
    fetchMe();
  }

  async function callEmergencyMeeting() {
    if (!emergencyConfirm) {
      setEmergencyConfirm(true);
      return;
    }
    setEmergencyConfirm(false);
    setMeetingError(null);
    const res = await api("/api/meeting", { body: { reason: "emergency" } });
    if (!res.ok) {
      setMeetingError(res.error);
      return;
    }
    fetchState();
    fetchMe();
  }

  function openDoor() {
    setEmergencyConfirm(false);
    setDoorStartedAt(nowMs);
  }

  async function openReportBody() {
    setEmergencyConfirm(false);
    setBodiesError(null);
    setSelectedBodyId(null);
    setBodiesOpen(true);
    setBodiesLoading(true);
    const res = await api<{ bodies: BodyEntry[] }>("/api/bodies");
    setBodiesLoading(false);
    if (!res.ok) {
      setBodiesError(res.error);
      setBodiesList([]);
      return;
    }
    setBodiesList(res.bodies);
  }

  function closeReportBody() {
    setBodiesOpen(false);
    setBodiesList(null);
    setBodiesError(null);
    setSelectedBodyId(null);
  }

  async function submitReportBody() {
    if (!selectedBodyId) return;
    setBodiesError(null);
    const res = await api("/api/meeting", { body: { reason: "report", bodyPlayerId: selectedBodyId } });
    if (!res.ok) {
      setBodiesError(res.error);
      return;
    }
    closeReportBody();
    fetchState();
    fetchMe();
  }

  async function handleIWasKilled() {
    setEmergencyConfirm(false);
    if (!killConfirm) {
      setKillConfirm(true);
      return;
    }
    setKillConfirm(false);
    setDeadError(null);
    const res = await api("/api/dead", { method: "POST" });
    if (!res.ok) setDeadError(res.error);
    fetchMe();
    fetchState();
  }

  async function markHere() {
    setHereError(null);
    const res = await api("/api/here", { method: "POST" });
    if (!res.ok) setHereError(res.error);
    fetchMe();
    fetchState();
  }

  async function castVote(targetId: string | null) {
    setVoteError(null);
    setVoteBusy(true);
    const res = await api("/api/vote", { body: { targetId } });
    setVoteBusy(false);
    if (!res.ok) {
      setVoteError(res.error);
      return;
    }
    setVotedLocally(true);
    fetchState();
  }

  if (error) {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p className="au-error">{error}</p>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p className="au-dim">Loading...</p>
      </main>
    );
  }

  // The active-task white screen pre-empts every phase-specific render below it,
  // but only while the phase is still "playing" — the effect above drops it the
  // instant the phase leaves "playing" (a meeting was called).
  if (activeClaim && state.phase === "playing") {
    const elapsedMs = Math.max(0, nowMs + clockOffset - activeClaim.startedAt);
    const remaining = Math.max(0, Math.ceil((activeClaim.totalSecs * 1000 - elapsedMs) / 1000));
    const task = (me?.myTasks ?? []).find((t) => t.taskId === activeClaim.taskId);
    return (
      <div className="au-task-white fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6 text-center">
        <p className="text-8xl font-bold tabular-nums">{remaining}</p>
        {task && (
          <div>
            <p className="text-lg">{task.name}</p>
            <p className="text-sm text-gray-600">{task.location}</p>
          </div>
        )}
        <button
          type="button"
          className="border border-gray-300 px-4 py-2 text-sm text-gray-500"
          onClick={cancelActiveTask}
        >
          Cancel
        </button>
      </div>
    );
  }

  // The door screen: same white-screen render path as an active task, so a door
  // and a task are indistinguishable at a glance. Purely client-side countdown.
  if (doorStartedAt !== null && state.phase === "playing") {
    const elapsedMs = Math.max(0, nowMs - doorStartedAt);
    const remaining = Math.max(0, Math.ceil((DOOR_SECS * 1000 - elapsedMs) / 1000));
    return (
      <div className="au-task-white fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6 text-center">
        <p className="text-8xl font-bold tabular-nums">{remaining}</p>
        <div>
          <p className="text-lg">Door</p>
        </div>
        <button
          type="button"
          className="border border-gray-300 px-4 py-2 text-sm text-gray-500"
          onClick={() => setDoorStartedAt(null)}
        >
          Cancel
        </button>
      </div>
    );
  }

  // Visible on every phase except gathering and the white task screen above —
  // shared-localStorage tabs silently impersonate one player without this.
  const identity = me ? <p className="au-dim text-center text-sm">You are {me.name}</p> : null;
  const deadBanner =
    me && me.isAlive === false ? <p className="au-error text-center">YOU ARE DEAD</p> : null;

  if (state.phase === "lobby") {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-6 py-16">
        <p className="text-center text-xl">Waiting for host...</p>
        {identity}
        <ul className="au-card flex flex-col gap-1">
          {state.roster.map((p) => (
            <li key={p.playerId}>{p.name}</li>
          ))}
          {state.roster.length === 0 && <li className="au-dim">Nobody here yet</li>}
        </ul>
      </main>
    );
  }

  if (state.phase === "playing") {
    const dead = me?.isAlive === false;
    const occupancyMap = new Map(state.occupancy.map((o) => [o.taskId, o.occupied]));
    const capacity = state.taskCapacity;

    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-6 py-10">
        {identity}
        {deadBanner}

        <section>
          <button
            type="button"
            className="au-card w-full text-center"
            onClick={() => setRoleRevealed((r) => !r)}
          >
            {!roleRevealed && <h1 className="text-2xl tracking-wide">ROLE &mdash; tap to reveal</h1>}
            {roleRevealed && (!me || me.role === null) && (
              <h1 className="au-dim text-2xl tracking-wide">dealing roles...</h1>
            )}
            {roleRevealed && me && me.role === "imposter" && (
              <>
                <h1 className="text-3xl tracking-wide">IMPOSTER</h1>
                {me.partnerNames && me.partnerNames.length > 0 && (
                  <p className="au-dim mt-1">With: {me.partnerNames.join(", ")}</p>
                )}
                <p className="au-dim mt-2 text-sm">tap to hide</p>
              </>
            )}
            {roleRevealed && me && me.role === "crew" && (
              <>
                <h1 className="text-3xl tracking-wide">CREWMATE</h1>
                <p className="au-dim mt-2 text-sm">tap to hide</p>
              </>
            )}
          </button>
        </section>

        {!dead && (
          <button type="button" className="au-button" onClick={openDoor}>
            Door
          </button>
        )}

        {state.tasksTotal !== undefined && (
          <p className="au-dim text-center">
            Tasks: {state.tasksDone}/{state.tasksTotal}
          </p>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="au-dim text-sm uppercase tracking-wider">Your tasks</h2>
          <div className="flex flex-col gap-2">
            {(me?.myTasks ?? []).map((task) => {
              const occupied = occupancyMap.get(task.taskId) ?? 0;
              const full = occupied >= capacity;
              return (
                <div
                  key={task.taskId}
                  className={`au-card flex items-center justify-between gap-3 ${dead ? "opacity-50" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-lg">{task.name}</p>
                    <p className="au-dim text-sm">{task.location}</p>
                    {task.description && <p className="au-dim text-sm">{task.description}</p>}
                    {!task.done && (
                      <p className="au-dim text-sm">
                        {occupied}/{capacity}
                        {full ? " · full" : ""}
                      </p>
                    )}
                  </div>
                  {task.done ? (
                    <span className="text-2xl" aria-label="done">
                      &#10003;
                    </span>
                  ) : dead ? (
                    <span className="au-dim text-sm">&mdash;</span>
                  ) : (
                    <button
                      type="button"
                      className="au-button-small"
                      disabled={busyTaskId !== null || full || activeClaim !== null || doorStartedAt !== null}
                      onClick={() => claimTask(task.taskId)}
                    >
                      {busyTaskId === task.taskId ? "..." : "Claim"}
                    </button>
                  )}
                </div>
              );
            })}
            {me && me.myTasks.length === 0 && <p className="au-dim">No tasks assigned.</p>}
            {!me && <p className="au-dim">Loading tasks...</p>}
          </div>
          {claimError && <p className="au-error">{claimError}</p>}
        </section>

        {!dead && (
          <section className="flex flex-col gap-3">
            <button
              type="button"
              className="au-button"
              disabled={!!me?.hasCalledMeeting}
              onClick={callEmergencyMeeting}
            >
              {me?.hasCalledMeeting
                ? "Emergency used"
                : emergencyConfirm
                  ? "Tap again to confirm"
                  : "Emergency Meeting"}
            </button>
            {meetingError && <p className="au-error">{meetingError}</p>}

            <button type="button" className="au-button" onClick={openReportBody}>
              Report Body
            </button>
            {bodiesOpen && (
              <div className="au-card flex flex-col gap-2">
                {bodiesLoading && <p className="au-dim">Loading...</p>}
                {!bodiesLoading && bodiesList && bodiesList.length === 0 && (
                  <p className="au-dim">Nobody found.</p>
                )}
                {!bodiesLoading && bodiesList && bodiesList.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {bodiesList.map((b) => (
                      <button
                        key={b.playerId}
                        type="button"
                        className="au-button-small"
                        onClick={() => setSelectedBodyId(b.playerId)}
                      >
                        {selectedBodyId === b.playerId ? "> " : ""}
                        {b.name}
                      </button>
                    ))}
                  </div>
                )}
                {bodiesError && <p className="au-error">{bodiesError}</p>}
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="au-button-small"
                    disabled={!selectedBodyId}
                    onClick={submitReportBody}
                  >
                    Submit
                  </button>
                  <button type="button" className="au-button-small" onClick={closeReportBody}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <button type="button" className="au-button" onClick={handleIWasKilled}>
              {killConfirm ? "Tap again to confirm" : "I was killed"}
            </button>
            {deadError && <p className="au-error">{deadError}</p>}
          </section>
        )}
      </main>
    );
  }

  if (state.phase === "gathering") {
    const dead = me?.isAlive === false;
    const checkedIn = !!me?.isHere;
    const pulsing = !dead && !checkedIn;

    if (pulsing) {
      return (
        <div className="au-pulse fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6 text-center">
          <h1 className="text-4xl font-bold">STAY QUIET</h1>
          <h1 className="text-4xl font-bold">WALK TO THE TABLE</h1>
          <p className="text-xl">
            {state.hereCount}/{state.expectedHere}
          </p>
          {state.reportedBodyName && <p>{state.reportedBodyName}&apos;s body was found</p>}
          <div className="flex w-full max-w-xs flex-col gap-3">
            <button type="button" className="au-button" onClick={markHere}>
              I AM HERE
            </button>
            <button type="button" className="au-button" onClick={handleIWasKilled}>
              {killConfirm ? "Tap again to confirm" : "I WAS KILLED"}
            </button>
          </div>
          {hereError && <p className="au-error">{hereError}</p>}
          {deadError && <p className="au-error">{deadError}</p>}
        </div>
      );
    }

    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <p className="text-xl">
          {dead ? "Waiting" : `Waiting for others (${state.hereCount}/${state.expectedHere})`}
        </p>
        {state.reportedBodyName && <p className="au-dim">{state.reportedBodyName}&apos;s body was found</p>}
      </main>
    );
  }

  if (state.phase === "meeting") {
    const endsAtMs = state.phaseEndsAt ? new Date(state.phaseEndsAt).getTime() : null;
    const remaining =
      endsAtMs === null ? 0 : Math.max(0, Math.round((endsAtMs - (nowMs + clockOffset)) / 1000));
    // Alive players to the top, dead to the bottom; stable within each group.
    const sortedRoster = [...state.roster].sort((a, b) => Number(b.isAlive) - Number(a.isAlive));
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-6 py-10">
        {identity}
        {deadBanner}
        <p className="text-center text-3xl tabular-nums">{formatCountdown(remaining)}</p>
        <p className="text-center">
          {state.meetingReason === "report"
            ? `${state.reportedBodyName ?? "A player"}'s body was reported`
            : "Emergency meeting"}
        </p>
        <ul className="au-card flex flex-col gap-1">
          {sortedRoster.map((p) => (
            <li key={p.playerId} className={p.isAlive ? "" : "au-dim line-through opacity-40"}>
              {p.name} &mdash; {p.isAlive ? "ALIVE" : "DEAD"}
            </li>
          ))}
        </ul>
      </main>
    );
  }

  if (state.phase === "voting") {
    const endsAtMs = state.phaseEndsAt ? new Date(state.phaseEndsAt).getTime() : null;
    const remaining =
      endsAtMs === null ? 0 : Math.max(0, Math.round((endsAtMs - (nowMs + clockOffset)) / 1000));
    const dead = me?.isAlive === false;

    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-6 py-10">
        {identity}
        {deadBanner}
        <p className="text-center text-3xl tabular-nums">{formatCountdown(remaining)}</p>
        {dead ? (
          <p className="au-dim text-center">
            You are dead. Waiting for others ({state.votesCast}/{state.livingCount})
          </p>
        ) : votedLocally ? (
          <p className="text-center">
            Waiting for others ({state.votesCast}/{state.livingCount})
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {state.roster.map((p) => (
              <button
                key={p.playerId}
                type="button"
                className="au-button"
                disabled={voteBusy}
                onClick={() => castVote(p.playerId)}
              >
                {p.name}
              </button>
            ))}
            <button type="button" className="au-button" disabled={voteBusy} onClick={() => castVote(null)}>
              SKIP
            </button>
            {voteError && <p className="au-error">{voteError}</p>}
          </div>
        )}
      </main>
    );
  }

  if (state.phase === "results") {
    const result = state.lastResult;
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-6 py-16">
        {identity}
        {deadBanner}
        {!result && <p className="au-dim text-center">Tallying votes...</p>}
        {result && (
          <>
            <section className="text-center">
              {result.ejectedName ? (
                <>
                  <h1 className="text-2xl">{result.ejectedName} was ejected</h1>
                  <p className="au-dim mt-1">{result.wasImposter ? "was an Imposter" : "was NOT an Imposter"}</p>
                </>
              ) : result.tied ? (
                <h1 className="text-2xl">Nobody was ejected (tie)</h1>
              ) : (
                <h1 className="text-2xl">Vote skipped</h1>
              )}
            </section>
            <section className="flex flex-col gap-1">
              <h2 className="au-dim text-sm uppercase tracking-wider">Tally</h2>
              {result.tally.map((row) => (
                <p key={row.name}>
                  {row.name}: {row.count}
                </p>
              ))}
            </section>
            {result.ballots && (
              <section className="flex flex-col gap-1">
                <h2 className="au-dim text-sm uppercase tracking-wider">Votes</h2>
                {result.ballots.map((b, i) => (
                  <p key={i} className="au-dim">
                    {b.voterName} -&gt; {b.targetName}
                  </p>
                ))}
              </section>
            )}
          </>
        )}
      </main>
    );
  }

  if (state.phase === "ended") {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-6 py-16">
        {identity}
        {deadBanner}
        <h1 className="text-center text-4xl font-bold">
          {state.winner === "crew" ? "CREW WINS" : state.winner === "imposters" ? "IMPOSTERS WIN" : "GAME OVER"}
        </h1>
        <ul className="au-card flex flex-col gap-1">
          {state.roster.map((p) => (
            <li key={p.playerId} className={p.isAlive ? "" : "au-dim line-through"}>
              {p.name} &mdash; {p.role === "imposter" ? "Imposter" : p.role === "crew" ? "Crewmate" : "?"}
              {!p.isAlive ? " (dead)" : ""}
            </li>
          ))}
        </ul>
        <p className="au-dim text-center text-sm">Host can reset from the host screen.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-16">
      <p className="au-dim text-center">Unknown phase</p>
    </main>
  );
}
