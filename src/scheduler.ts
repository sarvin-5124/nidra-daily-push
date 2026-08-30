/**
 * The clock. Replaces GitHub's schedule queue, which is the whole reason this
 * service exists.
 *
 * A 20-second tick asks three questions, in order:
 *
 *   1. Does today's schedule exist?    If not, plan it.
 *   2. Does tomorrow's exist?          If not, plan it. (This is what used to be
 *      the 00:00 IST planner cron: the moment the IST date rolls over, the new
 *      "tomorrow" is missing and gets planned within 20 s.)
 *   3. Is any planned slot due?        If sendAt has passed, send it.
 *
 * Nothing here waits on a queue it does not control, so a slot fires within
 * 20 s of its sendAt instead of 4–12 h late. Precision costs nothing: the tick
 * is a file stat plus a date comparison.
 *
 * The lateness that remains is downtime — this box, this container. That is a
 * different failure with a different right answer: a 14:00 push delivered at
 * 21:00 is worse than no push, so anything more than MAX_LATE_MIN past sendAt
 * is recorded as `missed` and paged rather than sent.
 */
import { buildSchedule } from "../scripts/plan.ts";
import { resumeSlot, sendSlot } from "../scripts/execute.ts";
import { notify } from "../scripts/lib/ntfy.ts";
import {
  istDateKey,
  istISO,
  nextDateKey,
  prevDateKey,
} from "../scripts/lib/time.ts";
import type { PlannedSlot, Schedule } from "../scripts/lib/types.ts";
import {
  hasSchedule,
  listDates,
  readSchedule,
  writeSchedule,
} from "./store.ts";

const TICK_MS = 20_000;
/**
 * How far past sendAt a push may still go out. Beyond this the slot is marked
 * `missed`.
 *
 * 60 min because the only thing that can now make a send late is the service
 * being down — the trigger itself is local and punctual. An hour is long enough
 * to ride out a container restart or a short reboot, and short enough that a
 * member never gets an "after-lunch dip" nudge in the evening.
 */
const MAX_LATE_MIN = 60;
/** Retry interval for a failed plan attempt. */
const PLAN_RETRY_MS = 10 * 60_000;
/** Don't page about the same failing plan more than this often. */
const PLAN_PAGE_MS = 60 * 60_000;

interface PlanAttempt {
  lastTry: number;
  lastPage: number;
  failures: number;
  lastError?: string;
}

const planAttempts = new Map<string, PlanAttempt>();
/**
 * Dates a plan attempt is currently in flight for.
 *
 * Planning reaches the catalog API, and `fetchCatalog` retries three times with
 * backoff — up to ~75 s when the backend is unreachable. That must never sit in
 * front of a due send, so planning runs detached from the tick and this set is
 * what stops the next tick starting a second attempt for the same date.
 */
const planning = new Set<string>();

export interface SchedulerHealth {
  startedAt: string;
  lastTickAt: string | null;
  ticks: number;
  busy: boolean;
  sending: string[];
  lastError: string | null;
  tickSeconds: number;
  maxLateMin: number;
}

const health: SchedulerHealth = {
  startedAt: istISO(new Date()),
  lastTickAt: null,
  ticks: 0,
  busy: false,
  sending: [],
  lastError: null,
  tickSeconds: TICK_MS / 1000,
  maxLateMin: MAX_LATE_MIN,
};

/** In-flight sends, keyed `date:slotKey`. The only lock this service needs. */
const inFlight = new Set<string>();

export function schedulerHealth(): SchedulerHealth {
  return { ...health, sending: [...inFlight] };
}

export function isInFlight(date: string, key: string): boolean {
  return inFlight.has(`${date}:${key}`);
}

/**
 * Run a send under the in-flight lock. Exported so the dashboard's manual
 * trigger shares the same mutual exclusion as the tick — two paths into one
 * broadcast, one lock.
 */
export async function withSendLock<T>(
  date: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const id = `${date}:${key}`;
  if (inFlight.has(id))
    throw new Error(
      `${key} on ${date} is already sending — refusing to start a second`,
    );
  inFlight.add(id);
  try {
    return await fn();
  } finally {
    inFlight.delete(id);
  }
}

