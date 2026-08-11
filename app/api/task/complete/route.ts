import { randomInt } from "node:crypto";
import { z } from "zod";
import { errorJson, json, parseBody, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";
import { syncTaskOccupancy } from "@/lib/game";

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
  const { player } = resolved;

  const admin = supabaseAdmin();
  const code = player.room_code;

  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("round, task_secs")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }

  const { data: claim } = await admin
    .from("task_claims")
    .select("started_at")
    .eq("room_code", code)
    .eq("task_id", taskId)
    .eq("player_id", player.id)
    .maybeSingle();
  if (!claim) {
    return errorJson("No active claim on that task", 409);
  }

  const heldMs = Date.now() - new Date(claim.started_at).getTime();
  if (heldMs < (room.task_secs - 1) * 1000) {
    return errorJson("Hold the station a little longer", 409);
  }

  // Reveal delay: the shared task bar lags 1-5s behind the real completion instant
  // so it can't be used to time-stamp who was where. Crypto-quality, never Math.random.
  const revealDelaySecs = randomInt(1, 6);
  const now = new Date();
  const revealAt = new Date(now.getTime() + revealDelaySecs * 1000);

  const { data: updated, error: completeError } = await admin
    .from("player_tasks")
    .update({ completed_at: now.toISOString(), reveal_at: revealAt.toISOString() })
    .eq("player_id", player.id)
    .eq("task_id", taskId)
    .eq("round", room.round)
    .select("task_id");
  if (completeError) {
    return errorJson("Failed to complete task", 500);
  }
  if (!updated || updated.length === 0) {
    return errorJson("That task isn't assigned to you", 403);
  }

  // The station frees immediately — only the shared bar is delayed, not gameplay.
  await admin
    .from("task_claims")
    .delete()
    .eq("room_code", code)
    .eq("task_id", taskId)
    .eq("player_id", player.id);
  await syncTaskOccupancy(admin, code, taskId);

  return json({ ok: true });
}
