import { z } from "zod";
import { errorJson, json, parseBody, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";
import { advanceFromVoting } from "@/lib/game";

export const runtime = "nodejs";

const bodySchema = z.object({
  targetId: z.string().nullable(),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { targetId } = parsed.data;

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
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (roomError || !room) {
    return errorJson("Room not found", 404);
  }
  if (room.phase !== "voting") {
    return errorJson("Voting isn't open right now", 409);
  }

  if (targetId !== null) {
    const [{ data: targetPlayer }, { data: targetSecrets }] = await Promise.all([
      admin.from("players").select("id, room_code").eq("id", targetId).maybeSingle(),
      admin.from("player_secrets").select("is_alive").eq("player_id", targetId).maybeSingle(),
    ]);
    if (!targetPlayer || targetPlayer.room_code !== code || !targetSecrets || !targetSecrets.is_alive) {
      return errorJson("Invalid vote target", 400);
    }
  }

  // Upsert — revoting overwrites, PK is (room_code, round, meeting_no, voter_id).
  const { error: voteError } = await admin.from("votes").upsert(
    { room_code: code, round: room.round, meeting_no: room.meeting_no, voter_id: player.id, target_id: targetId },
    { onConflict: "room_code,round,meeting_no,voter_id" }
  );
  if (voteError) {
    return errorJson("Failed to cast vote", 500);
  }

  const { count: votesCast } = await admin
    .from("votes")
    .select("*", { count: "exact", head: true })
    .eq("room_code", code)
    .eq("round", room.round)
    .eq("meeting_no", room.meeting_no);

  await admin.from("rooms").update({ votes_cast: votesCast ?? 0 }).eq("code", code);

  const { data: roster } = await admin.from("players").select("id").eq("room_code", code);
  const rosterIds = (roster ?? []).map((p) => p.id as string);
  const idFilter = rosterIds.length > 0 ? rosterIds : [""];
  const { data: secretRows } = await admin.from("player_secrets").select("is_alive").in("player_id", idFilter);
  const livingCount = (secretRows ?? []).filter((s) => s.is_alive).length;

  if ((votesCast ?? 0) >= livingCount) {
    await advanceFromVoting(admin, room);
  }

  return json({ ok: true });
}
