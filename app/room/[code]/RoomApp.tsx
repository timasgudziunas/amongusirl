"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getCode, getToken } from "@/lib/client";
import { supabaseBrowser } from "@/lib/supabase/browser";

type RosterEntry = { playerId: string; name: string; isHost?: boolean; hasCalledMeeting?: boolean };
type LobbyState = { phase: "lobby"; roster: RosterEntry[] };
type PlayingState = {
  phase: "playing";
  round: number;
  roster: RosterEntry[];
  tasksDone?: number;
  tasksTotal?: number;
};
type OtherPhase = "gathering" | "meeting" | "voting" | "results" | "ended";
type OtherState = { phase: OtherPhase };
type StateResponse = LobbyState | PlayingState | OtherState;

type MyTask = { taskId: string; name: string; location: string; description: string | null; done: boolean };
type MeResponse = {
  role: "crew" | "imposter" | null;
  partnerNames?: string[];
  isAlive: boolean;
  isHere: boolean;
  myTasks: MyTask[];
};

export default function RoomApp({ code }: { code: string }) {
  const router = useRouter();
  const [state, setState] = useState<StateResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // Poll /api/state every 2s per work order.
  useEffect(() => {
    const interval = setInterval(fetchState, 2000);
    return () => clearInterval(interval);
  }, [fetchState]);

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

  // While playing, poll /me for role + own task list.
  useEffect(() => {
    if (!state || state.phase !== "playing") return;
    const timeout = setTimeout(fetchMe, 0);
    const interval = setInterval(fetchMe, 2000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [state, fetchMe]);

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

  if (state.phase === "lobby") {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-6 py-16">
        <p className="text-center text-xl">Waiting for host...</p>
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
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-6 py-10">
        {me && (
          <section className="text-center">
            {me.role === "imposter" ? (
              <>
                <h1 className="text-3xl tracking-wide">IMPOSTER</h1>
                {me.partnerNames && me.partnerNames.length > 0 && (
                  <p className="au-dim mt-1">With: {me.partnerNames.join(", ")}</p>
                )}
              </>
            ) : (
              <h1 className="text-3xl tracking-wide">CREWMATE</h1>
            )}
          </section>
        )}

        {state.tasksTotal !== undefined && (
          <p className="au-dim text-center">
            Tasks: {state.tasksDone}/{state.tasksTotal}
          </p>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="au-dim text-sm uppercase tracking-wider">Your tasks</h2>
          <div className="flex flex-col gap-2">
            {(me?.myTasks ?? []).map((task) => (
              <div key={task.taskId} className="au-card">
                <p className="text-lg">{task.name}</p>
                <p className="au-dim">{task.location}</p>
                {task.description && <p className="au-dim">{task.description}</p>}
              </div>
            ))}
            {me && me.myTasks.length === 0 && <p className="au-dim">No tasks assigned.</p>}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-16">
      <p className="au-dim text-center">{state.phase}</p>
    </main>
  );
}
