/**
 * Nightly mirror of the schedule volume back into the git repo.
 *
 * The volume is the source of truth — it is what the scheduler reads and
 * writes, and what survives a redeploy. This mirror exists for the other thing
 * the old GitHub-committed files gave us: a public, diffable, permanent record
 * of what was sent on which day, independent of this box. If the VPS is lost,
 * the history is still in git.
 *
 * Uses the Contents API rather than a `git push` from inside the container, on
 * purpose. A push needs a checkout, and the only checkout on the box is
 * /root/apps/nidra-daily-push — the same working tree the deploy step runs
 * `git pull` in. Committing into it from the container would put the mirror and
 * the deploy in conflict over the same index. One authenticated PUT per changed
 * file has no such coupling.
 */
import { readFileSync } from "node:fs";
import { istDateKey, istParts, prevDateKey } from "../scripts/lib/time.ts";
import { schedulePath } from "./paths.ts";
import { hasSchedule } from "./store.ts";

/** IST hour the mirror runs at. Well clear of the 00:00 planner. */
const MIRROR_HOUR = 2;
/** How many days back to keep in sync. Covers a few days of downtime. */
const MIRROR_DAYS = 14;

const REPO = process.env.GITHUB_REPO || "sarvin-5124/nidra-daily-push";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const TOKEN = process.env.GITHUB_TOKEN || "";
const API = "https://api.github.com";

export interface MirrorState {
  lastRunAt: string | null;
  lastRunDate: string | null;
  lastResult: string | null;
  filesPushed: number;
  enabled: boolean;
}

const state: MirrorState = {
  lastRunAt: null,
  lastRunDate: null,
  lastResult: null,
  filesPushed: 0,
  enabled: Boolean(TOKEN),
};

export function mirrorState(): MirrorState {
  return { ...state };
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function remoteFile(
  path: string,
): Promise<{ sha: string; text: string } | null> {
  const res = await fetch(
    `${API}/repos/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(BRANCH)}`,
    { headers: headers(), signal: AbortSignal.timeout(20_000) },
  );
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(
      `GET ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  const body = (await res.json()) as { sha: string; content?: string };
  const text = body.content
    ? Buffer.from(body.content, "base64").toString("utf8")
    : "";
  return { sha: body.sha, text };
}

async function putFile(
  path: string,
  text: string,
  sha: string | null,
  message: string,
) {
  const res = await fetch(`${API}/repos/${REPO}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      message,
      content: Buffer.from(text, "utf8").toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(
      `PUT ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
}

/** Push every changed schedule file from the last MIRROR_DAYS days. */
export async function mirrorNow(reason = "scheduled"): Promise<MirrorState> {
  state.lastRunAt = new Date().toISOString();
  if (!TOKEN) {
    state.lastResult = "skipped: GITHUB_TOKEN is not set";
    console.warn(`[mirror] ${state.lastResult}`);
    return mirrorState();
  }

  let date = istDateKey();
  let pushed = 0;
  let checked = 0;
  const errors: string[] = [];

  for (let i = 0; i < MIRROR_DAYS; i++, date = prevDateKey(date)) {
    if (!hasSchedule(date)) continue;
    const repoPath = `schedules/${date}.json`;
    checked++;
    try {
      const remote = await remoteFile(repoPath);
      // Read local AFTER the fetch, not before. Reading first and comparing
      // after the await meant the scheduler could write between the two: on
      // 2026-08-30 the boot mirror read today's file as "planned", the first
      // tick then marked it "missed", and the stale read matched the remote so
      // the change was skipped. The next nightly run picked it up, but the
      // window is avoidable — keep the read as close to the compare as it gets.
      const local = readFileSync(schedulePath(date), "utf8");
      if (remote && remote.text === local) continue;
      await putFile(
        repoPath,
        local,
        remote?.sha ?? null,
        `chore: mirror ${date} push result`,
      );
      pushed++;
      console.log(`[mirror] pushed ${repoPath}`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${date}: ${msg}`);
      console.error(`[mirror] ${date} failed: ${msg}`);
    }
  }

  state.lastRunDate = istDateKey();
  state.filesPushed = pushed;
  state.lastResult = errors.length
    ? `${pushed}/${checked} pushed, ${errors.length} failed — ${errors[0]}`
    : `${pushed}/${checked} pushed (${reason})`;
  console.log(`[mirror] ${state.lastResult}`);
  return mirrorState();
}

/**
 * Run the mirror at most once per IST day, at or after MIRROR_HOUR.
 *
 * Catch-up by design: if the service was down at 02:00 it mirrors on the next
 * tick after boot instead of skipping the day, because the whole point is that
 * the git copy is not allowed to silently fall behind.
 */
export async function maybeMirror(): Promise<void> {
  if (!TOKEN) return;
  const today = istDateKey();
  if (state.lastRunDate === today) return;
  if (istParts(new Date()).hh < MIRROR_HOUR) return;
  await mirrorNow("nightly").catch((e) =>
    console.error(`[mirror] run failed: ${(e as Error).message}`),
  );
}
