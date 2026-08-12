import { errorJson, json, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const resolved = await resolvePlayer(req);
  if (!resolved.ok) return resolved.response;
  const { player, secrets } = resolved;
  if (!secrets.is_alive) {
    return errorJson("You are dead", 403);
  }

  const admin = supabaseAdmin();
  const code = player.room_code;

  const { data: room, error: roomError } = await admin
    .from("rooms")
    .select("phase, meeting_secs, expected_here")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "gathering" && room.phase !== "sabotage") {
    return errorJson("Check-in isn't open right now", 409);
  }

  if (secrets.is_here) {
    return json({ ok: true });
  }

  const { error: hereError } = await admin
    .from("player_secrets")
    .update({ is_here: true })
    .eq("player_id", player.id);
  if (hereError) {
    return errorJson("Failed to check in", 500);
  }

  const { data: roster } = await admin.from("players").select("id").eq("room_code", code);
  const rosterIds = (roster ?? []).map((p) => p.id as string);
  const idFilter = rosterIds.length > 0 ? rosterIds : [""];
  const { data: secretRows } = await admin
    .from("player_secrets")
    .select("player_id, is_alive, is_here")
    .in("player_id", idFilter);
  const hereCount = (secretRows ?? []).filter((s) => s.is_alive && s.is_here).length;

  await admin.from("rooms").update({ here_count: hereCount }).eq("code", code);

  if (hereCount >= room.expected_here) {
    if (room.phase === "gathering") {
      await admin
        .from("rooms")
        .update({
          phase: "meeting",
          phase_ends_at: new Date(Date.now() + room.meeting_secs * 1000).toISOString(),
        })
        .eq("code", code)
        .eq("phase", "gathering");
    } else {
      await admin
        .from("rooms")
        .update({ phase: "playing", phase_ends_at: null, here_count: 0, expected_here: 0 })
        .eq("code", code)
        .eq("phase", "sabotage");
    }
  }

  return json({ ok: true });
}
