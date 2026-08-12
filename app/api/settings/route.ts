import { z } from "zod";
import { errorJson, json, parseBody, resolveHost } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const secs = z.number().int().min(5, "Must be at least 5 seconds").max(600, "Must be at most 600 seconds");

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
  imposterCount: z.number().int().min(1, "Need at least 1 imposter").optional(),
  taskCapacity: z.number().int().min(1, "Task capacity must be at least 1").optional(),
  tasksPerPlayer: z.number().int().min(1, "Tasks per player must be at least 1").nullable().optional(),
  anonymousVoting: z.boolean().optional(),
  showTaskBar: z.boolean().optional(),
  imposterTasksCount: z.boolean().optional(),
  ghostTasks: z.boolean().optional(),
  gatheringSecs: secs.optional(),
  meetingSecs: secs.optional(),
  votingSecs: secs.optional(),
  resultsSecs: secs.optional(),
  taskSecs: z.number().int().min(5, "Task duration must be at least 5 seconds").max(120, "Task duration must be at most 120 seconds").optional(),
  doorSecs: z.number().int().min(2, "Door screen must be at least 2 seconds").max(30, "Door screen must be at most 30 seconds").optional(),
  sabotageSecs: z.number().int().min(10, "Sabotage timer must be at least 10 seconds").max(300, "Sabotage timer must be at most 300 seconds").optional(),
  sabotageCooldownSecs: z.number().int().min(0, "Sabotage cooldown can't be negative").max(600, "Sabotage cooldown must be at most 600 seconds").optional(),
  sabotageRooms: z.array(z.string().trim().min(1, "Room name can't be empty").max(80, "Room name is too long")).max(30, "At most 30 sabotage rooms").optional(),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const data = parsed.data;

  const resolved = await resolveHost(req, data.pin);
  if (!resolved.ok) return resolved.response;
  const { player } = resolved;

  const admin = supabaseAdmin();

  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("phase")
    .eq("code", player.room_code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "lobby") {
    return errorJson("Settings can only be changed in the lobby", 409);
  }

  const updates: Record<string, unknown> = {};
  if (data.imposterCount !== undefined) updates.imposter_count = data.imposterCount;
  if (data.taskCapacity !== undefined) updates.task_capacity = data.taskCapacity;
  if (data.tasksPerPlayer !== undefined) updates.tasks_per_player = data.tasksPerPlayer;
  if (data.anonymousVoting !== undefined) updates.anonymous_voting = data.anonymousVoting;
  if (data.showTaskBar !== undefined) updates.show_task_bar = data.showTaskBar;
  if (data.imposterTasksCount !== undefined) updates.imposter_tasks_count = data.imposterTasksCount;
  if (data.ghostTasks !== undefined) updates.ghost_tasks = data.ghostTasks;
  if (data.gatheringSecs !== undefined) updates.gathering_secs = data.gatheringSecs;
  if (data.meetingSecs !== undefined) updates.meeting_secs = data.meetingSecs;
  if (data.votingSecs !== undefined) updates.voting_secs = data.votingSecs;
  if (data.resultsSecs !== undefined) updates.results_secs = data.resultsSecs;
  if (data.taskSecs !== undefined) updates.task_secs = data.taskSecs;
  if (data.doorSecs !== undefined) updates.door_secs = data.doorSecs;
  if (data.sabotageSecs !== undefined) updates.sabotage_secs = data.sabotageSecs;
  if (data.sabotageCooldownSecs !== undefined) updates.sabotage_cooldown_secs = data.sabotageCooldownSecs;
  if (data.sabotageRooms !== undefined) updates.sabotage_rooms = data.sabotageRooms;

  if (Object.keys(updates).length === 0) {
    return json({ ok: true });
  }

  const { error: updateError } = await admin
    .from("rooms")
    .update(updates)
    .eq("code", player.room_code);
  if (updateError) {
    return errorJson("Failed to update settings", 500);
  }

  return json({ ok: true });
}
