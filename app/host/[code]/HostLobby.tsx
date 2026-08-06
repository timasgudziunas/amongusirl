"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, getCode, getPin, getToken } from "@/lib/client";
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
type OtherPhase = "gathering" | "meeting" | "voting" | "results" | "ended";
type OtherState = { phase: OtherPhase };
type StateResponse = LobbyState | PlayingState | OtherState;

type EditableTask = { name: string; location: string; description: string };

function suggestedImposters(playerCount: number): number {
  if (playerCount >= 15) return 3;
  if (playerCount >= 9) return 2;
  return 1;
}

export default function HostLobby({ code }: { code: string }) {
  const router = useRouter();
  const [state, setState] = useState<StateResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [taskDraft, setTaskDraft] = useState<EditableTask[]>([]);
  const [syncedTasks, setSyncedTasks] = useState<TaskRow[] | null>(null);
  const [taskDraftDirty, setTaskDraftDirty] = useState(false);
  const [savingTasks, setSavingTasks] = useState(false);
  const [taskSaveError, setTaskSaveError] = useState<string | null>(null);

  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const pin = getPin();

  const fetchState = useCallback(async () => {
    const res = await api<StateResponse>(`/api/state?code=${code}`);
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

  // Keep the task draft in sync with the server, unless the host has unsaved
  // edits. Adjusted during render (React's endorsed pattern for derived
  // state), not inside an effect, so it doesn't cost an extra commit.
  if (state && state.phase === "lobby" && !taskDraftDirty && state.tasks !== syncedTasks) {
    setSyncedTasks(state.tasks);
    setTaskDraft(
      state.tasks.map((t) => ({ name: t.name, location: t.location, description: t.description ?? "" }))
    );
  }

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

  function updateTaskField(index: number, field: keyof EditableTask, value: string) {
    setTaskDraftDirty(true);
    setTaskDraft((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)));
  }

  function addTaskRow() {
    setTaskDraftDirty(true);
    setTaskDraft((prev) => [...prev, { name: "", location: "", description: "" }]);
  }

  function removeTaskRow(index: number) {
    setTaskDraftDirty(true);
    setTaskDraft((prev) => prev.filter((_, i) => i !== index));
  }

  function moveTaskRow(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= taskDraft.length) return;
    setTaskDraftDirty(true);
    setTaskDraft((prev) => {
      const next = prev.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function saveTasks() {
    if (!pin) return;
    setSavingTasks(true);
    setTaskSaveError(null);
    const cleaned = taskDraft
      .map((t) => ({ name: t.name.trim(), location: t.location.trim(), description: t.description.trim() }))
      .filter((t) => t.name.length > 0 && t.location.length > 0);
    const res = await api("/api/tasks", {
      body: { pin, tasks: cleaned },
    });
    setSavingTasks(false);
    if (!res.ok) {
      setTaskSaveError(res.error);
      return;
    }
    setTaskDraftDirty(false);
    fetchState();
  }

  async function updateSetting(patch: Record<string, unknown>) {
    if (!pin) return;
    setSettingsError(null);
    const res = await api("/api/settings", { body: { pin, ...patch } });
    if (!res.ok) {
      setSettingsError(res.error);
      return;
    }
    fetchState();
  }

  async function startRound() {
    if (!pin) return;
    setStarting(true);
    setStartError(null);
    const res = await api("/api/start-round", { body: { pin } });
    setStarting(false);
    if (!res.ok) {
      setStartError(res.error);
      return;
    }
    fetchState();
  }

  if (loadError) {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p className="au-error">{loadError}</p>
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

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-10">
      <div className="text-center">
        <p className="au-dim text-sm uppercase tracking-wider">Room code</p>
        <h1 className="text-6xl tracking-widest">{code}</h1>
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
        <p className="au-dim">Phase: {state.phase}</p>
      )}

      {state.phase === "lobby" && (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="au-dim text-sm uppercase tracking-wider">
              Roster ({state.roster.length})
            </h2>
            <ul className="au-card flex flex-col gap-1">
              {state.roster.map((p) => (
                <li key={p.playerId}>
                  {p.name}
                  {p.isHost ? " (host)" : ""}
                </li>
              ))}
              {state.roster.length === 0 && <li className="au-dim">Waiting for players...</li>}
            </ul>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="au-dim text-sm uppercase tracking-wider">Tasks</h2>
            <div className="flex flex-col gap-3">
              {taskDraft.map((task, index) => (
                <div key={index} className="au-card flex flex-col gap-2">
                  <div className="flex gap-2">
                    <input
                      className="au-input"
                      placeholder="Name"
                      value={task.name}
                      onChange={(e) => updateTaskField(index, "name", e.target.value)}
                    />
                    <input
                      className="au-input"
                      placeholder="Location"
                      value={task.location}
                      onChange={(e) => updateTaskField(index, "location", e.target.value)}
                    />
                  </div>
                  <input
                    className="au-input"
                    placeholder="Description (optional)"
                    value={task.description}
                    onChange={(e) => updateTaskField(index, "description", e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="au-button-small"
                      onClick={() => moveTaskRow(index, -1)}
                      disabled={index === 0}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="au-button-small"
                      onClick={() => moveTaskRow(index, 1)}
                      disabled={index === taskDraft.length - 1}
                    >
                      Down
                    </button>
                    <button type="button" className="au-button-small" onClick={() => removeTaskRow(index)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              <button type="button" className="au-button-small" onClick={addTaskRow}>
                + Add task
              </button>
            </div>
            {taskSaveError && <p className="au-error">{taskSaveError}</p>}
            <button type="button" className="au-button" onClick={saveTasks} disabled={savingTasks}>
              {savingTasks ? "Saving..." : "Save Tasks"}
            </button>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="au-dim text-sm uppercase tracking-wider">Settings</h2>

            <label className="flex flex-col gap-1">
              <span>
                Imposter count
                <span className="au-dim">
                  {" "}
                  (suggested {suggestedImposters(state.roster.length)} for {state.roster.length} players)
                </span>
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="au-button-small"
                  onClick={() =>
                    updateSetting({ imposterCount: Math.max(1, state.settings.imposterCount - 1) })
                  }
                >
                  -
                </button>
                <span className="text-xl">{state.settings.imposterCount}</span>
                <button
                  type="button"
                  className="au-button-small"
                  onClick={() => updateSetting({ imposterCount: state.settings.imposterCount + 1 })}
                >
                  +
                </button>
              </div>
            </label>

            <label className="flex flex-col gap-1">
              <span>Tasks per player (blank = all tasks)</span>
              <input
                className="au-input"
                type="number"
                min={1}
                placeholder="all"
                value={state.settings.tasksPerPlayer ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  updateSetting({ tasksPerPlayer: raw === "" ? null : Math.max(1, Number(raw)) });
                }}
              />
            </label>

            <label className="flex items-center justify-between gap-2">
              <span>Anonymous voting</span>
              <input
                type="checkbox"
                checked={state.settings.anonymousVoting}
                onChange={(e) => updateSetting({ anonymousVoting: e.target.checked })}
              />
            </label>

            <label className="flex items-center justify-between gap-2">
              <span>Imposter task completions count toward the bar</span>
              <input
                type="checkbox"
                checked={state.settings.imposterTasksCount}
                onChange={(e) => updateSetting({ imposterTasksCount: e.target.checked })}
              />
            </label>

            <label className="flex items-center justify-between gap-2">
              <span>Ghost tasks (dead crewmates keep doing tasks)</span>
              <input
                type="checkbox"
                checked={state.settings.ghostTasks}
                onChange={(e) => updateSetting({ ghostTasks: e.target.checked })}
              />
            </label>

            {settingsError && <p className="au-error">{settingsError}</p>}
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
            {startError && <p className="au-error">{startError}</p>}
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
    </main>
  );
}
