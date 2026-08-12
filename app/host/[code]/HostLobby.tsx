"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, getCode, getPin, getSavedTasks, getToken, setPin, setSavedTasks, type SavedTask } from "@/lib/client";
import { supabaseBrowser } from "@/lib/supabase/browser";

type RosterEntry = { playerId: string; name: string; isHost: boolean; hasCalledMeeting: boolean };
type TaskRow = { taskId: string; orderIndex: number; name: string; location: string; description: string | null };
type Settings = {
  imposterCount: number;
  taskCapacity: number;
  tasksPerPlayer: number | null;
  anonymousVoting: boolean;
  showTaskBar: boolean;
  imposterTasksCount: boolean;
  ghostTasks: boolean;
  gatheringSecs: number;
  meetingSecs: number;
  votingSecs: number;
  resultsSecs: number;
  taskSecs: number;
  doorSecs: number;
  sabotageSecs: number;
};
type Validation = { canStart: boolean; errors: string[] };

type LobbyState = {
  phase: "lobby";
  roster: RosterEntry[];
  tasks: TaskRow[];
  isHost: boolean;
  settings: Settings;
  validation: Validation;
};
type PlayingState = { phase: "playing"; round: number; roster: { playerId: string; name: string }[] };
type OtherPhase = "gathering" | "sabotage" | "meeting" | "voting" | "results" | "ended";
type OtherState = { phase: OtherPhase };
type StateResponse = LobbyState | PlayingState | OtherState;

type EditableTask = { name: string; location: string; description: string };

function suggestedImposters(playerCount: number): number {
  if (playerCount >= 15) return 3;
  if (playerCount >= 9) return 2;
  return 1;
}

function Stepper({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span>
        {label}
        {hint && <span className="au-dim"> {hint}</span>}
      </span>
      <span className="flex items-center gap-3">
        <button
          type="button"
          className="au-button-small"
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
        >
          -
        </button>
        <span className="min-w-12 text-center text-xl tabular-nums">
          {value}
          {suffix && <span className="au-dim text-sm">{suffix}</span>}
        </span>
        <button
          type="button"
          className="au-button-small"
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
        >
          +
        </button>
      </span>
    </label>
  );
}

