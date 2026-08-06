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

  const { error: roomUpdateError } = await admin
    .from("rooms")
    .update({
      phase: "lobby",
      phase_ends_at: null,
      tasks_done: 0,
      tasks_total: 0,
      here_count: 0,
      expected_here: 0,
      votes_cast: 0,
      last_result: null,
      winner: null,
      meeting_reason: null,
      reported_body_name: null,
      meeting_no: 0,
      // round is left alone — the next start-round increments it.
    })
    .eq("code", code);
  if (roomUpdateError) {
    return errorJson("Failed to reset room", 500);
  }

  await admin.from("task_claims").delete().eq("room_code", code);
  await admin.from("task_occupancy").update({ occupied: 0 }).eq("room_code", code);

  const { data: roster } = await admin.from("players").select("id").eq("room_code", code);
  const rosterIds = (roster ?? []).map((p) => p.id as string);

  if (rosterIds.length > 0) {
    await admin
      .from("player_secrets")
      .update({ is_alive: true, is_here: false, reported: false })
      .in("player_id", rosterIds);

    // Reset means a NEW GAME, so has_called_meeting clears here — the emergency
    // meeting button is once per game. Contrast with start-round, which deliberately
    // does NOT reset it between rounds of the same game.
    await admin.from("players").update({ has_called_meeting: false }).in("id", rosterIds);
  }

  return json({ ok: true });
}
