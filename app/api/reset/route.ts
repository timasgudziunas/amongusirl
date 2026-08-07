import { z } from "zod";
import { errorJson, json, parseBody, resolveHost } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";
import { resetRoomToLobby } from "@/lib/game";

export const runtime = "nodejs";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;

  const resolved = await resolveHost(req, parsed.data.pin);
  if (!resolved.ok) return resolved.response;
  const { player } = resolved;
  const code = player.room_code;

  const admin = supabaseAdmin();

  const { error: roomUpdateError } = await resetRoomToLobby(admin, code);
  if (roomUpdateError) {
    return errorJson("Failed to reset room", 500);
  }

  return json({ ok: true });
}
