import { z } from "zod";
import { errorJson, json, parseBody, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";
import { clearExpiredClaims } from "@/lib/game";

export const runtime = "nodejs";

const bodySchema = z.object({
  taskId: z.string().min(1, "taskId is required"),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { taskId } = parsed.data;

  const resolved = await resolvePlayer(req);
  if (!resolved.ok) return resolved.response;
  const { player, secrets } = resolved;
  if (!secrets.is_alive) {
    return errorJson("You are dead", 403);
  }

  const admin = supabaseAdmin();
  const code = player.room_code;

  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("phase, round, task_capacity, task_secs")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "playing") {
    return errorJson("Tasks can only be claimed while playing", 409);
  }

  await clearExpiredClaims(admin, code);

  const { data: assignment } = await admin
    .from("player_tasks")
    .select("completed_at")
    .eq("player_id", player.id)
    .eq("task_id", taskId)
    .eq("round", room.round)
    .maybeSingle();
  if (!assignment) {
    return errorJson("That task isn't assigned to you", 403);
  }
  if (assignment.completed_at !== null) {
    return errorJson("You've already completed that task", 409);
  }

  const { data: existingClaim } = await admin
    .from("task_claims")
    .select("player_id")
    .eq("room_code", code)
    .eq("task_id", taskId)
    .eq("player_id", player.id)
    .maybeSingle();
  if (existingClaim) {
    return errorJson("You already hold this station", 409);
  }

  const { count } = await admin
    .from("task_claims")
    .select("*", { count: "exact", head: true })
    .eq("room_code", code)
    .eq("task_id", taskId);
  const occupied = count ?? 0;
  if (occupied >= room.task_capacity) {
    return errorJson("Station full", 409);
  }

  // Supabase-js has no transactions. Two DIFFERENT players racing for the last slot
  // in the same window can both pass the count check above before either insert
  // lands — that race is acceptable for a party game. The claim's PK (room_code,
  // task_id, player_id) only protects the SAME player double-tapping, which is safe.
  const { error: insertError } = await admin.from("task_claims").insert({
    room_code: code,
    task_id: taskId,
    player_id: player.id,
    expires_at: new Date(Date.now() + (room.task_secs + 10) * 1000).toISOString(),
  });
  if (insertError && insertError.code !== "23505") {
    return errorJson("Failed to claim station", 500);
  }

  await admin
    .from("task_occupancy")
    .update({ occupied: occupied + 1 })
    .eq("room_code", code)
    .eq("task_id", taskId);

  return json({ ok: true, secondsRequired: room.task_secs });
}
