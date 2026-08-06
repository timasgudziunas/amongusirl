import { z } from "zod";
import { errorJson, json, parseBody, resolveHost } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

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
  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("phase, meeting_secs")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "gathering") {
    return errorJson("Can only force the meeting while gathering", 409);
  }

  const { data: claimed } = await admin
    .from("rooms")
    .update({
      phase: "meeting",
      phase_ends_at: new Date(Date.now() + room.meeting_secs * 1000).toISOString(),
    })
    .eq("code", code)
    .eq("phase", "gathering")
    .select("code");

  if (!claimed || claimed.length === 0) {
    return errorJson("The meeting already started", 409);
  }

  return json({ ok: true });
}
