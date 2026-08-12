import { errorJson, json, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  advanceFromVoting,
  checkWin,
  clearExpiredClaims,
  ENDED_SECS,
  endGame,
  LOBBY_RESET_FIELDS,
  recomputeTaskCounters,
  resetRoomSideEffects,
} from "@/lib/game";

export const runtime = "nodejs";

// Called by every client every 2s. Every transition below is a single conditional
// UPDATE ... WHERE phase = $expected AND phase_ends_at < now(), so twelve simultaneous
// callers produce exactly one transition.
export async function POST(req: Request) {
  const resolved = await resolvePlayer(req);
  if (!resolved.ok) return resolved.response;
  const { player } = resolved;
  const code = player.room_code;

  const admin = supabaseAdmin();
  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const endsAtMs: number | null = room.phase_ends_at ? new Date(room.phase_ends_at).getTime() : null;
  const timerExpired = endsAtMs !== null && endsAtMs < nowMs;

  let phase: string = room.phase;

  if (phase === "playing") {
    await clearExpiredClaims(admin, code);
    const { tasksDone, tasksTotal } = await recomputeTaskCounters(admin, room);
    if (tasksDone !== room.tasks_done || tasksTotal !== room.tasks_total) {
      await admin.from("rooms").update({ tasks_done: tasksDone, tasks_total: tasksTotal }).eq("code", code);
    }
    const winner = await checkWin(admin, room);
    if (winner) {
      await endGame(admin, code, winner);
      phase = "ended";
    }
  } else if (phase === "gathering" && timerExpired) {
    const { data: claimed } = await admin
      .from("rooms")
      .update({ phase: "meeting", phase_ends_at: new Date(nowMs + room.meeting_secs * 1000).toISOString() })
      .eq("code", code)
      .eq("phase", "gathering")
      .lt("phase_ends_at", nowIso)
      .select("code");
    if (claimed && claimed.length > 0) phase = "meeting";
  } else if (phase === "sabotage" && timerExpired) {
    const { data: claimed } = await admin
      .from("rooms")
      .update({ phase: "playing", phase_ends_at: null, here_count: 0, expected_here: 0 })
      .eq("code", code)
      .eq("phase", "sabotage")
      .lt("phase_ends_at", nowIso)
      .select("code");
    if (claimed && claimed.length > 0) {
      // Everyone living who never checked in dies to the sabotage — crew and imposters
      // alike. reported=true: these are rule deaths, not bodies lying in the house, so
      // they must never appear in /api/bodies.
      const { data: roster } = await admin.from("players").select("id").eq("room_code", code);
      const rosterIds = (roster ?? []).map((p) => p.id as string);
      if (rosterIds.length > 0) {
        await admin
          .from("player_secrets")
          .update({ is_alive: false, reported: true })
          .in("player_id", rosterIds)
          .eq("is_alive", true)
          .eq("is_here", false);
      }
      const winner = await checkWin(admin, room);
      if (winner) {
        await endGame(admin, code, winner);
        phase = "ended";
      } else {
        phase = "playing";
      }
    }
  } else if (phase === "meeting" && timerExpired) {
    const { data: claimed } = await admin
      .from("rooms")
      .update({
        phase: "voting",
        phase_ends_at: new Date(nowMs + room.voting_secs * 1000).toISOString(),
        votes_cast: 0,
      })
      .eq("code", code)
      .eq("phase", "meeting")
      .lt("phase_ends_at", nowIso)
      .select("code");
    if (claimed && claimed.length > 0) phase = "voting";
  } else if (phase === "voting" && timerExpired) {
    // Timeout path — players who never voted just don't count. The immediate
    // "everyone voted" path is handled inline in /api/vote, not here.
    await advanceFromVoting(admin, room);
    phase = "results";
  } else if (phase === "results" && timerExpired) {
    if (room.winner) {
      const { data: claimed } = await admin
        .from("rooms")
        .update({
          phase: "ended",
          phase_ends_at: new Date(nowMs + ENDED_SECS * 1000).toISOString(),
        })
        .eq("code", code)
        .eq("phase", "results")
        .lt("phase_ends_at", nowIso)
        .select("code");
      if (claimed && claimed.length > 0) phase = "ended";
    } else {
      const { data: claimed } = await admin
        .from("rooms")
        .update({
          phase: "playing",
          phase_ends_at: null,
          meeting_reason: null,
          reported_body_name: null,
          meeting_caller_name: null,
          here_count: 0,
          expected_here: 0,
          votes_cast: 0,
        })
        .eq("code", code)
        .eq("phase", "results")
        .lt("phase_ends_at", nowIso)
        .select("code");
      if (claimed && claimed.length > 0) phase = "playing";
    }
  } else if (phase === "ended" && timerExpired) {
    // Rooms sitting in "ended" with phase_ends_at null (pre-auto-reset rooms, or an
    // edge case) never get here — timerExpired is false without a deadline, same as
    // every other phase. Claim the transition first; only the claimer runs the
    // roster/settings-preserving side effects (see resetRoomToLobby for the
    // host-triggered, unconditional counterpart).
    const { data: claimed } = await admin
      .from("rooms")
      .update(LOBBY_RESET_FIELDS)
      .eq("code", code)
      .eq("phase", "ended")
      .lt("phase_ends_at", nowIso)
      .select("code");
    if (claimed && claimed.length > 0) {
      await resetRoomSideEffects(admin, code);
      phase = "lobby";
    }
  }

  return json({ ok: true, phase });
}
