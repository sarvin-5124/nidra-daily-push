/**
 * HTTP surface: the dashboard, its read API, and the guarded action routes.
 *
 * Read routes are open (see src/auth.ts for why). Every route that changes
 * something — sending, re-planning, resolving a stuck slot, mirroring — is
 * behind a bearer token AND, where it can broadcast, behind the same in-flight
 * lock the scheduler uses. There is exactly one way for a push to leave this
 * service, and both the tick and this file go through it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSchedule } from "../scripts/plan.ts";
import { sendSlot } from "../scripts/execute.ts";
import { istDateKey, istISO, nextDateKey } from "../scripts/lib/time.ts";
import type { PlannedSlot, Schedule } from "../scripts/lib/types.ts";
import { authConfigured, checkAuth } from "./auth.ts";
import { mirrorNow, mirrorState } from "./mirror.ts";
import { ROOT } from "./paths.ts";
import { tail } from "./runlog.ts";
import { isInFlight, schedulerHealth, withSendLock } from "./scheduler.ts";
import {
  findSlot,
  readSchedule,
  recentSchedules,
  writeSchedule,
} from "./store.ts";

const PUBLIC_DIR = join(ROOT, "public");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Public shape of a slot. Everything here is already in the public repo. */
function slotView(slot: PlannedSlot) {
  return {
    key: slot.key,
    slotAt: slot.slotAt,
    sendAt: slot.sendAt,
    jitterMin: slot.jitterMin,
    status: slot.status,
    item: slot.item,
    copyId: slot.copyId,
    title: slot.title,
    body: slot.body,
    route: slot.route,
    result: slot.result,
  };
}

function scheduleView(schedule: Schedule) {
  return {
    date: schedule.date,
    generatedAt: schedule.generatedAt,
    generatedBy: schedule.generatedBy,
    slots: schedule.slots.map(slotView),
  };
}

/** The next slot that has not yet resolved, today or tomorrow. */
function nextUp(): { date: string; slot: PlannedSlot } | null {
  const today = istDateKey();
  for (const date of [today, nextDateKey(today)]) {
    const s = readSchedule(date);
    if (!s) continue;
    const pending = s.slots
      .filter((x) => x.status === "planned" || x.status === "sending")
      .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
    if (pending.length) return { date, slot: pending[0] };
  }
  return null;
}

async function handleStatus(): Promise<Response> {
  const today = istDateKey();
  const todaySched = readSchedule(today);
  const tomorrow = readSchedule(nextDateKey(today));
  const up = nextUp();
  return json({
    now: istISO(new Date()),
    today,
    scheduler: schedulerHealth(),
    mirror: mirrorState(),
    authConfigured,
    next: up ? { date: up.date, ...slotView(up.slot) } : null,
    todaySchedule: todaySched ? scheduleView(todaySched) : null,
    tomorrowPlanned: Boolean(tomorrow),
  });
}

function handleHistory(url: URL): Response {
  const days = Math.min(
    Math.max(Number(url.searchParams.get("days") || 30), 1),
    120,
  );
  return json({ schedules: recentSchedules(days).map(scheduleView) });
}

function handleLogs(url: URL): Response {
  const n = Math.min(
    Math.max(Number(url.searchParams.get("n") || 200), 1),
    1000,
  );
  return json({ lines: tail(n) });
}

interface ActionBody {
  date?: string;
  slot?: string;
  mode?: "schedule" | "single_user";
  userId?: string;
  force?: boolean;
}

async function readBody(req: Request): Promise<ActionBody> {
  try {
    return (await req.json()) as ActionBody;
  } catch {
    return {};
  }
}

/**
 * POST /api/actions/send — send one slot now.
 *
 * `mode: "single_user"` is the safe rehearsal: it targets one user id, checks
 * what came back against a recipient cap, and never marks the slot sent. The
 * default `schedule` mode goes to the whole audience, so it refuses any slot
 * not in `planned` or `failed` (that check lives in sendSlot, where the tick
 * hits it too).
 */
async function handleSend(req: Request): Promise<Response> {
  const body = await readBody(req);
  const date = body.date || istDateKey();
  if (!DATE_RE.test(date)) return bad(`date "${date}" is not YYYY-MM-DD`);
  const schedule = readSchedule(date);
  if (!schedule) return bad(`no schedule for ${date}`, 404);

  const key = (body.slot || "").trim();
  if (!key)
    return bad(
      `slot is required (available: ${schedule.slots.map((s) => s.key).join(", ")})`,
    );
  const slot = findSlot(schedule, key);
  if (!slot) return bad(`slot "${key}" is not in ${date}`, 404);

  const mode = body.mode === "single_user" ? "single_user" : "schedule";
  const userId = (body.userId || "").trim();
  if (mode === "single_user" && !userId)
    return bad(
      "single_user mode needs a userId — refusing to fall through to the full audience",
    );

  if (isInFlight(date, key)) return bad(`${key} is already sending`, 409);

  try {
    const out = await withSendLock(date, key, () =>
      sendSlot(schedule, slot, {
        testUserId: mode === "single_user" ? userId : undefined,
        triggeredBy:
          mode === "single_user" ? `dashboard:test:${userId}` : "dashboard",
      }),
    );
    return json({
      ok: out.delivered,
      mode,
      campaign: out.campaign,
      slot: slotView(out.slot),
    });
  } catch (e) {
    return bad((e as Error).message, 409);
  }
}

