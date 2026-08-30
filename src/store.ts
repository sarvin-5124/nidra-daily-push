/**
 * Read/write access to the schedule files on the volume.
 *
 * Every reader re-reads from disk rather than holding a schedule in memory: the
 * dashboard can mutate a slot between ticks, and a stale in-memory copy written
 * back would silently undo that.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeJSONAtomic } from "../scripts/lib/io.ts";
import { istDateKey } from "../scripts/lib/time.ts";
import type { PlannedSlot, Schedule } from "../scripts/lib/types.ts";
import { SCHEDULE_DIR, schedulePath } from "./paths.ts";

export function hasSchedule(date: string): boolean {
  return existsSync(schedulePath(date));
}

export function readSchedule(date: string): Schedule | null {
  const path = schedulePath(date);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Schedule;
  } catch (e) {
    // A corrupt file must not take the whole service down — writeJSONAtomic
    // makes this near-impossible, but a hand-edit on the box is not.
    console.error(`[store] ${path} is not valid JSON: ${(e as Error).message}`);
    return null;
  }
}

export function writeSchedule(schedule: Schedule): void {
  writeJSONAtomic(schedulePath(schedule.date), schedule);
}

/** IST date keys present on the volume, newest first. */
export function listDates(): string[] {
  if (!existsSync(SCHEDULE_DIR)) return [];
  return readdirSync(SCHEDULE_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .sort()
    .reverse();
}

/** The most recent `n` schedules, newest first. */
export function recentSchedules(n = 30): Schedule[] {
  const out: Schedule[] = [];
  for (const date of listDates()) {
    if (out.length >= n) break;
    const s = readSchedule(date);
    if (s) out.push(s);
  }
  return out;
}

export function findSlot(schedule: Schedule, key: string): PlannedSlot | null {
  return schedule.slots.find((s) => s.key === key) ?? null;
}

export function todaySchedule(): Schedule | null {
  return readSchedule(istDateKey());
}
