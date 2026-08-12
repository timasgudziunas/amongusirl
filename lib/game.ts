import "server-only";
import type { supabaseAdmin } from "@/lib/supabase/server";

// Shared game-logic helpers used by multiple routes. Kept here instead of duplicated
// in each route because /tick, /vote, /dead, and /meeting all need overlapping pieces
// of this (occupancy resync, task counters, win checks).

type Admin = ReturnType<typeof supabaseAdmin>;

/** Seconds the "ended" (winner) screen stays up before /tick auto-resets to lobby. */
export const ENDED_SECS = 10;

// Loose shape of a `rooms` row — only the fields these helpers actually read/write.
export type RoomRow = {
  code: string;
  phase: string;
  round: number;
  meeting_no: number;
  imposter_count: number;
  imposter_tasks_count: boolean;
  ghost_tasks: boolean;
  anonymous_voting: boolean;
  results_secs: number;
};

export type VoteTally = { name: string; count: number };
export type Ballot = { voterName: string; targetName: string };
export type VoteResult = {
  ejectedName: string | null;
  wasImposter: boolean | null;
  skipped: boolean;
  tied: boolean;
  tally: VoteTally[];
  ballots?: Ballot[];
};

/**
 * Deletes expired claims for a room, then resyncs every task_occupancy row in that
 * room to the actual remaining claim count. Only writes rows whose count changed, to
 * avoid spamming Realtime subscribers with no-op updates every tick.
 */
export async function clearExpiredClaims(admin: Admin, roomCode: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await admin.from("task_claims").delete().eq("room_code", roomCode).lt("expires_at", nowIso);

  const [{ data: occRows }, { data: claimRows }] = await Promise.all([
    admin.from("task_occupancy").select("task_id, occupied").eq("room_code", roomCode),
    admin.from("task_claims").select("task_id").eq("room_code", roomCode),
  ]);

  const counts = new Map<string, number>();
  for (const row of claimRows ?? []) {
    const taskId = (row as { task_id: string }).task_id;
    counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }

  const stale = (occRows ?? []).filter((row) => {
    const r = row as { task_id: string; occupied: number };
    return (counts.get(r.task_id) ?? 0) !== r.occupied;
  });

  await Promise.all(
    stale.map((row) => {
      const r = row as { task_id: string; occupied: number };
      const occupied = counts.get(r.task_id) ?? 0;
      return admin
        .from("task_occupancy")
        .update({ occupied })
        .eq("room_code", roomCode)
        .eq("task_id", r.task_id);
    })
  );
}

/** Resyncs occupancy for a single task (used after complete/abandon, which only touch one). */
export async function syncTaskOccupancy(admin: Admin, roomCode: string, taskId: string): Promise<number> {
  const { count } = await admin
    .from("task_claims")
    .select("*", { count: "exact", head: true })
    .eq("room_code", roomCode)
    .eq("task_id", taskId);
  const occupied = count ?? 0;
  await admin
    .from("task_occupancy")
    .update({ occupied })
    .eq("room_code", roomCode)
    .eq("task_id", taskId);
  return occupied;
}

type CounterResult = { tasksDone: number; tasksTotal: number };

/**
 * Recomputes tasks_done / tasks_total from scratch. "Counting players" are crewmates,
 * plus imposters if imposter_tasks_count is set. A dead player's incomplete tasks are
 * dropped from the total unless ghost_tasks is on. Does not write to rooms — the caller
 * decides whether the value actually changed before writing (avoids Realtime spam).
 */
export async function recomputeTaskCounters(admin: Admin, room: RoomRow): Promise<CounterResult> {
  if (room.round === 0) return { tasksDone: 0, tasksTotal: 0 };

  // player_roles has no room_code column — scope through the players join, same
  // pattern as /api/me, otherwise this would match same-round players in other rooms.
  const { data: roleRows } = await admin
    .from("player_roles")
    .select("player_id, role, players!inner(room_code)")
    .eq("round", room.round)
    .eq("players.room_code", room.code);

  const countingIds: string[] = [];
  for (const row of roleRows ?? []) {
    const r = row as unknown as { player_id: string; role: string };
    if (r.role === "crew" || room.imposter_tasks_count) {
      countingIds.push(r.player_id);
    }
  }
  if (countingIds.length === 0) return { tasksDone: 0, tasksTotal: 0 };

  const [{ data: secretRows }, { data: taskRows }] = await Promise.all([
    admin.from("player_secrets").select("player_id, is_alive").in("player_id", countingIds),
    admin
      .from("player_tasks")
      .select("player_id, completed_at, reveal_at")
      .eq("round", room.round)
      .in("player_id", countingIds),
  ]);

  const aliveMap = new Map<string, boolean>();
  for (const row of secretRows ?? []) {
    const r = row as { player_id: string; is_alive: boolean };
    aliveMap.set(r.player_id, r.is_alive);
  }

  const nowMs = Date.now();
  let tasksDone = 0;
  let tasksTotal = 0;
  for (const row of taskRows ?? []) {
    const r = row as { player_id: string; completed_at: string | null; reveal_at: string | null };
    const isAlive = aliveMap.get(r.player_id) ?? true;
    const countsTowardTotal = isAlive || room.ghost_tasks || r.completed_at !== null;
    if (!countsTowardTotal) continue;
    tasksTotal++;
    if (r.reveal_at !== null && new Date(r.reveal_at).getTime() <= nowMs) {
      tasksDone++;
    }
  }

  return { tasksDone, tasksTotal };
}

