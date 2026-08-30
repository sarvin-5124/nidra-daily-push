#!/usr/bin/env bun
/**
 * Stage 1 — schedule creator, called by the scheduler shortly after 00:00 IST
 * and on demand from the dashboard.
 *
 * Picks one catalog item and one copy variant per slot, rolls an independent
 * jitter per slot, and writes <DATA_DIR>/schedules/<IST date>.json. Content
 * picking is deterministic (date-seeded rotation), so a rerun for the same date
 * reproduces the same plan; only the jitter is genuinely random, and once
 * written it is fixed — the executor obeys the file, never re-rolls.
 *
 * config/ is read from the image (immutable, versioned in git); the schedule it
 * produces is written to the volume. See src/paths.ts for why those differ.
 */
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { ROOT, SCHEDULE_DIR, schedulePath } from "../src/paths.ts";
import { fetchCatalog, type CatalogItem, type CatalogKind } from "./lib/api.ts";
import { writeJSONAtomic } from "./lib/io.ts";
import { notify } from "./lib/ntfy.ts";
import { rotate, seedFrom, shuffled } from "./lib/rng.ts";
import {
  istDateKey,
  istDayIndex,
  istISO,
  istInstant,
  nextDateKey,
  prevDateKey,
} from "./lib/time.ts";
import type {
  CopyBank,
  PlannedSlot,
  Schedule,
  SlotConfig,
  SlotsConfig,
} from "./lib/types.ts";

const MAX_TITLE = 45;
const MAX_BODY = 120;

function readJSON<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;
}

/** Pool for a slot, after include / exclude / same-day exclusions. */
function poolFor(
  slot: SlotConfig,
  catalog: Map<CatalogKind, CatalogItem[]>,
  pickedSoFar: Map<string, string>,
  yesterday: Map<string, string>,
): CatalogItem[] {
  const all = catalog.get(slot.pool.kind) ?? [];
  const banned = new Set(slot.pool.exclude ?? []);
  for (const otherKey of slot.pool.excludeSlots ?? []) {
    const id = pickedSoFar.get(otherKey);
    if (id) banned.add(id);
  }
  let items = all.filter((i) => !banned.has(i.id));
  // Also avoid what this slot served yesterday. Rotation alone can't prevent it
  // where the pool composition shifts day to day (17:00 excludes the 10:00
  // pick, so its pool is a different pair each day). Dropped if it would leave
  // nothing.
  const prev = yesterday.get(slot.key);
  if (prev && items.length > 1 && items.some((i) => i.id === prev)) {
    items = items.filter((i) => i.id !== prev);
  }
  if (slot.pool.include?.length) {
    const allow = new Set(slot.pool.include);
    items = items.filter((i) => allow.has(i.id));
  }
  if (items.length === 0) {
    // Fall back to the unfiltered kind rather than dropping the slot: a missing
    // push is worse than a same-day repeat.
    console.warn(
      `[plan] ${slot.key}: pool empty after filters, falling back to all ${slot.pool.kind}`,
    );
    return all.filter((i) => !new Set(slot.pool.exclude ?? []).has(i.id));
  }
  return items;
}

function substitute(s: string, item: CatalogItem): string {
  return s
    .replaceAll("{item}", item.title ?? item.id)
    .replaceAll(
      "{min}",
      item.durationMin != null ? String(item.durationMin) : "",
    );
}

/**
 * Rotation pick over the copy variants, skipping any that blow the length
 * limits once the item name is substituted in.
 */
function pickCopy(
  bank: CopyBank,
  copySlot: string,
  dayIndex: number,
  item: CatalogItem,
): { copyId: string; title: string; body: string } {
  const variants = bank.slots[copySlot]?.variants;
  if (!variants?.length)
    throw new Error(`copybank has no variants for slot "${copySlot}"`);

  // Fixed permutation stepped one per day — same reasoning as rotate() in
  // lib/rng.ts: a per-cycle reshuffle repeats across the boundary.
  const perm = shuffled(variants, seedFrom(`copy:${copySlot}`));
  const start = ((dayIndex % perm.length) + perm.length) % perm.length;

  for (let i = 0; i < perm.length; i++) {
    const v = perm[(start + i) % perm.length];
    const title = substitute(v.title, item).trim();
    const body = substitute(v.body, item).trim();
    if (title.length <= MAX_TITLE && body.length <= MAX_BODY) {
      if (i > 0)
        console.warn(`[plan] ${copySlot}: skipped ${i} over-length variant(s)`);
      return { copyId: v.id, title, body };
    }
  }
  const v = perm[start];
  console.warn(
    `[plan] ${copySlot}: every variant is over-length for "${item.title}", using ${v.id} as-is`,
  );
  return {
    copyId: v.id,
    title: substitute(v.title, item).trim(),
    body: substitute(v.body, item).trim(),
  };
}

