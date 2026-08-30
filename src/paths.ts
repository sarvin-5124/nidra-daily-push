/**
 * Where mutable state lives, and how it gets there on a cold container.
 *
 * The repo checkout is read-only as far as this service is concerned: it holds
 * config/ and the code, both baked into the image at build time. Everything the
 * scheduler WRITES goes to DATA_DIR, a Docker volume, so a redeploy (which
 * rebuilds the image from a fresh `git pull`) cannot roll state backwards.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");
export const DATA_DIR = process.env.DATA_DIR || "/data";
export const SCHEDULE_DIR = join(DATA_DIR, "schedules");

/** Absolute path of the schedule file for an IST date key. */
export function schedulePath(date: string): string {
  return join(SCHEDULE_DIR, `${date}.json`);
}

/**
 * Create DATA_DIR and, on a genuinely empty volume, seed it from the schedules
 * committed in the repo.
 *
 * Without this the dashboard would open on a blank history the first time the
 * service is deployed, and the planner would lose the yesterday-picks input
 * that stops a slot repeating an item two days running. Only files MISSING from
 * the volume are copied, so this can never overwrite live state with the older
 * copy that the last mirror pushed to git.
 */
export function ensureDataDir(): void {
  mkdirSync(SCHEDULE_DIR, { recursive: true });
  const seedDir = join(ROOT, "schedules");
  if (!existsSync(seedDir)) return;
  let copied = 0;
  for (const name of readdirSync(seedDir)) {
    if (!name.endsWith(".json")) continue;
    const target = join(SCHEDULE_DIR, name);
    if (existsSync(target)) continue;
    copyFileSync(join(seedDir, name), target);
    copied++;
  }
  if (copied)
    console.log(
      `[data] seeded ${copied} schedule file(s) into ${SCHEDULE_DIR}`,
    );
}