/** POST /api/actions/plan — build (or rebuild) a day's schedule. */
async function handlePlan(req: Request): Promise<Response> {
  const body = await readBody(req);
  const date = body.date || nextDateKey(istDateKey());
  if (!DATE_RE.test(date)) return bad(`date "${date}" is not YYYY-MM-DD`);

  const existing = readSchedule(date);
  if (existing && !body.force) {
    const settled = existing.slots.filter((s) => s.status !== "planned");
    if (settled.length)
      return bad(
        `${date} already has ${settled.length} slot(s) past "planned" ` +
          `(${settled.map((s) => `${s.key}=${s.status}`).join(", ")}). ` +
          `Re-planning would drop that record. Pass force:true only if that is what you want.`,
        409,
      );
  }
  try {
    const schedule = await buildSchedule(date);
    return json({ ok: true, schedule: scheduleView(schedule) });
  } catch (e) {
    return bad((e as Error).message, 500);
  }
}

/**
 * POST /api/actions/resolve — clear a slot stuck at "sending".
 *
 * Only reachable for that one status, and it does not send anything. It exists
 * because a crash between the in-flight marker and the campaign id leaves a
 * genuinely unknowable state that only a human who has checked the admin send
 * history can close out.
 */
async function handleResolve(req: Request): Promise<Response> {
  const body = await readBody(req);
  const date = body.date || istDateKey();
  if (!DATE_RE.test(date)) return bad(`date "${date}" is not YYYY-MM-DD`);
  const schedule = readSchedule(date);
  if (!schedule) return bad(`no schedule for ${date}`, 404);
  const slot = findSlot(schedule, (body.slot || "").trim());
  if (!slot) return bad(`slot "${body.slot}" is not in ${date}`, 404);
  if (slot.status !== "sending")
    return bad(
      `${slot.key} is "${slot.status}", not "sending" — nothing to resolve`,
      409,
    );
  if (isInFlight(date, slot.key))
    return bad(`${slot.key} is sending right now`, 409);

  slot.status = "sent";
  slot.result = {
    ...(slot.result ?? {}),
    finishedAt: istISO(new Date()),
    error: "resolved by hand from the dashboard; delivery counts unknown",
    triggeredBy: "dashboard:resolve",
  };
  writeSchedule(schedule);
  return json({ ok: true, slot: slotView(slot) });
}

async function handleMirror(): Promise<Response> {
  return json(await mirrorNow("manual"));
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Reject anything that could climb out of public/.
  if (rel.includes("..")) return new Response("no", { status: 400 });
  const file = join(PUBLIC_DIR, rel);
  if (!existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(file));
}

const ACTIONS: Record<string, (req: Request) => Promise<Response>> = {
  "/api/actions/send": handleSend,
  "/api/actions/plan": handlePlan,
  "/api/actions/resolve": handleResolve,
  "/api/actions/mirror": () => handleMirror(),
};

/** Start listening. Returns the server so shutdown can stop it and exit. */
export function startServer(): Bun.Server<undefined> {
  const port = Number(process.env.PORT || 3000);
  const server = Bun.serve({
    port,
    // The long poll inside waitForCampaign can hold a manual send open for
    // minutes; the default 10 s idle timeout would cut the response.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const ip = server.requestIP(req)?.address ?? "unknown";

      if (url.pathname === "/healthz") {
        const h = schedulerHealth();
        // Unhealthy once the tick loop stops advancing — the one failure this
        // service cannot page about on its own behalf, so Docker's healthcheck
        // has to catch it.
        //
        // A never-completed FIRST tick counts too: treating a null lastTickAt as
        // healthy reported ok on a loop that was wedged from boot and had never
        // looked at a slot.
        const STALE_MS = 5 * 60_000;
        const since = h.lastTickAt
          ? Date.now() - new Date(h.lastTickAt).getTime()
          : Date.now() - new Date(h.startedAt).getTime();
        const stale = since > STALE_MS;
        return json(
          { ok: !stale, secondsSinceTick: Math.round(since / 1000), ...h },
          stale ? 503 : 200,
        );
      }

      if (req.method === "GET") {
        if (url.pathname === "/api/status") return handleStatus();
        if (url.pathname === "/api/history") return handleHistory(url);
        if (url.pathname === "/api/logs") {
          const auth = checkAuth(req, ip);
          if (!auth.ok) return bad(auth.reason ?? "unauthorised", auth.status);
          return handleLogs(url);
        }
        if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname);
        return bad("not found", 404);
      }

      if (req.method === "POST") {
        const action = ACTIONS[url.pathname];
        if (!action) return bad("not found", 404);
        const auth = checkAuth(req, ip);
        if (!auth.ok) {
          console.warn(
            `[http] ${url.pathname} refused for ${ip}: ${auth.reason}`,
          );
          return bad(auth.reason ?? "unauthorised", auth.status);
        }
        console.log(`[http] ${url.pathname} authorised for ${ip}`);
        return action(req);
      }

      return bad("method not allowed", 405);
    },
  });
  console.log(`[http] listening on :${port} · dashboard at /`);
  return server;
}