/**
 * Living imposters/crew from player_roles + player_secrets, plus a fresh task-counter
 * recompute. Returns the winner if one is triggered, else null. Does not write anything
 * — the caller applies the transition via endGame (or, from /vote, just sets winner).
 */
export async function checkWin(admin: Admin, room: RoomRow): Promise<"crew" | "imposters" | null> {
  if (room.round === 0) return null;

  const { data: roleRows } = await admin
    .from("player_roles")
    .select("player_id, role, players!inner(room_code)")
    .eq("round", room.round)
    .eq("players.room_code", room.code);

  const roles = (roleRows ?? []) as unknown as { player_id: string; role: string }[];
  if (roles.length === 0) return null;

  const { data: secretRows } = await admin
    .from("player_secrets")
    .select("player_id, is_alive")
    .in(
      "player_id",
      roles.map((r) => r.player_id)
    );
  const aliveMap = new Map<string, boolean>();
  for (const row of secretRows ?? []) {
    const r = row as { player_id: string; is_alive: boolean };
    aliveMap.set(r.player_id, r.is_alive);
  }

  let livingImposters = 0;
  let livingCrew = 0;
  for (const r of roles) {
    if (!(aliveMap.get(r.player_id) ?? true)) continue;
    if (r.role === "imposter") livingImposters++;
    else livingCrew++;
  }

  const { tasksDone, tasksTotal } = await recomputeTaskCounters(admin, room);
  if (tasksTotal > 0 && tasksDone >= tasksTotal) return "crew";
  if (livingImposters === 0) return "crew";
  if (livingImposters >= livingCrew) return "imposters";
  return null;
}

/** Conditional transition to ended — a no-op if the room is already ended. The ended
 * screen holds for ENDED_SECS, after which /tick auto-resets the room to lobby. */
export async function endGame(admin: Admin, roomCode: string, winner: "crew" | "imposters"): Promise<void> {
  await admin
    .from("rooms")
    .update({
      phase: "ended",
      winner,
      phase_ends_at: new Date(Date.now() + ENDED_SECS * 1000).toISOString(),
    })
    .eq("code", roomCode)
    .neq("phase", "ended");
}

/** rooms columns reset when a game returns to lobby — shared by /api/reset (host-triggered,
 * unconditional) and /tick's ended -> lobby auto-transition (conditional claim). Round is
 * left alone — the next start-round increments it. */
export const LOBBY_RESET_FIELDS = {
  phase: "lobby",
  phase_ends_at: null,
  tasks_done: 0,
  tasks_total: 0,
  here_count: 0,
  expected_here: 0,
  votes_cast: 0,
  last_result: null,
  winner: null,
  meeting_reason: null,
  reported_body_name: null,
  meeting_caller_name: null,
  meeting_no: 0,
  sabotage_target: null,
  sabotage_ready_at: null,
  sabotage_carry_secs: 0,
} as const;

/**
 * Non-rooms side effects of a reset to lobby: clears claims, zeroes occupancy, and resets
 * player_secrets. Reset means a NEW GAME, so has_called_meeting clears here too — the
 * emergency meeting button is once per game. Contrast with start-round, which deliberately
 * does NOT reset it between rounds of the same game.
 */
export async function resetRoomSideEffects(admin: Admin, roomCode: string): Promise<void> {
  await admin.from("task_claims").delete().eq("room_code", roomCode);
  await admin.from("task_occupancy").update({ occupied: 0 }).eq("room_code", roomCode);

  const { data: roster } = await admin.from("players").select("id").eq("room_code", roomCode);
  const rosterIds = (roster ?? []).map((p) => p.id as string);

  if (rosterIds.length > 0) {
    await admin
      .from("player_secrets")
      .update({ is_alive: true, is_here: false, reported: false })
      .in("player_id", rosterIds);

    await admin.from("players").update({ has_called_meeting: false }).in("id", rosterIds);
  }
}

/**
 * Unconditional reset to lobby, preserving roster/task list/settings — used by /api/reset
 * (host-triggered). Returns the rooms-update error, if any, so the caller can 500.
 */
