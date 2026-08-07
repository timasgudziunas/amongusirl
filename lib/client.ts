"use client";

const TOKEN_KEY = "au:token";
const CODE_KEY = "au:code";
const PIN_KEY = "au:pin";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
}
export function getCode(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(CODE_KEY);
}
export function setCode(code: string) {
  window.localStorage.setItem(CODE_KEY, code);
}
export function getPin(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(PIN_KEY);
}
export function setPin(pin: string) {
  window.localStorage.setItem(PIN_KEY, pin);
}
export function clearSession() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(CODE_KEY);
  window.localStorage.removeItem(PIN_KEY);
}

// The host's last-authored task list, kept on the host device so a brand-new room
// can be seeded in one tap instead of retyping every task. Deliberately NOT cleared
// by clearSession — it should survive across rooms.
const SAVED_TASKS_KEY = "au:lastTasks";

export type SavedTask = { name: string; location: string; description: string };

export function getSavedTasks(): SavedTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SAVED_TASKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is SavedTask =>
        typeof t?.name === "string" && typeof t?.location === "string" && typeof t?.description === "string"
    );
  } catch {
    return [];
  }
}

export function setSavedTasks(tasks: SavedTask[]) {
  // An intentionally emptied list still overwrites — the saved copy always mirrors
  // the last list the host actually saved to a room.
  window.localStorage.setItem(SAVED_TASKS_KEY, JSON.stringify(tasks));
}

export type ApiSuccess<T> = { ok: true; serverTime: string } & T;
export type ApiFailure = { ok: false; error: string; serverTime: string };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** Fetch wrapper: attaches x-player-token, parses the {ok} shape. Never throws. */
export async function api<T = Record<string, never>>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["x-player-token"] = token;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    return { ok: false, error: "Network error", serverTime: new Date().toISOString() };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Bad response from server", serverTime: new Date().toISOString() };
  }

  return data as ApiResult<T>;
}
