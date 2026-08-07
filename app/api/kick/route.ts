import { z } from "zod";
import { errorJson, json, parseBody, resolveHost } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
  playerId: z.string().min(1, "playerId is required"),
});

// Host removes a stale roster entry (someone who disconnected and rejoined under a
// new name). Lobby only: joins are lobby-only too, so mid-game there is nothing a
// kick could fix that a reset wouldn't, and deleting a mid-round player would corrupt
// role counts and tasks_total.
export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { playerId } = parsed.data;

  const resolved = await resolveHost(req, parsed.data.pin);
  if (!resolved.ok) return resolved.response;
  const { player } = resolved;

  if (playerId === player.id) {
    return errorJson("You can't remove yourself", 400);
  }

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
    return errorJson("Players can only be removed in the lobby", 409);
  }

  // Scoped to this room so a host can never delete a player elsewhere. Everything
  // player-owned (secrets, roles, tasks, claims, votes) cascades off players(id).
  const { data: deleted, error: deleteError } = await admin
    .from("players")
    .delete()
    .eq("id", playerId)
    .eq("room_code", player.room_code)
    .select("id");
  if (deleteError) {
    return errorJson("Failed to remove player", 500);
  }
  if (!deleted || deleted.length === 0) {
    return errorJson("That player is not in this room", 404);
  }

  return json({ ok: true });
}
