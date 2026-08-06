import { errorJson, json, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

// The one deliberate exception to "deaths aren't published during playing" — a living
// player hits this only when they actively choose Report Body. Names only, opt-in,
// never fetched automatically. See CLAUDE.md invariant 5.
export async function GET(req: Request) {
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
    .select("phase")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "playing") {
    return errorJson("Bodies can only be reported during play", 409);
  }

  const { data: roster } = await admin.from("players").select("id, name").eq("room_code", code);
  const rosterIds = (roster ?? []).map((p) => p.id as string);
  if (rosterIds.length === 0) {
    return json({ ok: true, bodies: [] });
  }

  const { data: secretRows } = await admin
    .from("player_secrets")
    .select("player_id, is_alive, reported")
    .in("player_id", rosterIds)
    .eq("is_alive", false)
    .eq("reported", false);

  const nameMap = new Map((roster ?? []).map((p) => [p.id as string, p.name as string]));
  const bodies = (secretRows ?? []).map((s) => ({
    playerId: s.player_id as string,
    name: nameMap.get(s.player_id as string) ?? "",
  }));

  return json({ ok: true, bodies });
}
