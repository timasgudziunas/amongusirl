import { z } from "zod";
import { json, parseBody, resolvePlayer } from "@/lib/api";
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

  // Ok even if no claim existed — abandon is idempotent.
  await admin
    .from("task_claims")
    .delete()
    .eq("room_code", code)
    .eq("task_id", taskId)
    .eq("player_id", player.id);
  await syncTaskOccupancy(admin, code, taskId);

  return json({ ok: true });
}
