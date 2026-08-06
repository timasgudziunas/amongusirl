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
      },
      validation,
    });
  }

  if (room.phase === "playing") {
    const { data: players } = await admin
      .from("players")
      .select("id, name")
      .eq("room_code", code)
      .order("joined_at", { ascending: true });

    const roster = (players ?? []).map((p) => ({ playerId: p.id, name: p.name }));

    const payload: Record<string, unknown> = {
      ok: true,
      phase: room.phase,
      round: room.round,
      roster,
    };
    if (room.show_task_bar) {
      payload.tasksDone = room.tasks_done;
      payload.tasksTotal = room.tasks_total;
    }
    return json(payload);
  }

  // Later phases (gathering/meeting/voting/results/ended) extend this.
  return json({ ok: true, phase: room.phase });
}
