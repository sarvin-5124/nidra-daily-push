/**
 * Token gate for every route that can change something.
 *
 * The dashboard is deliberately public to READ — the repo it mirrors to is
 * public, so the schedule, the copy and the delivery counts are already open
 * information and hiding them here would buy nothing. What is emphatically not
 * public is the ability to act: one of these routes broadcasts to the whole
 * member base, and it has no undo.
 *
 * Bearer token rather than a session cookie: there is one operator, the token
 * lives in secrets-manager, and a cookie would need CSRF defence that a header
 * does not (a cross-site form post cannot set Authorization).
 */
import { timingSafeEqual } from "node:crypto";

const TOKEN = (process.env.DASHBOARD_TOKEN || "").trim();
/** Attempts allowed per IP per window, to make guessing pointless. */
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60_000;

const attempts = new Map<string, { count: number; resetAt: number }>();

export const authConfigured = TOKEN.length > 0;

if (!authConfigured) {
  console.warn(
    "[auth] DASHBOARD_TOKEN is not set — every mutating route will refuse. " +
      "Set it in secrets-manager as NIDRA_DAILY_PUSH_DASHBOARD_TOKEN.",
  );
} else if (TOKEN.length < 24) {
  console.warn(
    `[auth] DASHBOARD_TOKEN is only ${TOKEN.length} chars. This token is the sole guard on a ` +
      "route that pushes to the entire member base — use 32+ random chars.",
  );
}

function constantTimeMatch(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Compare fixed-width digests of both instead.
  if (a.length !== b.length) {
    // Still do a comparison of equal length so the failure path costs the same.
    const pad = Buffer.alloc(b.length);
    a.copy(pad, 0, 0, Math.min(a.length, b.length));
    timingSafeEqual(pad, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > MAX_ATTEMPTS;
}

function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

export interface AuthResult {
  ok: boolean;
  status: number;
  reason?: string;
}

/** Check the Authorization header of a request that intends to change state. */
export function checkAuth(req: Request, ip: string): AuthResult {
  if (!authConfigured)
    return {
      ok: false,
      status: 503,
      reason:
        "DASHBOARD_TOKEN is not configured on the server, so no action can be authorised",
    };

  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return { ok: false, status: 401, reason: "missing bearer token" };

  if (rateLimited(ip))
    return {
      ok: false,
      status: 429,
      reason: "too many attempts, try again later",
    };

  if (!constantTimeMatch(given))
    return { ok: false, status: 401, reason: "bad token" };

  clearAttempts(ip);
  return { ok: true, status: 200 };
}
