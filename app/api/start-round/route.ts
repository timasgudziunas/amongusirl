import { randomInt } from "node:crypto";
import { z } from "zod";
import { errorJson, json, parseBody, resolveHost } from "@/lib/api";
import { computeStartValidation } from "@/lib/validation";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
});

// Crypto-quality Fisher-Yates. Roles are the game's core secret — never Math.random.
function shuffle<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sample<T>(items: T[], count: number): T[] {
  return shuffle(items).slice(0, count);
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;

  const resolved = await resolveHost(req, parsed.data.pin);
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
  if (room.phase !== "lobby") {
    return errorJson("Round already started", 409);
  }

  const [{ data: rosterRows, error: rosterError }, { data: taskRows, error: taskError }] =
    await Promise.all([
      admin.from("players").select("id, name").eq("room_code", code),
      admin.from("tasks").select("id").eq("room_code", code).order("order_index"),
    ]);
  if (rosterError || taskError) {
    return errorJson("Failed to load room state", 500);
  }

  const roster = (rosterRows ?? []) as { id: string; name: string }[];
  const playerIds = roster.map((p) => p.id);
  const taskIds = (taskRows ?? []).map((t) => t.id as string);

  const validation = computeStartValidation(
    playerIds.length,
    taskIds.length,
    room.imposter_count,
    room.tasks_per_player
  );
  if (!validation.canStart) {
    return errorJson(validation.errors.join(" "), 409);
  }

  const newRound = room.round + 1;

  // Reset per-round secret state. has_called_meeting is NOT touched here — it's
  // once per game and lives on players, not player_secrets.
  const { error: resetError } = await admin
    .from("player_secrets")
    .update({ is_alive: true, is_here: false, reported: false })
    .in("player_id", playerIds);
  if (resetError) {
    return errorJson("Failed to reset player state", 500);
  }

  // Roles.
  const seedNames = new Set(["timas", "sarayu"]);
  const seeded = roster.filter((p) => seedNames.has(p.name.trim().toLowerCase())).map((p) => p.id);
  const seededSet = new Set(seeded.slice(0, room.imposter_count));
  const remainder = shuffle(playerIds.filter((id) => !seededSet.has(id)));
  const imposterIds = new Set([
    ...seededSet,
    ...remainder.slice(0, Math.max(0, room.imposter_count - seededSet.size)),
  ]);
  const roleRows = playerIds.map((id) => ({
    player_id: id,
    round: newRound,
    role: imposterIds.has(id) ? "imposter" : "crew",
  }));
  const { error: rolesError } = await admin.from("player_roles").insert(roleRows);
  if (rolesError) {
    return errorJson("Failed to assign roles", 500);
  }

  // Task assignment: independent random sample per player (or everything, if
  // tasks_per_player is null). Imposters get assignments too.
  const tasksPerPlayer = room.tasks_per_player as number | null;
  const playerTaskRows: { player_id: string; task_id: string; round: number }[] = [];
  for (const id of playerIds) {
    const assigned = tasksPerPlayer === null ? taskIds : sample(taskIds, tasksPerPlayer);
    for (const taskId of assigned) {
      playerTaskRows.push({ player_id: id, task_id: taskId, round: newRound });
    }
  }
  if (playerTaskRows.length > 0) {
    const { error: playerTasksError } = await admin.from("player_tasks").insert(playerTaskRows);
    if (playerTasksError) {
      return errorJson("Failed to assign tasks", 500);
    }
  }

  // Seed occupancy at 0 for every task.
  if (taskIds.length > 0) {
    const occupancyRows = taskIds.map((taskId) => ({ room_code: code, task_id: taskId, occupied: 0 }));
    const { error: occupancyError } = await admin
      .from("task_occupancy")
      .upsert(occupancyRows, { onConflict: "room_code,task_id" });
    if (occupancyError) {
      return errorJson("Failed to seed task occupancy", 500);
    }
  }

  // tasks_total: assigned-task count across players who count toward the bar
  // (crewmates only, unless imposter_tasks_count).
  const countingIds = room.imposter_tasks_count
    ? new Set(playerIds)
    : new Set(playerIds.filter((id) => !imposterIds.has(id)));
  const tasksTotal = playerTaskRows.reduce(
    (total, row) => total + (countingIds.has(row.player_id) ? 1 : 0),
    0
  );

  const { error: updateError } = await admin
    .from("rooms")
    .update({
      phase: "playing",
      round: newRound,
      meeting_no: 0,
      tasks_done: 0,
      tasks_total: tasksTotal,
      phase_ends_at: null,
      winner: null,
      last_result: null,
      meeting_reason: null,
      reported_body_name: null,
      here_count: 0,
      expected_here: 0,
      votes_cast: 0,
    })
    .eq("code", code);
  if (updateError) {
    return errorJson("Failed to start round", 500);
  }

  return json({ ok: true });
}
