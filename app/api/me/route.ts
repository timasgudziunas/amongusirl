import { errorJson, json, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const resolved = await resolvePlayer(req);
  if (!resolved.ok) return resolved.response;
  const { player, secrets } = resolved;

  const admin = supabaseAdmin();
  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("round")
    .eq("code", player.room_code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }

  // No round has been played yet — nothing assigned.
  if (room.round === 0) {
    return json({
      ok: true,
      role: null,
      isAlive: secrets.is_alive,
      isHere: secrets.is_here,
      myTasks: [],
    });
  }

  const { data: roleRow } = await admin
    .from("player_roles")
    .select("role")
    .eq("player_id", player.id)
    .eq("round", room.round)
    .maybeSingle();
  const role = (roleRow?.role as "crew" | "imposter" | undefined) ?? null;

  const payload: Record<string, unknown> = {
    ok: true,
    role,
    isAlive: secrets.is_alive,
    isHere: secrets.is_here,
  };

  if (role === "imposter") {
    // player_roles has no room column — the round/role filter alone would match
    // imposters in every room on the same round number. The inner join on players
    // scoped to this room is load-bearing, not cosmetic.
    const { data: partners } = await admin
      .from("player_roles")
      .select("players!inner(name, room_code)")
      .eq("round", room.round)
      .eq("role", "imposter")
      .eq("players.room_code", player.room_code)
      .neq("player_id", player.id);
    payload.partnerNames = (partners ?? [])
      .map((row) => (row as unknown as { players: { name: string } | null }).players?.name)
      .filter((name): name is string => Boolean(name));
  }

  const { data: myTaskRows } = await admin
    .from("player_tasks")
    .select("task_id, completed_at, tasks(name, location, description)")
    .eq("player_id", player.id)
    .eq("round", room.round);

  payload.myTasks = (myTaskRows ?? []).map((row) => {
    const task = (row as unknown as {
      task_id: string;
      completed_at: string | null;
      tasks: { name: string; location: string; description: string | null } | null;
    });
    return {
      taskId: task.task_id,
      name: task.tasks?.name ?? "",
      location: task.tasks?.location ?? "",
      description: task.tasks?.description ?? null,
      done: task.completed_at !== null,
    };
  });

  return json(payload);
}
