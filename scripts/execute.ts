#!/usr/bin/env bun
/**
 * Script 2 — executor. Several crons fire per slot, spread from 37 min before
 * it to 131 min after (see execute.yml). Whichever one lands first reads
 * today's committed schedule, sleeps until the slot's planned sendAt, sends the
 * broadcast, polls the campaign to a terminal status, and writes the outcome
 * back into the schedule file. The rest read status "sent" and skip.
 *
 * Firing early is what makes the sleep useful. GitHub's schedule queue is
 * best-effort and was measured 30 min late on 2026-08-22 — longer than that
 * day's jitter, so there was no wait left to absorb it with. A 37 min lead puts
 * the lag in dead time instead.
 *
 * Idempotent: a slot already marked "sent" is skipped, so neither a rerun nor
 * the sibling trigger can double-push. That rests on reading a CURRENT
 * schedule file — see `ref: main` in execute.yml and `sentWhileSleeping` below.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sendCampaign, waitForCampaign, type Campaign } from "./lib/api.ts";
import { writeJSONAtomic } from "./lib/io.ts";
import { notify } from "./lib/ntfy.ts";
import { istDateKey, istISO, istInstant } from "./lib/time.ts";
import type { PlannedSlot, Schedule } from "./lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
/** How far past its slot time a run may still claim a slot. */
const CLAIM_WINDOW_MIN = 150;
/**
 * How far BEFORE its slot time a run may claim a slot. The primary cron fires
 * 37 min early on purpose, so this has to clear that with room to spare.
 */
const EARLY_WINDOW_MIN = 45;
/**
 * Refuse to sit on a runner for longer than this waiting for sendAt.
 * 37 min of deliberate lead + 30 min of maximum jitter = 67, so 75 covers the
 * worst legitimate case and still trips on a genuinely wrong schedule date.
 */
const MAX_WAIT_MIN = 75;
/**
 * Delivery is judged on the failure RATE, not on the campaign status string.
 *
 * Every one of the 41 campaigns in the admin dashboard's send history
 * (21 Jun - 10 Aug 2026) came to rest at "partial"; not one reached
 * "completed". A broadcast to the whole base always hits some dead FCM token,
 * so the backend never reports a clean sweep. Anything-but-completed = failed
 * would therefore mark every push failed, page the fail topic five times a
 * day, and - worse - leave slot.status at "failed", so a rerun of the same
 * cron would send the slot a second time.
 *
 * That history puts the normal failure band at 0.27-4.79%. The one outlier was
 * 48.5% on 21 Jun, when a large cohort of dead tokens was pruned in a single
 * send: targeted fell 3891 -> 2025 on the very next campaign three hours later.
 * 10% sits clear of the normal band and still catches that.
 */
const FAIL_RATE_ALERT = (() => {
  // Actions always defines the env key, so an unset variable arrives as "" — and
  // `??` does not catch that. Number("") is 0, which would put the threshold at
  // 0% and page the fail topic on every send.
  const raw = (process.env.FAIL_RATE_ALERT ?? "").trim();
  const pct = raw === "" ? 10 : Number(raw);
  return (Number.isFinite(pct) && pct > 0 ? pct : 10) / 100;
})();
/**
 * A single-recipient test send targets ONE user id instead of the whole base.
 * The backend's audience contract is mode `all | segment | tokens | userIds |
 * names` with a parallel `userIds` array, and it has no dry-run — so the only
 * protection against a mistyped mode fanning out to everyone is to check what
 * came back. One user can hold several device tokens, so a handful of
 * recipients is normal; anything past this is treated as a runaway.
 */
const TEST_MAX_RECIPIENTS = 25;

function minutesBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 60_000;
}

/**
 * Which slot does this run belong to? Nearest slot whose scheduled wall-clock
 * time is within the claim window of now — GitHub's cron is routinely 5–15 min
 * late (30 min observed), so exact matching would strand runs.
 *
 * Nearest-wins keeps the early window safe: at 20:53 IST the 21:30 slot scores
 * -37 and the 19:00 slot +113, so an early fire cannot steal the previous slot.
 */
