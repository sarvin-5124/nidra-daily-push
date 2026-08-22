import { writeFileSync, renameSync } from "node:fs";

/**
 * Write JSON via temp file + rename. A plain writeFileSync truncates the
 * target before the new bytes land; a kill mid-write (OOM, job timeout,
 * SIGTERM on cancel) leaves corrupt JSON at `path` that the next run treats
 * as the source of truth. rename() on the same filesystem is atomic, so
 * readers only ever see the old file or the fully-written new one.
 */
export function writeJSONAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
