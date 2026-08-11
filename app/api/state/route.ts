import { errorJson, json, resolvePlayer } from "@/lib/api";
import { computeStartValidation } from "@/lib/validation";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const codeParam = url.searchParams.get("code");
  if (!codeParam) {
    return errorJson("Missing code query param", 400);
  }
  const code = codeParam.toUpperCase();

  const resolved = await resolvePlayer(req);
  if (!resolved.ok) return resolved.response;
  const { player } = resolved;

  if (player.room_code !== code) {
    return errorJson("You are not a member of this room", 403);
  }

  const admin = supabaseAdmin();
  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }

  if (room.phase === "lobby") {
    const [{ data: players }, { data: tasks }] = await Promise.all([
      admin
        .from("players")
        .select("id, name, is_host, has_called_meeting")
        .eq("room_code", code)
        .order("joined_at", { ascending: true }),
      admin
        .from("tasks")
        .select("id, order_index, name, location, description")
        .eq("room_code", code)
        .order("order_index", { ascending: true }),
    ]);

    const roster = (players ?? []).map((p) => ({
      playerId: p.id,
      name: p.name,
      isHost: p.is_host,
      hasCalledMeeting: p.has_called_meeting,
    }));
    const taskList = (tasks ?? []).map((t) => ({
      taskId: t.id,
      orderIndex: t.order_index,
      name: t.name,
      location: t.location,
      description: t.description,
    }));

    const validation = computeStartValidation(
      roster.length,
      taskList.length,
      room.imposter_count,
      room.tasks_per_player
    );

    return json({
      ok: true,
      phase: room.phase,
      roster,
      tasks: taskList,
      isHost: player.is_host,
      settings: {
        imposterCount: room.imposter_count,
        taskCapacity: room.task_capacity,
        tasksPerPlayer: room.tasks_per_player,
        anonymousVoting: room.anonymous_voting,
        showTaskBar: room.show_task_bar,
        imposterTasksCount: room.imposter_tasks_count,
        ghostTasks: room.ghost_tasks,
        gatheringSecs: room.gathering_secs,
        meetingSecs: room.meeting_secs,
        votingSecs: room.voting_secs,
        resultsSecs: room.results_secs,
        taskSecs: room.task_secs,
        doorSecs: room.door_secs,
      },
      validation,
    });
  }

  if (room.phase === "playing") {
    const [{ data: players }, { data: occupancyRows }] = await Promise.all([
      admin
        .from("players")
        .select("id, name")
        .eq("room_code", code)
        .order("joined_at", { ascending: true }),
      admin.from("task_occupancy").select("task_id, occupied").eq("room_code", code),
    ]);

    const roster = (players ?? []).map((p) => ({ playerId: p.id, name: p.name }));
    const occupancy = (occupancyRows ?? []).map((o) => ({ taskId: o.task_id, occupied: o.occupied }));

    const payload: Record<string, unknown> = {
      ok: true,
      phase: room.phase,
      round: room.round,
      roster,
      occupancy,
      taskCapacity: room.task_capacity,
      hasCalledMeeting: player.has_called_meeting,
      doorSecs: room.door_secs,
    };
    if (room.show_task_bar) {
      payload.tasksDone = room.tasks_done;
      payload.tasksTotal = room.tasks_total;
    }
    return json(payload);
  }

  if (room.phase === "gathering") {
    // Still no alive/dead roster — that arrives when the discussion starts.
    return json({
      ok: true,
      phase: room.phase,
      hereCount: room.here_count,
      expectedHere: room.expected_here,
      phaseEndsAt: room.phase_ends_at,
      meetingReason: room.meeting_reason,
      reportedBodyName: room.reported_body_name,
      meetingCallerName: room.meeting_caller_name,
    });
  }

  if (room.phase === "meeting") {
    // The one phase where death is shown at all — full roster, alive and dead.
    const { data: players } = await admin
      .from("players")
      .select("id, name")
      .eq("room_code", code)
      .order("joined_at", { ascending: true });
    const ids = (players ?? []).map((p) => p.id as string);
    const idFilter = ids.length > 0 ? ids : [""];
    const { data: secretRows } = await admin
      .from("player_secrets")
      .select("player_id, is_alive")
      .in("player_id", idFilter);
    const aliveMap = new Map((secretRows ?? []).map((s) => [s.player_id as string, s.is_alive as boolean]));

    const roster = (players ?? []).map((p) => ({
      playerId: p.id,
      name: p.name,
      isAlive: aliveMap.get(p.id as string) ?? true,
    }));

    return json({
      ok: true,
      phase: room.phase,
      roster,
      phaseEndsAt: room.phase_ends_at,
      meetingReason: room.meeting_reason,
      reportedBodyName: room.reported_body_name,
      meetingCallerName: room.meeting_caller_name,
    });
  }

  if (room.phase === "voting") {
    const { data: players } = await admin
      .from("players")
      .select("id, name")
      .eq("room_code", code)
      .order("joined_at", { ascending: true });
    const ids = (players ?? []).map((p) => p.id as string);
    const idFilter = ids.length > 0 ? ids : [""];
    const { data: secretRows } = await admin
      .from("player_secrets")
      .select("player_id, is_alive")
      .in("player_id", idFilter);
    const aliveIds = new Set((secretRows ?? []).filter((s) => s.is_alive).map((s) => s.player_id as string));
    const livingRoster = (players ?? [])
      .filter((p) => aliveIds.has(p.id as string))
      .map((p) => ({ playerId: p.id, name: p.name }));

    const { data: myVote } = await admin
      .from("votes")
      .select("voter_id")
      .eq("room_code", code)
      .eq("round", room.round)
      .eq("meeting_no", room.meeting_no)
      .eq("voter_id", player.id)
      .maybeSingle();

    return json({
      ok: true,
      phase: room.phase,
      roster: livingRoster,
      votesCast: room.votes_cast,
      livingCount: livingRoster.length,
      phaseEndsAt: room.phase_ends_at,
      myVoteCast: myVote !== null,
    });
  }

  if (room.phase === "results") {
    // Defense in depth: tallyVotes already omits ballots when anonymous, but strip
    // again here in case last_result was ever written some other way.
    const lastResult = room.last_result ? { ...(room.last_result as Record<string, unknown>) } : null;
    if (lastResult && room.anonymous_voting) {
      delete lastResult.ballots;
    }
    return json({
      ok: true,
      phase: room.phase,
      lastResult,
      phaseEndsAt: room.phase_ends_at,
      winnerPending: room.winner,
    });
  }

  if (room.phase === "ended") {
    const { data: players } = await admin
      .from("players")
      .select("id, name")
      .eq("room_code", code)
      .order("joined_at", { ascending: true });
    const ids = (players ?? []).map((p) => p.id as string);
    const idFilter = ids.length > 0 ? ids : [""];

    const [{ data: roleRows }, { data: secretRows }] = await Promise.all([
      admin.from("player_roles").select("player_id, role").eq("round", room.round).in("player_id", idFilter),
      admin.from("player_secrets").select("player_id, is_alive").in("player_id", idFilter),
    ]);
    const roleMap = new Map((roleRows ?? []).map((r) => [r.player_id as string, r.role as string]));
    const aliveMap = new Map((secretRows ?? []).map((s) => [s.player_id as string, s.is_alive as boolean]));

    const roster = (players ?? []).map((p) => ({
      playerId: p.id,
      name: p.name,
      role: roleMap.get(p.id as string) ?? null,
      isAlive: aliveMap.get(p.id as string) ?? true,
    }));

    return json({
      ok: true,
      phase: room.phase,
      winner: room.winner,
      roster,
    });
  }

  return json({ ok: true, phase: room.phase });
}
