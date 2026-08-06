import { z } from "zod";
import { errorJson, json, parseBody } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().trim().min(1, "Room code is required"),
  name: z.string().trim().min(1, "Name is required").max(40, "Name is too long"),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const code = parsed.data.code.toUpperCase();
  const { name } = parsed.data;

  const admin = supabaseAdmin();

  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("code, phase")
    .eq("code", code)
    .maybeSingle();
  if (roomError) {
    return errorJson("Failed to look up room", 500);
  }
  if (!room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "lobby") {
    return errorJson("Round already started", 409);
  }

  const { data: player, error: playerError } = await admin
    .from("players")
    .insert({ room_code: code, name })
    .select("id")
    .single();
  if (playerError) {
    if (playerError.code === "23505") {
      return errorJson("That name is already taken in this room", 409);
    }
    return errorJson("Failed to join room", 500);
  }

  const token = crypto.randomUUID();
  const { error: secretsError } = await admin
    .from("player_secrets")
    .insert({ player_id: player.id, token });
  if (secretsError) {
    await admin.from("players").delete().eq("id", player.id);
    return errorJson("Failed to join room", 500);
  }

  return json({ ok: true, token, playerId: player.id });
}