function resolveSlot(schedule: Schedule, now: Date): PlannedSlot | null {
  const override = process.env.SLOT_KEY;
  if (override) {
    const s = schedule.slots.find((x) => x.key === override);
    if (!s)
      throw new Error(`SLOT_KEY="${override}" is not in ${schedule.date}.json`);
    return s;
  }
  const scored = schedule.slots
    .map((s) => ({
      s,
      lateMin: minutesBetween(now, istInstant(schedule.date, s.slotAt)),
    }))
    .filter(
      (x) => x.lateMin >= -EARLY_WINDOW_MIN && x.lateMin <= CLAIM_WINDOW_MIN,
    )
    .sort((a, b) => Math.abs(a.lateMin) - Math.abs(b.lateMin));

  // Not an error, and deliberately not a page. With several triggers per slot
  // a mistimed one is an ordinary outcome, and this run cannot tell "GitHub
  // dequeued me 10 h late" from "the day is already handled" — on 2026-08-27
  // and -28 every trigger fired around 01:00 IST, so both days threw here and
  // paged the fail topic while the actual defect (the slot still sitting at
  // status "planned") went unreported. Exit 0 and leave the fail topic for
  // things a send can actually go wrong at.
  if (scored.length === 0) {
    const times = schedule.slots.map((s) => s.slotAt).join(", ");
    console.warn(
      `[exec] no slot near ${istISO(now)} in ${schedule.date}.json (slots: ${times}). Cron fired ` +
        `far outside every window, or the schedule date is not today; ` +
        `set SLOT_KEY to run one deliberately. Nothing to do.`,
    );
    return null;
  }
  return scored[0].s;
}

/**
 * Did another run send this slot while we slept? Re-reads the slot's status
 * from the remote rather than trusting the file checked out before the wait.
 *
 * Normally redundant, and deliberately so. `ref: main` means the checkout was
 * current, and the workflow's `concurrency` group means two executor runs never
 * overlap — so on-disk is already authoritative. This is the belt to that
 * braces: if the group is ever dropped, or two runs do overlap, a sleeping run
 * is holding a file that predates the other one's send. One fetch is cheap
 * against 6.5k duplicate pushes.
 *
 * Reads FETCH_HEAD, not origin/main: FETCH_HEAD is written by every fetch
 * regardless of how the remote's refspec is configured.
 *
 * Fail-soft on purpose. A git or network error here must never become a MISSED
 * push, so anything unexpected logs and lets the send go ahead.
 */
function sentWhileSleeping(date: string, slotKey: string): string | null {
  try {
    execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", "main"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10_000,
    });
    const raw = execFileSync(
      "git",
      ["show", `FETCH_HEAD:schedules/${date}.json`],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const fresh = JSON.parse(raw) as Schedule;
    const remote = fresh.slots.find((x) => x.key === slotKey);
    if (remote?.status === "sent")
      return remote.result?.campaignId ?? "unknown";
    return null;
  } catch (err) {
    console.warn(
      `[exec] could not re-check the remote schedule before sending: ${(err as Error).message}`,
    );
    return null;
  }
}

async function sendWithRetry(
  slot: PlannedSlot,
  schedule: Schedule,
  audience: PlannedSlot["audience"] = slot.audience,
) {
  const payload = {
    audience,
    title: slot.title,
    body: slot.body,
    route: slot.route,
    data: {
      slot: slot.key,
      scheduleDate: schedule.date,
      copyId: slot.copyId,
      itemId: slot.item.id,
      source: "push_daily",
    },
    sentBy: "gha-daily-push",
  };
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await sendCampaign(payload);
      console.log(
        `[exec] queued campaign ${res.campaignId} · targeted ${res.targetedCount} · ${res.audienceDesc ?? ""}`,
      );
      return { res, attempts: attempt };
    } catch (e) {
      lastErr = e as Error;
      console.warn(
        `[exec] send attempt ${attempt}/3 failed: ${lastErr.message}`,
      );
      if (attempt < 3)
        await new Promise((r) => setTimeout(r, attempt * 15_000));
    }
  }
  throw lastErr ?? new Error("send failed");
}

