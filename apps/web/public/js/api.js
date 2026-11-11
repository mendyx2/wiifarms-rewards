// Thin client for the WiiFarm Rewards API. The session lives in a cookie that
// page scripts cannot read; this file never sees or stores it.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(method, path, body, idempotencyKey) {
  const headers = { "X-WR-Client": "web" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "OFFLINE", "No connection. Check your network and try again — nothing was lost.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? "Something went wrong. Please try again.");
  return data;
}

export const api = {
  get: (path) => call("GET", path),
  post: (path, body = {}, key) => call("POST", path, body, key),
  put: (path, body) => call("PUT", path, body),
};

/**
 * A request key that survives a dropped connection: retrying the same action
 * reuses the key, so the server treats it as the same request and never
 * charges or pays twice.
 */
export function stableKey(name) {
  try {
    const existing = sessionStorage.getItem("key:" + name);
    if (existing) return existing;
    const key = crypto.randomUUID();
    sessionStorage.setItem("key:" + name, key);
    return key;
  } catch {
    return crypto.randomUUID();
  }
}
export function clearKey(name) {
  try { sessionStorage.removeItem("key:" + name); } catch { /* storage unavailable */ }
}
