import { errorJson, json, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";
import { checkWin, endGame, recomputeTaskCounters } from "@/lib/game";

export const runtime = "nodejs";

// Victim self-report ("I was killed"). Reveals nothing back — the response is
// {ok:true} regardless of what happened, per CLAUDE.md invariant 5.
export async function POST(req: Request) {
  const resolved = await resolvePlayer(req);
  if (!resolved.ok) return resolved.response;
  const { player, secrets } = resolved;
  if (!secrets.is_alive) {
    return errorJson("Already dead", 409);
  }

  const admin = supabaseAdmin();
  const code = player.room_code;

  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "playing" && room.phase !== "gathering") {
    return errorJson("Can't self-report a death right now", 409);
  }

  const { error: deathError } = await admin
    .from("player_secrets")
    .update({ is_alive: false })
    .eq("player_id", player.id);
  if (deathError) {
    return errorJson("Failed to record death", 500);
  }

  if (room.phase === "gathering") {
    const { data: roster } = await admin.from("players").select("id").eq("room_code", code);
    const rosterIds = (roster ?? []).map((p) => p.id as string);
    const idFilter = rosterIds.length > 0 ? rosterIds : [""];
    const { data: secretRows } = await admin
      .from("player_secrets")
      .select("player_id, is_alive, is_here")
      .in("player_id", idFilter);
    const hereCount = (secretRows ?? []).filter((s) => s.is_alive && s.is_here).length;
    const expectedHere = Math.max(0, room.expected_here - 1);

    await admin.from("rooms").update({ here_count: hereCount, expected_here: expectedHere }).eq("code", code);

    if (hereCount >= expectedHere) {
      await admin
        .from("rooms")
        .update({
          phase: "meeting",
          phase_ends_at: new Date(Date.now() + room.meeting_secs * 1000).toISOString(),
        })
        .eq("code", code)
        .eq("phase", "gathering");
    }
  } else {
    // room.phase === "playing" — drops the victim's incomplete tasks from the total
    // immediately (unless ghost_tasks), same recompute /tick does.
    const { tasksDone, tasksTotal } = await recomputeTaskCounters(admin, room);
    if (tasksDone !== room.tasks_done || tasksTotal !== room.tasks_total) {
      await admin.from("rooms").update({ tasks_done: tasksDone, tasks_total: tasksTotal }).eq("code", code);
    }
  }

  const winner = await checkWin(admin, room);
  if (winner) {
    await endGame(admin, code, winner);
  }

  return json({ ok: true });
}
