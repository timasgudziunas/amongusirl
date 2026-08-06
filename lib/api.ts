import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";

/** Every response, success or failure, carries serverTime. */
export function json(data: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ...data, serverTime: new Date().toISOString() }, { status });
}

export function errorJson(error: string, status = 400) {
  return json({ ok: false, error }, status);
}

export async function parseBody<T>(
  req: Request,
  schema: ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: errorJson("Invalid JSON body", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request";
    return { ok: false, response: errorJson(message, 400) };
  }
  return { ok: true, data: parsed.data };
}

export type PlayerRow = {
  id: string;
  room_code: string;
  name: string;
  has_called_meeting: boolean;
  is_host: boolean;
  joined_at: string;
};

export type PlayerSecretsRow = {
  player_id: string;
  token: string;
  is_alive: boolean;
  is_here: boolean;
  reported: boolean;
};

type ResolvedPlayer = { ok: true; player: PlayerRow; secrets: PlayerSecretsRow };
type ResolveFailure = { ok: false; response: NextResponse };

/** Resolves the x-player-token header to the player and their secret row. */
export async function resolvePlayer(req: Request): Promise<ResolvedPlayer | ResolveFailure> {
  const token = req.headers.get("x-player-token");
  if (!token) {
    return { ok: false, response: errorJson("Missing x-player-token header", 401) };
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("player_secrets")
    .select("player_id, token, is_alive, is_here, reported, players(*)")
    .eq("token", token)
    .maybeSingle();

  if (error || !data || !data.players) {
    return { ok: false, response: errorJson("Unknown or expired player token", 401) };
  }

  const { players, ...secrets } = data as unknown as PlayerSecretsRow & { players: PlayerRow };
  return { ok: true, player: players, secrets: secrets as PlayerSecretsRow };
}

/** Resolves the caller as the host of their own room and verifies the PIN. */
export async function resolveHost(
  req: Request,
  pin: string
): Promise<{ ok: true; player: PlayerRow } | ResolveFailure> {
  const resolved = await resolvePlayer(req);
  if (!resolved.ok) return resolved;

  if (!resolved.player.is_host) {
    return { ok: false, response: errorJson("Host only", 403) };
  }

  const admin = supabaseAdmin();
  const { data: secrets, error } = await admin
    .from("room_secrets")
    .select("host_pin")
    .eq("room_code", resolved.player.room_code)
    .maybeSingle();

  if (error || !secrets || secrets.host_pin !== pin) {
    return { ok: false, response: errorJson("Invalid host PIN", 403) };
  }

  return { ok: true, player: resolved.player };
}
