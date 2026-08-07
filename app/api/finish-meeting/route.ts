import { z } from "zod";
import { errorJson, json, parseBody, resolveHost } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
});

// Host ends the discussion early — meeting -> voting, same transition /tick makes on
// timeout, conditional so it can't double-fire against a concurrent tick.
export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;

  const resolved = await resolveHost(req, parsed.data.pin);
  if (!resolved.ok) return resolved.response;
  const code = resolved.player.room_code;

  const admin = supabaseAdmin();
  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("phase, voting_secs")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "meeting") {
    return errorJson("No meeting is in progress", 409);
  }

  const { data: claimed } = await admin
    .from("rooms")
    .update({
      phase: "voting",
      phase_ends_at: new Date(Date.now() + room.voting_secs * 1000).toISOString(),
      votes_cast: 0,
    })
    .eq("code", code)
    .eq("phase", "meeting")
    .select("code");
  if (!claimed || claimed.length === 0) {
    return errorJson("No meeting is in progress", 409);
  }

  return json({ ok: true });
}