/**
 * Build and persist the schedule for one IST date, then ping the ok topic.
 *
 * Returns the schedule it wrote. Throws on any failure — the caller decides
 * whether that is worth paging for, because a missing schedule matters far more
 * at 13:00 than it does at 00:05 with a whole day left to retry.
 */
export async function buildSchedule(dateArg?: string): Promise<Schedule> {
  const cfg = readJSON<SlotsConfig>("config/slots.json");
  const bank = readJSON<CopyBank>("config/copybank.json");

  const date =
    dateArg || process.env.SCHEDULE_DATE || nextDateKey(istDateKey());
  const dayIndex = istDayIndex(date);

  // Yesterday's picks, when the file is there — best effort, absence is fine.
  const yesterday = new Map<string, string>();
  const prevPath = schedulePath(prevDateKey(date));
  if (existsSync(prevPath)) {
    try {
      const prev = JSON.parse(readFileSync(prevPath, "utf8")) as Schedule;
      for (const s of prev.slots) yesterday.set(s.key, s.item.id);
    } catch (e) {
      console.warn(
        `[plan] could not read ${prevPath}: ${(e as Error).message}`,
      );
    }
  }

  const kinds = [...new Set(cfg.slots.map((s) => s.pool.kind))];
  const catalog = new Map<CatalogKind, CatalogItem[]>();
  const fetched = await Promise.all(kinds.map((kind) => fetchCatalog(kind)));
  kinds.forEach((kind, i) => {
    const items = fetched[i];
    if (items.length === 0)
      throw new Error(`catalog "${kind}" came back empty`);
    catalog.set(kind, items);
    console.log(`[plan] catalog ${kind}: ${items.length} items`);
  });

  const picked = new Map<string, string>();
  const slots: PlannedSlot[] = [];

  for (const slot of cfg.slots) {
    const pool = poolFor(slot, catalog, picked, yesterday);
    const item = rotate(pool, dayIndex, `item:${slot.key}`);
    picked.set(slot.key, item.id);

    const copy = pickCopy(bank, slot.copySlot, dayIndex, item);
    // Independent roll per notification — inclusive of both bounds.
    const jitterMin = randomInt(
      cfg.jitterMinutes.min,
      cfg.jitterMinutes.max + 1,
    );
    const sendAt = istInstant(date, slot.at, jitterMin);

    slots.push({
      key: slot.key,
      slotAt: slot.at,
      jitterMin,
      sendAt: istISO(sendAt),
      item: {
        kind: slot.pool.kind,
        id: item.id,
        title: item.title ?? item.id,
        durationMin: item.durationMin ?? null,
      },
      copyId: copy.copyId,
      title: copy.title,
      body: copy.body,
      route: cfg.routeTemplate.replaceAll("{id}", item.id),
      audience: cfg.audience,
      status: "planned",
      result: null,
    });
  }

  const schedule: Schedule = {
    version: 1,
    date,
    tz: cfg.tz,
    generatedAt: istISO(new Date()),
    generatedBy: process.env.SERVICE_NAME
      ? `vps:${process.env.SERVICE_NAME}`
      : "local",
    slots,
  };

  if (!existsSync(SCHEDULE_DIR)) mkdirSync(SCHEDULE_DIR, { recursive: true });
  const out = schedulePath(date);
  writeJSONAtomic(out, schedule);

  const lines = slots.map(
    (s) =>
      `${s.sendAt.slice(11, 16)} · ${s.key} · ${s.item.title} · ${s.copyId} · "${s.title}"`,
  );
  console.log(`[plan] wrote ${out}\n${lines.join("\n")}`);
  await notify(
    "ok",
    `Nidra plan ready · ${date}`,
    `${slots.length} pushes planned\n\n${lines.join("\n")}`,
    ["calendar"],
  );
  return schedule;
}

// CLI use: `bun run scripts/plan.ts`. The long-running service imports
// buildSchedule directly and does its own error handling.
if (import.meta.main) {
  buildSchedule().catch(async (e) => {
    const msg = (e as Error).message;
    console.error(`[plan] FAILED: ${msg}`);
    await notify(
      "fail",
      "Nidra plan FAILED",
      `That day has no schedule — the executor will have nothing to send.\n\n${msg}`,
      ["rotating_light"],
    );
    process.exit(1);
  });
}