/** Ensure a schedule exists for `date`, with backoff and rate-limited paging. */
async function ensureSchedule(date: string, urgent: boolean): Promise<void> {
  if (hasSchedule(date)) {
    planAttempts.delete(date);
    return;
  }
  if (planning.has(date)) return;
  const now = Date.now();
  const att = planAttempts.get(date) ?? {
    lastTry: 0,
    lastPage: 0,
    failures: 0,
  };
  if (now - att.lastTry < PLAN_RETRY_MS) return;
  att.lastTry = now;
  planAttempts.set(date, att);
  planning.add(date);

  try {
    console.log(`[sched] no schedule for ${date}, planning it now`);
    await buildSchedule(date);
    planAttempts.delete(date);
  } catch (e) {
    att.failures++;
    att.lastError = (e as Error).message;
    console.error(
      `[sched] plan for ${date} failed (attempt ${att.failures}): ${att.lastError}`,
    );
    if (now - att.lastPage >= PLAN_PAGE_MS) {
      att.lastPage = now;
      await notify(
        "fail",
        `Nidra plan failed · ${date}`,
        (urgent
          ? `TODAY has no schedule, so nothing will send today.`
          : `${date} has no schedule yet. Retrying every ${PLAN_RETRY_MS / 60_000} min.`) +
          `\n\nAttempt ${att.failures}: ${att.lastError}`,
        ["rotating_light"],
      );
    }
  } finally {
    planning.delete(date);
  }
}

/** Plan today and tomorrow if either is missing. Never awaited by the tick. */
async function ensurePlans(today: string): Promise<void> {
  await ensureSchedule(today, true);
  await ensureSchedule(nextDateKey(today), false);
}

function minutesPast(now: Date, iso: string): number {
  return (now.getTime() - new Date(iso).getTime()) / 60_000;
}

/**
 * Mark a slot the service was not running for.
 *
 * Two different things look alike here and must not be conflated. If the
 * schedule was generated AFTER the slot's send time had already passed — a
 * first deploy at 15:00, a volume restored mid-afternoon — then no push was
 * ever going to happen and nobody needs waking: that is `skipped`. If the
 * schedule predates the send time, something really did fail to fire, and that
 * is `missed` and worth a page.
 */
async function markUnsent(
  schedule: Schedule,
  slot: PlannedSlot,
  lateMin: number,
): Promise<void> {
  const neverHadAChance =
    new Date(schedule.generatedAt).getTime() > new Date(slot.sendAt).getTime();
  slot.status = neverHadAChance ? "skipped" : "missed";
  slot.result = {
    ...(slot.result ?? {}),
    finishedAt: istISO(new Date()),
    lateBy: Math.round(lateMin),
    error: neverHadAChance
      ? `schedule was generated at ${schedule.generatedAt}, after sendAt ${slot.sendAt} — nothing was ever due`
      : `${Math.round(lateMin)} min past sendAt with no send; window is ${MAX_LATE_MIN} min`,
  };
  writeSchedule(schedule);

  if (neverHadAChance) {
    console.warn(
      `[sched] ${schedule.date} ${slot.key}: skipped, planned after its own send time`,
    );
    return;
  }
  console.error(
    `[sched] ${schedule.date} ${slot.key}: MISSED by ${Math.round(lateMin)} min`,
  );
  await notify(
    "fail",
    `Nidra ${slot.slotAt} MISSED · ${slot.key}`,
    `${schedule.date} ${slot.key} was never sent. sendAt was ${slot.sendAt}, now ` +
      `${Math.round(lateMin)} min past that — beyond the ${MAX_LATE_MIN} min window, so it was ` +
      `NOT sent late.\n\nThe service was down or wedged across that window. Send it by hand from ` +
      `the dashboard if it is still worth sending.`,
    ["rotating_light"],
  );
}

/**
 * Deal with a slot left at `sending` by a crash. Called once at startup.
 *
 * With a campaign id the send definitely left, so the only work outstanding is
 * the poll — resume it, no broadcast. Without one, the send may or may not have
 * been accepted by the backend, and there is no way to tell from here. That
 * case is left alone deliberately: guessing wrong sends a second push to the
 * whole base, so a human decides from the dashboard.
 */
async function recoverInFlight(): Promise<void> {
  const today = istDateKey();
  for (const date of [prevDateKey(today), today]) {
    const schedule = readSchedule(date);
    if (!schedule) continue;
    for (const slot of schedule.slots) {
      if (slot.status !== "sending") continue;
      const id = slot.result?.campaignId;
      if (id) {
        console.warn(
          `[sched] recovering ${date} ${slot.key}: campaign ${id} already sent, resuming poll`,
        );
        try {
          await withSendLock(date, slot.key, () => resumeSlot(schedule, slot));
        } catch (e) {
          console.error(
            `[sched] resume of ${date} ${slot.key} failed: ${(e as Error).message}`,
          );
        }
        continue;
      }
      console.error(
        `[sched] ${date} ${slot.key} is stuck at "sending" with no campaign id`,
      );
      await notify(
        "fail",
        `Nidra send outcome UNKNOWN · ${slot.key}`,
        `${date} ${slot.key} was mid-send when the service stopped, and no campaign id was ` +
          `recorded — so it is not known whether the broadcast reached the backend.\n\n` +
          `Left untouched on purpose: an automatic retry here could send a second push to the ` +
          `whole base. Check the admin send history for ${date}, then use the dashboard to ` +
          `either send it or mark it resolved.`,
        ["rotating_light"],
      );
    }
  }
}

