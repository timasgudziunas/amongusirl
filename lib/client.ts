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
