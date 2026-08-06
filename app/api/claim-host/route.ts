import { z } from "zod";
import { errorJson, json, parseBody, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const data = parsed.data;

  const resolved = await resolvePlayer(req);
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
    return errorJson("Host can only be claimed in the lobby", 409);
  }

  const { data: secrets, error: secretsError } = await admin
    .from("room_secrets")
    .select("host_pin")
    .eq("room_code", player.room_code)
    .maybeSingle();
  if (secretsError || !secrets || secrets.host_pin !== data.pin) {
    return errorJson("Invalid host PIN", 403);
  }

  const { error: demoteError } = await admin
    .from("players")
    .update({ is_host: false })
    .eq("room_code", player.room_code)
    .eq("is_host", true);
  if (demoteError) {
    return errorJson("Failed to claim host", 500);
  }

  const { error: promoteError } = await admin
    .from("players")
    .update({ is_host: true })
    .eq("id", player.id);
  if (promoteError) {
    return errorJson("Failed to claim host", 500);
  }

  return json({ ok: true });
}