/**
 * Test mode, read from the workflow's own inputs. Deliberately fails closed:
 * `single_user` with no id throws BEFORE the send rather than falling back to
 * the scheduled audience, because that fallback is a broadcast to the whole base.
 */
function resolveTestSend(): { userId: string } | null {
  const mode = (process.env.AUDIENCE_MODE || "schedule").trim();
  const userId = (process.env.TEST_USER_ID || "").trim();
  if (mode === "single_user") {
    if (!userId) {
      throw new Error(
        "AUDIENCE_MODE=single_user needs TEST_USER_ID — refusing to send. Without an id this " +
          "run would fall through to the scheduled audience, which is every notifiable user.",
      );
    }
    return { userId };
  }
  if (userId) {
    console.warn(
      `[exec] TEST_USER_ID="${userId}" ignored: AUDIENCE_MODE is "${mode}", not "single_user".`,
    );
  }
  return null;
}

async function main() {
  const test = resolveTestSend();
  const date = process.env.SCHEDULE_DATE || istDateKey();
  const path = join(ROOT, "schedules", `${date}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `no schedule for ${date} — schedules/${date}.json is missing. The midnight planner ` +
        `either failed or its commit never landed on the default branch.`,
    );
  }
  const schedule = JSON.parse(readFileSync(path, "utf8")) as Schedule;
  const now = new Date();
  const slot = resolveSlot(schedule, now);
  if (!slot) return;

  if (slot.status === "sent" && !test) {
    const r = slot.result;
    // Log only. Four of the five triggers are EXPECTED to land here on a
    // normal day, and pinging the ok topic each time buries the one ping that
    // means something — the send itself.
    console.log(
      `[exec] ${slot.key} already sent (campaign ${r?.campaignId}): ` +
        `${r?.sent ?? "?"} delivered, ${r?.failed ?? "?"} failed; nothing to do`,
    );
    return;
  }

  const sendAt = new Date(slot.sendAt);
  const waitMin = minutesBetween(sendAt, now);
  let lateBy = 0;
  if (test) {
    console.log(
      `[exec] TEST SEND · slot ${slot.key} · one recipient (${test.userId}) · jitter skipped`,
    );
  } else if (waitMin > 0) {
    if (waitMin > MAX_WAIT_MIN) {
      throw new Error(
        `sendAt ${slot.sendAt} is ${Math.round(waitMin)} min away — more than the ${MAX_WAIT_MIN} min ` +
          `this job will wait. Cron fired far too early for slot ${slot.key}.`,
      );
    }
    console.log(
      `[exec] ${slot.key}: waiting ${Math.round(waitMin)} min for jitter (sendAt ${slot.sendAt})`,
    );
    await new Promise((r) => setTimeout(r, waitMin * 60_000));

    const raced = sentWhileSleeping(date, slot.key);
    if (raced) {
      // Log only, same reasoning as the skip above.
      console.log(
        `[exec] ${slot.key} was sent by another run during this one's wait (campaign ${raced}); nothing to do`,
      );
      return;
    }
  } else {
    // Cron lag ate the jitter. Send now and record how late — never skip.
    lateBy = Math.round(-waitMin);
    console.warn(
      `[exec] ${slot.key}: ${lateBy} min past sendAt, sending immediately`,
    );
  }

  const audience = test
    ? { mode: "userIds", userIds: [test.userId] }
    : slot.audience;

  slot.result = { startedAt: istISO(new Date()), lateBy };
  let campaign: Campaign | null = null;
  try {
    const { res, attempts } = await sendWithRetry(slot, schedule, audience);
    if (test && res.targetedCount > TEST_MAX_RECIPIENTS) {
      // The send has already left — the backend fans out in a goroutine — so this
      // cannot prevent delivery, only make a wrong audience impossible to miss.
      await notify(
        "fail",
        "Nidra TEST SEND hit too many recipients",
        `Test send for ${slot.key} targeted ${res.targetedCount} recipients for user ` +
          `${test.userId}, over the ${TEST_MAX_RECIPIENTS} cap. Campaign ${res.campaignId}. ` +
          `Check that the backend still accepts audience mode "userIds" — an unrecognised ` +
          `mode may have resolved to every notifiable user.`,
        ["rotating_light"],
      );
      throw new Error(
        `test send targeted ${res.targetedCount} recipients (cap ${TEST_MAX_RECIPIENTS}) — ` +
          `audience mode "userIds" did not narrow to one user`,
      );
    }
    slot.result.campaignId = res.campaignId;
    slot.result.targeted = res.targetedCount;
    slot.result.attempts = attempts;
    campaign = await waitForCampaign(res.campaignId);
  } catch (e) {
    if (test) throw e; // Never record a test against the real slot.
    slot.status = "failed";
    slot.result.error = (e as Error).message;
    slot.result.finishedAt = istISO(new Date());
    writeJSONAtomic(path, schedule);
    throw e;
  }

  const failRate =
    campaign.targetedCount > 0
      ? campaign.failedCount / campaign.targetedCount
      : 0;
  // "failed", or a send that reached nobody, is the only real delivery failure.
  const delivered = campaign.status !== "failed" && campaign.sentCount > 0;

  slot.result.campaignStatus = campaign.status;
  slot.result.targeted = campaign.targetedCount;
  slot.result.sent = campaign.sentCount;
  slot.result.failed = campaign.failedCount;
  slot.result.failRatePct = Number((failRate * 100).toFixed(2));
  slot.result.finishedAt = istISO(new Date());

  if (test) {
    // The schedule file is the record of what the AUDIENCE received. A test send
    // is not that, and marking the slot "sent" would make the real push for this
    // slot skip itself for the rest of the day.
    const line =
      `${slot.item.title} · ${slot.copyId}\n"${slot.title}"\n${slot.body}\n\n` +
      `user ${test.userId} · ${campaign.sentCount} delivered · ${campaign.failedCount} failed ` +
      `of ${campaign.targetedCount} (status ${campaign.status})\n` +
      `Schedule file untouched — ${slot.key} will still send to everyone at ${slot.slotAt}.`;
    console.log(`[exec] TEST SEND complete: ${JSON.stringify(slot.result)}`);
    if (delivered) {
      await notify("ok", `Nidra TEST SEND ok · ${slot.key}`, line, [
        "test_tube",
      ]);
    } else {
      await notify(
        "fail",
        `Nidra TEST SEND ${campaign.status} · ${slot.key}`,
        line,
        ["rotating_light"],
      );
      process.exitCode = 1;
    }
    return;
  }

  slot.status = delivered ? "sent" : "failed";
  writeJSONAtomic(path, schedule);

  const detail =
    `${slot.item.title} · ${slot.copyId}\n"${slot.title}"\n${slot.body}\n\n` +
    `${campaign.sentCount} delivered · ${campaign.failedCount} failed of ${campaign.targetedCount} ` +
    `(${slot.result.failRatePct}%, status ${campaign.status})` +
    (lateBy
      ? `\nsent ${lateBy} min late (cron lag)`
      : ` · on time (${slot.jitterMin} min jitter)`);

  if (!delivered) {
    await notify(
      "fail",
      `Nidra ${slot.slotAt} ${campaign.status} · ${slot.key}`,
      detail,
      ["rotating_light"],
    );
    process.exitCode = 1;
  } else if (failRate > FAIL_RATE_ALERT) {
    // Delivered, but far outside the historical band — usually a batch of dead
    // tokens being pruned. Worth a look, not worth failing the run: the slot is
    // marked sent so a rerun cannot re-push it.
    await notify(
      "fail",
      `Nidra ${slot.slotAt} high failure rate · ${slot.key}`,
      `${slot.result.failRatePct}% of the audience did not receive this push ` +
        `(alert above ${Math.round(FAIL_RATE_ALERT * 100)}%).\n\n${detail}`,
      ["warning"],
    );
  } else {
    await notify("ok", `Nidra ${slot.slotAt} sent · ${slot.key}`, detail, [
      "bell",
    ]);
  }
}

main().catch(async (e) => {
  const msg = (e as Error).message;
  console.error(`[exec] FAILED: ${msg}`);
  await notify("fail", "Nidra push FAILED", msg, ["rotating_light"]);
  process.exit(1);
});
