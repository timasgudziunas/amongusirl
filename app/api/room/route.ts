import { z } from "zod";
import { errorJson, json, parseBody } from "@/lib/api";
import { generateRoomCode } from "@/lib/room-code";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  hostName: z.string().trim().min(1, "Name is required").max(40, "Name is too long"),
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
});

const MAX_CODE_ATTEMPTS = 20;

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { hostName, pin } = parsed.data;

  const admin = supabaseAdmin();

  let code: string | null = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const candidate = generateRoomCode();
    const { error } = await admin.from("rooms").insert({ code: candidate, phase: "lobby" });
    if (!error) {
      code = candidate;
      break;
    }
    if (error.code !== "23505") {
      return errorJson("Failed to create room", 500);
    }
    // 23505 (unique violation) on the code -> collision, retry with a new code.
  }
  if (!code) {
    return errorJson("Could not generate a unique room code, try again", 500);
  }

  // From here, any failure cleans up by deleting the room; player_secrets,
  // players, and room_secrets all cascade off rooms(code) / players(id).
  const { error: secretsError } = await admin
    .from("room_secrets")
    .insert({ room_code: code, host_pin: pin });
  if (secretsError) {
    await admin.from("rooms").delete().eq("code", code);
    return errorJson("Failed to create room", 500);
  }

  const { data: player, error: playerError } = await admin
    .from("players")
    .insert({ room_code: code, name: hostName, is_host: true })
    .select("id")
    .single();
  if (playerError || !player) {
    await admin.from("rooms").delete().eq("code", code);
    return errorJson("Failed to create host player", 500);
  }

  const token = crypto.randomUUID();
  const { error: playerSecretsError } = await admin
    .from("player_secrets")
    .insert({ player_id: player.id, token });
  if (playerSecretsError) {
    await admin.from("rooms").delete().eq("code", code);
    return errorJson("Failed to create host player", 500);
  }

  return json({ ok: true, code, token, playerId: player.id });
}