export default function HostLobby({ code }: { code: string }) {
  const router = useRouter();
  const [state, setState] = useState<StateResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const [newTask, setNewTask] = useState<EditableTask>({ name: "", location: "", description: "" });
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingTask, setEditingTask] = useState<EditableTask>({ name: "", location: "", description: "" });

  const [optimistic, setOptimistic] = useState<Partial<Settings>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const [pin, setPinValue] = useState<string | null>(() => getPin());
  const [claimPin, setClaimPin] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [pinRejected, setPinRejected] = useState(false);

  const [savedTasks] = useState<SavedTask[]>(() => getSavedTasks());
  const [kickPendingId, setKickPendingId] = useState<string | null>(null);
  const [kickBusy, setKickBusy] = useState(false);
  const [kickError, setKickError] = useState<string | null>(null);

  const [forceBusy, setForceBusy] = useState(false);
  const [forceError, setForceError] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [finishBusy, setFinishBusy] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    const seq = ++fetchSeq.current;
    const res = await api<StateResponse>(`/api/state?code=${code}`);
    if (seq !== fetchSeq.current) return; // a newer request already landed
    if (!res.ok) {
      if (res.error.toLowerCase().includes("token") || res.error.toLowerCase().includes("member")) {
        router.push("/");
        return;
      }
      setLoadError(res.error);
      return;
    }
    setLoadError(null);
    setState(res);
  }, [code, router]);

  useEffect(() => {
    const token = getToken();
    const storedCode = getCode();
    if (!token || !storedCode || storedCode.toUpperCase() !== code) {
      router.push("/");
      return;
    }
    // Deferred so the fetch's eventual setState isn't called synchronously
    // from within the effect body.
    const timeout = setTimeout(fetchState, 0);
    return () => clearTimeout(timeout);
  }, [code, router, fetchState]);

  // 5s polling fallback, per work order.
  useEffect(() => {
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
  }, [fetchState]);

  // Realtime accelerant: refetch on roster changes.
  useEffect(() => {
    const client = supabaseBrowser();
    const channel = client
      .channel(`host-players-${code}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "players", filter: `room_code=eq.${code}` },
        () => fetchState()
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "players", filter: `room_code=eq.${code}` },
        () => fetchState()
      )
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [code, fetchState]);

  async function saveTaskList(next: EditableTask[]): Promise<boolean> {
    if (!pin) return false;
    setTaskBusy(true);
    const res = await api("/api/tasks", { body: { pin, tasks: next } });
    if (!res.ok) {
      setTaskError(res.error);
      if (res.error === "Invalid host PIN") setPinRejected(true);
      setTaskBusy(false);
      return false;
    }
    setTaskError(null);
    // Mirror every successfully saved list to this device so the next room can be
    // seeded without retyping.
    setSavedTasks(next.map((t) => ({ name: t.name, location: t.location, description: t.description })));
    await fetchState();
    setTaskBusy(false);
    return true;
  }

  async function loadSavedTasks() {
    if (savedTasks.length === 0) return;
    await saveTaskList(savedTasks.map((t) => ({ ...t })));
  }

  async function kickPlayer(playerId: string) {
    if (!pin) return;
    if (kickPendingId !== playerId) {
      setKickPendingId(playerId);
      return;
    }
    setKickPendingId(null);
    setKickBusy(true);
    setKickError(null);
    const res = await api("/api/kick", { body: { pin, playerId } });
    setKickBusy(false);
    if (!res.ok) {
      setKickError(res.error);
      if (res.error === "Invalid host PIN") setPinRejected(true);
      return;
    }
    fetchState();
  }

  async function moveTask(index: number, direction: -1 | 1) {
    if (!state || state.phase !== "lobby") return;
    const target = index + direction;
    if (target < 0 || target >= state.tasks.length) return;
    const next = state.tasks.map((t) => ({ name: t.name, location: t.location, description: t.description ?? "" }));
    [next[index], next[target]] = [next[target], next[index]];
    await saveTaskList(next);
  }

  async function removeTask(index: number) {
    if (!state || state.phase !== "lobby") return;
    const next = state.tasks
      .filter((_, i) => i !== index)
      .map((t) => ({ name: t.name, location: t.location, description: t.description ?? "" }));
    await saveTaskList(next);
  }

  function startEditTask(index: number) {
    if (!state || state.phase !== "lobby") return;
    const task = state.tasks[index];
    setEditingIndex(index);
    setEditingTask({ name: task.name, location: task.location, description: task.description ?? "" });
    setTaskError(null);
  }

  function cancelEditTask() {
    setEditingIndex(null);
    setTaskError(null);
  }

  async function saveEditTask() {
    if (!state || state.phase !== "lobby" || editingIndex === null) return;
    const name = editingTask.name.trim();
    const location = editingTask.location.trim();
    if (name.length === 0 || location.length === 0) {
      setTaskError("Task needs a name and a location.");
      return;
    }
    const next = state.tasks.map((t, i) =>
      i === editingIndex
        ? { name, location, description: editingTask.description.trim() }
        : { name: t.name, location: t.location, description: t.description ?? "" }
    );
    const success = await saveTaskList(next);
    if (success) setEditingIndex(null);
  }

  async function addTask() {
    if (!state || state.phase !== "lobby") return;
    const name = newTask.name.trim();
    const location = newTask.location.trim();
    if (name.length === 0 || location.length === 0) {
      setTaskError("Task needs a name and a location.");
      return;
    }
    const current = state.tasks.map((t) => ({ name: t.name, location: t.location, description: t.description ?? "" }));
    const success = await saveTaskList([...current, { name, location, description: newTask.description.trim() }]);
    if (success) {
      setNewTask({ name: "", location: "", description: "" });
      setTaskError(null);
    }
  }

  async function updateSetting(patch: Partial<Settings>) {
    if (!pin) return;
    setSettingsError(null);
    setOptimistic((prev) => ({ ...prev, ...patch }));
    const keys = Object.keys(patch) as (keyof Settings)[];
    const res = await api("/api/settings", { body: { pin, ...patch } });
    if (!res.ok) {
      setSettingsError(res.error);
      if (res.error === "Invalid host PIN") setPinRejected(true);
      setOptimistic((prev) => {
        const next = { ...prev };
        keys.forEach((k) => delete next[k]);
        return next;
      });
      return;
    }
    await fetchState();
    setOptimistic((prev) => {
      const next = { ...prev };
      keys.forEach((k) => delete next[k]);
      return next;
    });
  }

  async function startRound() {
    if (!pin) return;
    setStarting(true);
    setStartError(null);
    const res = await api("/api/start-round", { body: { pin } });
    setStarting(false);
    if (!res.ok) {
      setStartError(res.error);
      if (res.error === "Invalid host PIN") setPinRejected(true);
      return;
    }
    fetchState();
  }

  // Reset transient two-step / error state whenever the phase changes.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setResetConfirm(false);
      setResetError(null);
      setForceError(null);
      setFinishError(null);
    }, 0);
    return () => clearTimeout(timeout);
  }, [state?.phase]);

  async function forceMeeting() {
    if (!pin) return;
    setForceBusy(true);
    setForceError(null);
    const res = await api("/api/force-meeting", { body: { pin } });
    setForceBusy(false);
    if (!res.ok) {
      setForceError(res.error);
      if (res.error === "Invalid host PIN") setPinRejected(true);
      return;
    }
    fetchState();
  }

  async function finishMeeting() {
    if (!pin) return;
    setFinishBusy(true);
    setFinishError(null);
    const res = await api("/api/finish-meeting", { body: { pin } });
    setFinishBusy(false);
    if (!res.ok) {
      setFinishError(res.error);
      if (res.error === "Invalid host PIN") setPinRejected(true);
      return;
    }
    fetchState();
  }

  async function resetToLobby() {
    if (!pin) return;
    if (!resetConfirm) {
      setResetConfirm(true);
      return;
    }
    setResetConfirm(false);
    setResetBusy(true);
    setResetError(null);
    const res = await api("/api/reset", { body: { pin } });
    setResetBusy(false);
    if (!res.ok) {
      setResetError(res.error);
      if (res.error === "Invalid host PIN") setPinRejected(true);
      return;
    }
    fetchState();
  }

  async function claimHost() {
    const sanitized = claimPin.replace(/\D/g, "").slice(0, 4);
    if (sanitized.length !== 4) {
      setClaimError("Enter the 4 digit host PIN.");
      return;
    }
    setClaiming(true);
    setClaimError(null);
    const res = await api("/api/claim-host", { body: { pin: sanitized } });
    setClaiming(false);
    if (!res.ok) {
      setClaimError(res.error);
      return;
    }
    setPin(sanitized);
    setPinValue(sanitized);
    setPinRejected(false);
    setClaimError(null);
    setClaimPin("");
    await fetchState();
  }

  if (loadError) {
    return (
      <main className="au-bright mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p className="au-error">{loadError}</p>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="au-bright mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p className="au-dim">Loading...</p>
      </main>
    );
  }

  const settings: Settings | null = state.phase === "lobby" ? { ...state.settings, ...optimistic } : null;
  const isHostDevice = state.phase === "lobby" && state.isHost && !pinRejected;

  return (
    <main className="au-bright mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-10">
      <div className="text-center">
        <p className="au-dim text-sm uppercase tracking-wider">Room code</p>
        <h1 className="text-6xl tracking-widest">{code}</h1>
        {state.phase === "lobby" && <p className="au-dim mt-1">{state.roster.length} players joined</p>}
      </div>

      {state.phase === "playing" && (
        <section className="au-card flex flex-col gap-3 text-center">
          <p className="text-lg">Round {state.round} live</p>
          <Link href={`/room/${code}`} className="au-button">
            Open player view
          </Link>
        </section>
      )}

      {state.phase !== "lobby" && state.phase !== "playing" && (
        <p className="au-dim text-center">Phase: {state.phase}</p>
      )}

      {state.phase !== "lobby" && pin && !pinRejected && (
        <section className="flex flex-col gap-3">
          <h2 className="au-dim text-sm uppercase tracking-wider">Host controls</h2>

          {state.phase === "gathering" && (
            <>
              <button type="button" className="au-button" disabled={forceBusy} onClick={forceMeeting}>
                {forceBusy ? "Starting..." : "Force start discussion"}
              </button>
              {forceError && <p className="au-error-banner">{forceError}</p>}
            </>
          )}

          {state.phase === "meeting" && (
            <>
              <button type="button" className="au-button" disabled={finishBusy} onClick={finishMeeting}>
                {finishBusy ? "Finishing..." : "Finish meeting"}
              </button>
              {finishError && <p className="au-error-banner">{finishError}</p>}
            </>
          )}

          <button type="button" className="au-button" disabled={resetBusy} onClick={resetToLobby}>
            {resetBusy ? "Resetting..." : resetConfirm ? "Tap again to confirm reset" : "Reset to lobby"}
          </button>
          {resetError && <p className="au-error-banner">{resetError}</p>}
        </section>
      )}

      {state.phase === "lobby" && settings && (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="au-dim text-sm uppercase tracking-wider">
              Roster ({state.roster.length})
            </h2>
            <ul className="au-card flex flex-col gap-1">
              {state.roster.map((p) => (
                <li key={p.playerId} className="flex items-center justify-between gap-2">
                  <span>
                    {p.name}
                    {p.isHost ? " (host)" : ""}
                  </span>
                  {isHostDevice && !p.isHost && (
                    <button
                      type="button"
                      className="au-button-small"
                      disabled={kickBusy}
                      onClick={() => kickPlayer(p.playerId)}
                    >
                      {kickPendingId === p.playerId ? "Sure?" : "Remove"}
                    </button>
                  )}
                </li>
              ))}
              {state.roster.length === 0 && <li className="au-dim">Waiting for players...</li>}
            </ul>
            {kickError && <p className="au-error-banner">{kickError}</p>}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="au-dim text-sm uppercase tracking-wider">Tasks ({state.tasks.length})</h2>
            {!isHostDevice && (
              <div className="flex flex-col gap-2">
                {state.tasks.map((task) => (
                  <div key={task.taskId} className="au-card py-2">
                    {task.name} · {task.location}
                  </div>
                ))}
                {state.tasks.length === 0 && <p className="au-dim">No tasks yet.</p>}
              </div>
            )}
            {isHostDevice && (
            <>
            <div className="flex flex-col gap-2">
              {state.tasks.map((task, index) =>
                editingIndex !== null && editingIndex < state.tasks.length && index === editingIndex ? (
                  <div key={task.taskId} className="au-card flex flex-col gap-2">
                    <div className="flex gap-2">
                      <input
                        className="au-input"
                        placeholder="Name"
                        maxLength={80}
                        value={editingTask.name}
                        onChange={(e) => setEditingTask((prev) => ({ ...prev, name: e.target.value }))}
                      />
                      <input
                        className="au-input"
                        placeholder="Location"
                        maxLength={80}
                        value={editingTask.location}
                        onChange={(e) => setEditingTask((prev) => ({ ...prev, location: e.target.value }))}
                      />
                    </div>
                    <input
                      className="au-input"
                      placeholder="Description (optional)"
                      maxLength={280}
                      value={editingTask.description}
                      onChange={(e) => setEditingTask((prev) => ({ ...prev, description: e.target.value }))}
                    />
                    <div className="flex gap-2">
                      <button type="button" className="au-button-small" onClick={saveEditTask} disabled={taskBusy}>
                        Save
                      </button>
                      <button type="button" className="au-button-small" onClick={cancelEditTask} disabled={taskBusy}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={task.taskId} className="au-card py-2 flex items-center gap-2">
                    <span className="truncate min-w-0 flex-1">
                      {task.name} · {task.location}
                    </span>
                    <button
                      type="button"
                      className="au-button-small"
                      onClick={() => moveTask(index, -1)}
                      disabled={taskBusy || index === 0}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="au-button-small"
                      onClick={() => moveTask(index, 1)}
                      disabled={taskBusy || index === state.tasks.length - 1}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="au-button-small"
                      onClick={() => startEditTask(index)}
                      disabled={taskBusy}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="au-button-small"
                      onClick={() => removeTask(index)}
                      disabled={taskBusy}
                    >
                      X
                    </button>
                  </div>
                )
              )}
              {state.tasks.length === 0 && <p className="au-dim">No tasks yet.</p>}
            </div>

            {state.tasks.length === 0 && savedTasks.length > 0 && (
              <button type="button" className="au-button" disabled={taskBusy} onClick={loadSavedTasks}>
                Load saved tasks ({savedTasks.length})
              </button>
            )}

            <div className="au-card flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  className="au-input"
                  placeholder="Name"
                  maxLength={80}
                  value={newTask.name}
                  onChange={(e) => setNewTask((prev) => ({ ...prev, name: e.target.value }))}
                />
                <input
                  className="au-input"
                  placeholder="Location"
                  maxLength={80}
                  value={newTask.location}
                  onChange={(e) => setNewTask((prev) => ({ ...prev, location: e.target.value }))}
                />
              </div>
              <input
                className="au-input"
                placeholder="Description (optional)"
                maxLength={280}
                value={newTask.description}
                onChange={(e) => setNewTask((prev) => ({ ...prev, description: e.target.value }))}
              />
              <button type="button" className="au-button" onClick={addTask} disabled={taskBusy}>
                Add task
              </button>
            </div>

            {taskError && <p className="au-error-banner">{taskError}</p>}
            </>
            )}
          </section>

          {!isHostDevice && (
            <section className="flex flex-col gap-3">
              <h2 className="au-dim text-sm uppercase tracking-wider">Host controls</h2>
              <p className="au-dim">
                {pinRejected
                  ? "The saved host PIN on this device is wrong. Enter the host PIN to continue."
                  : "This device is not the host. Enter the host PIN to claim host controls."}
              </p>
              <input
                className="au-input"
                inputMode="numeric"
                maxLength={4}
                placeholder="4 digit host PIN"
                value={claimPin}
                onChange={(e) => setClaimPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              />
              {claimError && <p className="au-error">{claimError}</p>}
              <button type="button" className="au-button" onClick={claimHost} disabled={claiming}>
                {claiming ? "Claiming..." : "Claim host"}
              </button>
            </section>
          )}

          {isHostDevice && (
          <>
          <section className="flex flex-col gap-3">
            <h2 className="au-dim text-sm uppercase tracking-wider">Settings</h2>

            <div className="au-card flex flex-col gap-3">
              <h3 className="au-dim text-sm uppercase tracking-wider">Roles</h3>
              <Stepper
                label="Imposters"
                hint={`(suggested ${suggestedImposters(state.roster.length)} for ${state.roster.length} players)`}
                value={settings.imposterCount}
                min={1}
                max={10}
                onChange={(n) => updateSetting({ imposterCount: n })}
              />
            </div>

            <div className="au-card flex flex-col gap-3">
              <h3 className="au-dim text-sm uppercase tracking-wider">Tasks</h3>
              <label className="flex flex-col gap-1">
                <span>Tasks per player (blank = all tasks)</span>
                <input
                  className="au-input"
                  type="number"
                  min={1}
                  placeholder="all"
                  value={settings.tasksPerPlayer ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    updateSetting({ tasksPerPlayer: raw === "" ? null : Math.max(1, Number(raw)) });
                  }}
                />
              </label>
              <Stepper
                label="Task duration"
                value={settings.taskSecs}
                min={5}
                max={120}
                step={5}
                suffix="s"
                onChange={(n) => updateSetting({ taskSecs: n })}
              />
              <Stepper
                label="Players per station"
                value={settings.taskCapacity}
                min={1}
                max={10}
                onChange={(n) => updateSetting({ taskCapacity: n })}
              />
              <label className="flex items-center justify-between gap-2">
                <span>Show task progress bar</span>
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  checked={settings.showTaskBar}
                  onChange={(e) => updateSetting({ showTaskBar: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span>Imposter task completions count toward the bar</span>
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  checked={settings.imposterTasksCount}
                  onChange={(e) => updateSetting({ imposterTasksCount: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span>Ghost tasks (dead crewmates keep doing tasks)</span>
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  checked={settings.ghostTasks}
                  onChange={(e) => updateSetting({ ghostTasks: e.target.checked })}
                />
              </label>
            </div>

            <div className="au-card flex flex-col gap-3">
              <h3 className="au-dim text-sm uppercase tracking-wider">Meetings and voting</h3>
              <Stepper
                label="Gather at table"
                value={settings.gatheringSecs}
                min={15}
                max={600}
                step={15}
                suffix="s"
                onChange={(n) => updateSetting({ gatheringSecs: n })}
              />
              <Stepper
                label="Discussion"
                value={settings.meetingSecs}
                min={15}
                max={600}
                step={15}
                suffix="s"
                onChange={(n) => updateSetting({ meetingSecs: n })}
              />
              <Stepper
                label="Voting"
                value={settings.votingSecs}
                min={5}
                max={600}
                step={5}
                suffix="s"
                onChange={(n) => updateSetting({ votingSecs: n })}
              />
              <Stepper
                label="Results screen"
                value={settings.resultsSecs}
                min={5}
                max={60}
                step={5}
                suffix="s"
                onChange={(n) => updateSetting({ resultsSecs: n })}
              />
              <Stepper
                label="Sabotage timer"
                value={settings.sabotageSecs}
                min={10}
                max={300}
                step={5}
                suffix="s"
                onChange={(n) => updateSetting({ sabotageSecs: n })}
              />
              <label className="flex items-center justify-between gap-2">
                <span>Anonymous voting</span>
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  checked={settings.anonymousVoting}
                  onChange={(e) => updateSetting({ anonymousVoting: e.target.checked })}
                />
              </label>
            </div>

            <div className="au-card flex flex-col gap-3">
              <h3 className="au-dim text-sm uppercase tracking-wider">Screens</h3>
              <Stepper
                label="Door screen"
                value={settings.doorSecs}
                min={2}
                max={30}
                step={1}
                suffix="s"
                onChange={(n) => updateSetting({ doorSecs: n })}
              />
            </div>

            {settingsError && <p className="au-error-banner">{settingsError}</p>}
          </section>

          <section className="flex flex-col gap-2">
            {state.validation.errors.length > 0 && (
              <ul className="flex flex-col gap-1">
                {state.validation.errors.map((err) => (
                  <li key={err} className="au-error">
                    {err}
                  </li>
                ))}
              </ul>
            )}
            {startError && <p className="au-error-banner">{startError}</p>}
            <button
              type="button"
              className="au-button"
              disabled={!state.validation.canStart || starting}
              onClick={startRound}
            >
              {starting ? "Starting..." : "Start Round"}
            </button>
          </section>
          </>
          )}
        </>
      )}
    </main>
  );
}