export async function resetRoomToLobby(
  admin: Admin,
  roomCode: string
): Promise<{ error: { message: string } | null }> {
  const { error } = await admin.from("rooms").update(LOBBY_RESET_FIELDS).eq("code", roomCode);
  if (error) return { error };
  await resetRoomSideEffects(admin, roomCode);
  return { error: null };
}

type TallyResult = VoteResult & { ejectedId: string | null };

/**
 * Computes the vote result for the room's current (round, meeting_no). ballots is only
 * present on the returned object when anonymous_voting is false — matching PLAN.md's
 * "Vote result shape" and CLAUDE.md invariant 8 (never sent-and-hidden).
 */
export async function tallyVotes(admin: Admin, room: RoomRow): Promise<TallyResult> {
  const { data: voteRows } = await admin
    .from("votes")
    .select("voter_id, target_id")
    .eq("room_code", room.code)
    .eq("round", room.round)
    .eq("meeting_no", room.meeting_no);

  const votes = (voteRows ?? []) as { voter_id: string; target_id: string | null }[];

  const playerIds = new Set<string>();
  for (const v of votes) {
    playerIds.add(v.voter_id);
    if (v.target_id) playerIds.add(v.target_id);
  }
  const { data: playerRows } =
    playerIds.size > 0
      ? await admin.from("players").select("id, name").in("id", [...playerIds])
      : { data: [] };
  const nameMap = new Map<string, string>();
  for (const row of playerRows ?? []) {
    const p = row as { id: string; name: string };
    nameMap.set(p.id, p.name);
  }

  const targetCounts = new Map<string, number>();
  let skipCount = 0;
  for (const v of votes) {
    if (v.target_id === null) {
      skipCount++;
    } else {
      targetCounts.set(v.target_id, (targetCounts.get(v.target_id) ?? 0) + 1);
    }
  }

  const tally: VoteTally[] = [...targetCounts.entries()]
    .map(([targetId, count]) => ({ name: nameMap.get(targetId) ?? "Unknown", count }))
    .sort((a, b) => b.count - a.count);
  tally.push({ name: "Skip", count: skipCount });

  const topCount = targetCounts.size > 0 ? Math.max(...targetCounts.values()) : 0;
  const topTargets = [...targetCounts.entries()].filter(([, count]) => count === topCount);

  let ejectedId: string | null = null;
  let skipped = false;
  let tied = false;

  // Tie or skip-wins (including skip matching the top target count) => nobody ejected.
  if (topTargets.length === 0 || skipCount >= topCount) {
    skipped = true;
  } else if (topTargets.length > 1) {
    tied = true;
  } else {
    ejectedId = topTargets[0][0];
  }

  let ejectedName: string | null = null;
  let wasImposter: boolean | null = null;
  if (ejectedId) {
    ejectedName = nameMap.get(ejectedId) ?? null;
    const { data: roleRow } = await admin
      .from("player_roles")
      .select("role")
      .eq("player_id", ejectedId)
      .eq("round", room.round)
      .maybeSingle();
    wasImposter = roleRow ? roleRow.role === "imposter" : null;
  }

  const result: TallyResult = { ejectedId, ejectedName, wasImposter, skipped, tied, tally };

  if (!room.anonymous_voting) {
    result.ballots = votes.map((v) => ({
      voterName: nameMap.get(v.voter_id) ?? "Unknown",
      targetName: v.target_id ? nameMap.get(v.target_id) ?? "Unknown" : "Skip",
    }));
  }

  return result;
}

/**
 * Idempotent voting -> results transition. Claims the transition with a single
 * conditional update (round + meeting_no scoped, so a stale caller from a prior
 * meeting can never double-apply this) and only the caller that claims it applies
 * the ejection + win check.
 */
export async function advanceFromVoting(admin: Admin, room: RoomRow): Promise<void> {
  const tallyResult = await tallyVotes(admin, room);
  const { ejectedId, ...publicResult } = tallyResult;

  const { data: claimed } = await admin
    .from("rooms")
    .update({
      phase: "results",
      last_result: publicResult,
      phase_ends_at: new Date(Date.now() + room.results_secs * 1000).toISOString(),
    })
    .eq("code", room.code)
    .eq("phase", "voting")
    .eq("round", room.round)
    .eq("meeting_no", room.meeting_no)
    .select("code");

  if (!claimed || claimed.length === 0) {
    // Someone else's call already advanced this exact (round, meeting_no) — done.
    return;
  }

  if (ejectedId) {
    await admin.from("player_secrets").update({ is_alive: false }).eq("player_id", ejectedId);
  }

  const winner = await checkWin(admin, room);
  if (winner) {
    // Leave phase='results' — /tick moves results -> ended after results_secs so
    // everyone sees the tally before the end screen.
    await admin.from("rooms").update({ winner }).eq("code", room.code);
  }
}