/**
 * Settle slots on PAST dates that are still sitting at `planned`.
 *
 * The tick only ever looks at today, so a day the service was not running for
 * kept its slots at `planned` indefinitely and the dashboard reported them as
 * upcoming — which is how 2026-08-27 through -30 still read as pending after
 * the fact. This closes them out to the truth.
 *
 * Silent on purpose: these are historical, a page about a push that was due
 * days ago is noise, and the days that mattered were already paged for (or, in
 * the case that prompted the move, not — that gap is what markUnsent now
 * covers going forward).
 */
function sweepStalePlanned(): void {
  const today = istDateKey();
  let touched = 0;
  for (const date of listDates()) {
    if (date >= today) continue;
    const schedule = readSchedule(date);
    if (!schedule) continue;
    let dirty = false;
    for (const slot of schedule.slots) {
      if (slot.status !== "planned") continue;
      const neverHadAChance =
        new Date(schedule.generatedAt).getTime() >
        new Date(slot.sendAt).getTime();
      slot.status = neverHadAChance ? "skipped" : "missed";
      slot.result = {
        ...(slot.result ?? {}),
        finishedAt: istISO(new Date()),
        error: neverHadAChance
          ? `schedule was generated at ${schedule.generatedAt}, after sendAt ${slot.sendAt}`
          : "never sent; the date passed with the slot still planned",
      };
      dirty = true;
      touched++;
    }
    if (dirty) writeSchedule(schedule);
  }
  if (touched)
    console.warn(
      `[sched] closed out ${touched} stale planned slot(s) on past dates`,
    );
}

async function tick(): Promise<void> {
  if (health.busy) return;
  health.busy = true;
  const today = istDateKey();
  try {
    const now = new Date();

    const schedule = readSchedule(today);
    if (schedule) {
      for (const slot of schedule.slots) {
        // Only "planned" auto-sends. "failed" is deliberately manual: a failure
        // can mean the backend accepted the send and then reported badly, and an
        // automatic retry would be a second broadcast.
        if (slot.status !== "planned") continue;
        if (isInFlight(today, slot.key)) continue;
        const lateMin = minutesPast(now, slot.sendAt);
        if (lateMin < 0) continue;
        if (lateMin > MAX_LATE_MIN) {
          await markUnsent(schedule, slot, lateMin);
          continue;
        }
        console.log(
          `[sched] ${slot.key} is due (sendAt ${slot.sendAt}) — sending`,
        );
        try {
          await withSendLock(today, slot.key, () =>
            sendSlot(schedule, slot, { triggeredBy: "scheduler" }),
          );
        } catch (e) {
          // sendSlot has already recorded "failed" and paged. Swallow so one bad
          // slot cannot stop the tick loop.
          health.lastError = (e as Error).message;
          console.error(
            `[sched] send of ${slot.key} failed: ${health.lastError}`,
          );
        }
      }
    }
    health.lastTickAt = istISO(new Date());
    health.ticks++;
  } catch (e) {
    health.lastError = (e as Error).message;
    console.error(`[sched] tick error: ${health.lastError}`);
  } finally {
    health.busy = false;
  }

  // Planning last, and NOT awaited: a slow or failing catalog fetch would
  // otherwise hold the lock and push a due send minutes past its sendAt. Its
  // own backoff and in-flight guard keep repeat ticks from piling up.
  void ensurePlans(today);
}

/** Resolves once the first tick has completed, so boot-time work can wait. */
let firstTickDone: Promise<void> = Promise.resolve();
export function whenSettled(): Promise<void> {
  return firstTickDone;
}

/** Start the tick loop. Returns a stop function. */
export function startScheduler(): () => void {
  console.log(
    `[sched] starting · tick ${TICK_MS / 1000}s · late window ${MAX_LATE_MIN} min · IST clock`,
  );
  sweepStalePlanned();
  // Recovery next, then the loop: a slot stuck at "sending" must be settled
  // before a tick could look at the same file.
  void recoverInFlight()
    .catch((e) =>
      console.error(`[sched] recovery failed: ${(e as Error).message}`),
    )
    .then(() => tick());
  const handle = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(handle);
}
