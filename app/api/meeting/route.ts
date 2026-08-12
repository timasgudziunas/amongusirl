import { z } from "zod";
import { errorJson, json, parseBody, resolvePlayer } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.enum(["emergency", "report"]),
  bodyPlayerId: z.string().optional(),
});

export async function POST(req: Request) {
  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { reason, bodyPlayerId } = parsed.data;

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
  if (room.phase !== "playing") {
    return errorJson("Meetings can only be called during play", 409);
  }

  let reportedBodyName: string | null = null;

  if (reason === "emergency") {
    if (player.has_called_meeting) {
      return errorJson("You've already used your emergency meeting", 409);
    }
    const { error: consumeError } = await admin
      .from("players")
      .update({ has_called_meeting: true })
      .eq("id", player.id);
    if (consumeError) {
      return errorJson("Failed to call meeting", 500);
    }
  } else {
    if (!bodyPlayerId) {
      return errorJson("bodyPlayerId is required to report a body", 400);
    }
    const [{ data: bodyPlayer }, { data: bodySecrets }] = await Promise.all([
      admin.from("players").select("id, room_code, name").eq("id", bodyPlayerId).maybeSingle(),
      admin.from("player_secrets").select("is_alive, reported").eq("player_id", bodyPlayerId).maybeSingle(),
    ]);
    if (
      !bodyPlayer ||
      bodyPlayer.room_code !== code ||
      !bodySecrets ||
      bodySecrets.is_alive ||
      bodySecrets.reported
    ) {
      return errorJson("That body has already been reported or is no longer valid", 409);
    }
    const { error: reportError } = await admin
      .from("player_secrets")
      .update({ reported: true })
      .eq("player_id", bodyPlayerId);
    if (reportError) {
      return errorJson("Failed to report body", 500);
    }
    reportedBodyName = bodyPlayer.name;
  }

  // Cancel every active claim and zero occupancy — nobody keeps credit for a task
  // interrupted by a meeting.
  await admin.from("task_claims").delete().eq("room_code", code);
  await admin.from("task_occupancy").update({ occupied: 0 }).eq("room_code", code);

  const { data: roster } = await admin.from("players").select("id").eq("room_code", code);
  const rosterIds = (roster ?? []).map((p) => p.id as string);
  const idFilter = rosterIds.length > 0 ? rosterIds : [""];

  // Reset check-in state BEFORE the room transition, per the gathering contract.
  await admin.from("player_secrets").update({ is_here: false }).in("player_id", idFilter);

  const { data: secretRows } = await admin
    .from("player_secrets")
    .select("player_id, is_alive")
    .in("player_id", idFilter);
  const expectedHere = (secretRows ?? []).filter((s) => s.is_alive).length;

  // Pause the sabotage cooldown for the duration of the meeting: bank the remainder,
  // /tick re-arms it when play resumes.
  const sabotageCarrySecs = room.sabotage_ready_at
    ? Math.max(0, Math.ceil((new Date(room.sabotage_ready_at).getTime() - Date.now()) / 1000))
    : 0;

  const { data: claimed } = await admin
    .from("rooms")
    .update({
      phase: "gathering",
      meeting_reason: reason,
      reported_body_name: reportedBodyName,
      meeting_caller_name: player.name,
      meeting_no: room.meeting_no + 1,
      expected_here: expectedHere,
      here_count: 0,
      phase_ends_at: new Date(Date.now() + room.gathering_secs * 1000).toISOString(),
      sabotage_ready_at: null,
      sabotage_carry_secs: sabotageCarrySecs,
    })
    .eq("code", code)
    .eq("phase", "playing")
    .select("code");

  if (!claimed || claimed.length === 0) {
    // Lost the race to a simultaneous meeting. Give back what this call consumed —
    // both flags were verified false above, so resetting them can't clobber anything.
    if (reason === "emergency") {
      await admin.from("players").update({ has_called_meeting: false }).eq("id", player.id);
    } else if (bodyPlayerId) {
      await admin.from("player_secrets").update({ reported: false }).eq("player_id", bodyPlayerId);
    }
    return errorJson("A meeting is already starting", 409);
  }

  return json({ ok: true });
}
