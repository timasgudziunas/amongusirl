import { z } from "zod";
import { errorJson, json, parseBody, resolveHost } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const taskSchema = z.object({
  name: z.string().trim().min(1, "Task name is required").max(80, "Task name is too long"),
  location: z.string().trim().min(1, "Task location is required").max(80, "Location is too long"),
  description: z.string().trim().max(280, "Description is too long").optional(),
});

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
  tasks: z.array(taskSchema),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;

  const resolved = await resolveHost(req, parsed.data.pin);
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
    return errorJson("Tasks can only be edited in the lobby", 409);
  }

  const { error: deleteError } = await admin
    .from("tasks")
    .delete()
    .eq("room_code", player.room_code);
  if (deleteError) {
    return errorJson("Failed to update tasks", 500);
  }

  const rows = parsed.data.tasks.map((task, index) => ({
    room_code: player.room_code,
    order_index: index,
    name: task.name,
    location: task.location,
    description: task.description && task.description.length > 0 ? task.description : null,
  }));

  if (rows.length > 0) {
    const { error: insertError } = await admin.from("tasks").insert(rows);
    if (insertError) {
      return errorJson("Failed to update tasks", 500);
    }
  }

  return json({ ok: true });
}
