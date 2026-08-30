#!/usr/bin/env bun
/**
 * Stage 2 — executor. Sends ONE slot's broadcast and records the outcome.
 *
 * Called by the scheduler the moment a planned slot reaches its sendAt, and on
 * demand from the dashboard. It no longer resolves which slot it belongs to,
 * sleeps out jitter, or re-reads a remote schedule: the caller owns the clock
 * and a single process owns the state.
 *
 * That apparatus existed only to survive GitHub's schedule queue, which
 * dequeued this job 4–12 h late on 2026-08-27/28/29 and lost three days of
 * pushes. A local tick fires on time, so the claim window, the five staggered
 * triggers, the concurrency group and the FETCH_HEAD re-read are all gone. What
 * replaces them is smaller and stronger: one process, one lock, and a durable
 * `sending` marker written before the broadcast leaves.
 *
 * Idempotency now rests on that marker. `sendSlot` refuses any slot not in
 * `planned` or `failed`, and writes `sending` to disk BEFORE calling the
 * backend — so a crash mid-send leaves evidence instead of ambiguity, and
 * recovery never has to guess whether 6.2k phones already buzzed.
 */
import { sendCampaign, waitForCampaign, type Campaign } from "./lib/api.ts";
import { writeJSONAtomic } from "./lib/io.ts";
import { notify } from "./lib/ntfy.ts";
import { istISO } from "./lib/time.ts";
import type { PlannedSlot, Schedule } from "./lib/types.ts";
import { schedulePath } from "../src/paths.ts";

/**
 * Delivery is judged on the failure RATE, not on the campaign status string.
 *
 * Every one of the 41 campaigns in the admin dashboard's send history
 * (21 Jun - 10 Aug 2026) came to rest at "partial"; not one reached
 * "completed". A broadcast to the whole base always hits some dead FCM token,
 * so the backend never reports a clean sweep. Anything-but-completed = failed
 * would therefore mark every push failed and page the fail topic daily.
 *
 * That history puts the normal failure band at 0.27-4.79%. The one outlier was
 * 48.5% on 21 Jun, when a large cohort of dead tokens was pruned in a single
 * send: targeted fell 3891 -> 2025 on the very next campaign three hours later.
 * 10% sits clear of the normal band and still catches that.
 */
const FAIL_RATE_ALERT = (() => {
  // An unset env var arrives as "" from Docker's env_file, and `??` does not
  // catch that. Number("") is 0, which would put the threshold at 0% and page
  // the fail topic on every send.
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

/** Statuses a send may legitimately start from. */
const SENDABLE = new Set(["planned", "failed"]);

export interface SendOptions {
  /** Send to one user id only. Never touches the slot's stored status. */
  testUserId?: string;
  /** Recorded on the result so the dashboard can show who fired it. */
  triggeredBy?: string;
}

export interface SendOutcome {
  delivered: boolean;
  campaign: Campaign | null;
  slot: PlannedSlot;
}

function minutesBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 60_000;
}

async function sendWithRetry(
  slot: PlannedSlot,
  schedule: Schedule,
  audience: PlannedSlot["audience"],
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
    sentBy: "vps-daily-push",
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

/** Persist the whole schedule. Small file, atomic rename — see lib/io.ts. */
function persist(schedule: Schedule): void {
  writeJSONAtomic(schedulePath(schedule.date), schedule);
}

/**
 * Send one slot and record what happened.
 *
 * The write order is the safety property, not an implementation detail:
 *
 *   1. status "sending" + startedAt          → persisted BEFORE the backend call
 *   2. campaignId, as soon as it comes back  → persisted immediately
 *   3. terminal status + delivery counts     → persisted at the end
 *
 * A crash between 1 and 2 leaves `sending` with no campaignId: the send may or
 * may not have been accepted, so recovery pages a human rather than risking a
 * second broadcast. A crash between 2 and 3 leaves a campaignId, which is
 * enough to resume polling with no send at all.
 */
export async function sendSlot(
  schedule: Schedule,
  slot: PlannedSlot,
  opts: SendOptions = {},
): Promise<SendOutcome> {
  const test = opts.testUserId ? { userId: opts.testUserId } : null;

  if (!test && !SENDABLE.has(slot.status)) {
    throw new Error(
      `${slot.key} on ${schedule.date} is status "${slot.status}" — refusing to send. ` +
        `Only "planned" or "failed" may be sent; anything else risks a second broadcast.`,
    );
  }

  const now = new Date();
  const lateBy = Math.max(
    0,
    Math.round(minutesBetween(now, new Date(slot.sendAt))),
  );

  if (test) {
    console.log(
      `[exec] TEST SEND · slot ${slot.key} · one recipient (${test.userId}) · schedule untouched`,
    );
  } else {
    if (lateBy > 0)
      console.warn(
        `[exec] ${slot.key}: ${lateBy} min past sendAt (${slot.sendAt})`,
      );
    slot.status = "sending";
    slot.result = { startedAt: istISO(now), lateBy };
    if (opts.triggeredBy) slot.result.triggeredBy = opts.triggeredBy;
    persist(schedule);
  }

  const audience = test
    ? { mode: "userIds", userIds: [test.userId] }
    : slot.audience;
  const result: NonNullable<PlannedSlot["result"]> = test
    ? { startedAt: istISO(now), lateBy: 0 }
    : slot.result!;

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
    result.campaignId = res.campaignId;
    result.targeted = res.targetedCount;
    result.attempts = attempts;
    // Persist the campaign id before the long poll: it is what lets a crash
    // here be recovered by resuming rather than resending.
    if (!test) persist(schedule);
    campaign = await waitForCampaign(res.campaignId);
  } catch (e) {
    if (test) throw e; // Never record a test against the real slot.
    slot.status = "failed";
    result.error = (e as Error).message;
    result.finishedAt = istISO(new Date());
    persist(schedule);
    throw e;
  }

  return test
    ? await finishTest(slot, campaign, test.userId, result)
    : await finishReal(schedule, slot, campaign, result);
}

/**
 * Resume a slot left at `sending` WITH a campaign id: poll the existing
 * campaign to its terminal status and record it. Sends nothing.
 */
export async function resumeSlot(
  schedule: Schedule,
  slot: PlannedSlot,
): Promise<SendOutcome> {
  const result = slot.result ?? { startedAt: istISO(new Date()) };
  const id = result.campaignId;
  if (!id) throw new Error(`${slot.key} has no campaignId to resume`);
  console.warn(
    `[exec] resuming poll of campaign ${id} for ${slot.key} — no new send`,
  );
  const campaign = await waitForCampaign(id);
  return finishReal(schedule, slot, campaign, result);
}

function failRateOf(campaign: Campaign): number {
  return campaign.targetedCount > 0
    ? campaign.failedCount / campaign.targetedCount
    : 0;
}

function detailLines(
  slot: PlannedSlot,
  campaign: Campaign,
  result: NonNullable<PlannedSlot["result"]>,
): string {
  const late = result.lateBy
    ? `\nsent ${result.lateBy} min late`
    : ` · on time (${slot.jitterMin} min jitter)`;
  return (
    `${slot.item.title} · ${slot.copyId}\n"${slot.title}"\n${slot.body}\n\n` +
    `${campaign.sentCount} delivered · ${campaign.failedCount} failed of ${campaign.targetedCount} ` +
    `(${result.failRatePct}%, status ${campaign.status})${late}`
  );
}

async function finishReal(
  schedule: Schedule,
  slot: PlannedSlot,
  campaign: Campaign,
  result: NonNullable<PlannedSlot["result"]>,
): Promise<SendOutcome> {
  const failRate = failRateOf(campaign);
  // "failed", or a send that reached nobody, is the only real delivery failure.
  const delivered = campaign.status !== "failed" && campaign.sentCount > 0;

  result.campaignStatus = campaign.status;
  result.targeted = campaign.targetedCount;
  result.sent = campaign.sentCount;
  result.failed = campaign.failedCount;
  result.failRatePct = Number((failRate * 100).toFixed(2));
  result.finishedAt = istISO(new Date());

  slot.result = result;
  slot.status = delivered ? "sent" : "failed";
  persist(schedule);

  const detail = detailLines(slot, campaign, result);
  if (!delivered) {
    await notify(
      "fail",
      `Nidra ${slot.slotAt} ${campaign.status} · ${slot.key}`,
      detail,
      ["rotating_light"],
    );
  } else if (failRate > FAIL_RATE_ALERT) {
    // Delivered, but far outside the historical band — usually a batch of dead
    // tokens being pruned. Worth a look, not worth calling the send failed.
    await notify(
      "fail",
      `Nidra ${slot.slotAt} high failure rate · ${slot.key}`,
      `${result.failRatePct}% of the audience did not receive this push ` +
        `(alert above ${Math.round(FAIL_RATE_ALERT * 100)}%).\n\n${detail}`,
      ["warning"],
    );
  } else {
    await notify("ok", `Nidra ${slot.slotAt} sent · ${slot.key}`, detail, [
      "bell",
    ]);
  }
  return { delivered, campaign, slot };
}

async function finishTest(
  slot: PlannedSlot,
  campaign: Campaign,
  userId: string,
  result: NonNullable<PlannedSlot["result"]>,
): Promise<SendOutcome> {
  const failRate = failRateOf(campaign);
  const delivered = campaign.status !== "failed" && campaign.sentCount > 0;
  result.campaignStatus = campaign.status;
  result.targeted = campaign.targetedCount;
  result.sent = campaign.sentCount;
  result.failed = campaign.failedCount;
  result.failRatePct = Number((failRate * 100).toFixed(2));
  result.finishedAt = istISO(new Date());

  // The schedule file is the record of what the AUDIENCE received. A test send
  // is not that, and marking the slot "sent" would make the real push for this
  // slot skip itself for the rest of the day.
  const line =
    `${slot.item.title} · ${slot.copyId}\n"${slot.title}"\n${slot.body}\n\n` +
    `user ${userId} · ${campaign.sentCount} delivered · ${campaign.failedCount} failed ` +
    `of ${campaign.targetedCount} (status ${campaign.status})\n` +
    `Schedule file untouched — ${slot.key} will still send to everyone at ${slot.slotAt}.`;
  console.log(`[exec] TEST SEND complete: ${JSON.stringify(result)}`);
  await notify(
    delivered ? "ok" : "fail",
    `Nidra TEST SEND ${delivered ? "ok" : campaign.status} · ${slot.key}`,
    line,
    [delivered ? "test_tube" : "rotating_light"],
  );
  return { delivered, campaign, slot: { ...slot, result } };
}

// CLI use: `SLOT_KEY=... bun run scripts/execute.ts`. Reads the schedule off the
// volume, sends the named slot, exits non-zero on a delivery failure. The
// service itself calls sendSlot directly.
if (import.meta.main) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { istDateKey } = await import("./lib/time.ts");

  const run = async () => {
    const date = process.env.SCHEDULE_DATE || istDateKey();
    const path = schedulePath(date);
    if (!existsSync(path))
      throw new Error(`no schedule for ${date} — ${path} is missing`);
    const schedule = JSON.parse(readFileSync(path, "utf8")) as Schedule;

    const key = (process.env.SLOT_KEY || "").trim();
    if (!key)
      throw new Error(
        `SLOT_KEY is required (slots in ${date}: ${schedule.slots.map((s) => s.key).join(", ")})`,
      );
    const slot = schedule.slots.find((s) => s.key === key);
    if (!slot) throw new Error(`SLOT_KEY="${key}" is not in ${date}`);

    const mode = (process.env.AUDIENCE_MODE || "schedule").trim();
    const userId = (process.env.TEST_USER_ID || "").trim();
    if (mode === "single_user" && !userId) {
      throw new Error(
        "AUDIENCE_MODE=single_user needs TEST_USER_ID — refusing to send. Without an id this " +
          "run would fall through to the scheduled audience, which is every notifiable user.",
      );
    }
    if (mode !== "single_user" && userId) {
      console.warn(
        `[exec] TEST_USER_ID="${userId}" ignored: AUDIENCE_MODE is "${mode}", not "single_user".`,
      );
    }

    const out = await sendSlot(schedule, slot, {
      testUserId: mode === "single_user" ? userId : undefined,
      triggeredBy: "cli",
    });
    if (!out.delivered) process.exitCode = 1;
  };

  run().catch(async (e) => {
    const msg = (e as Error).message;
    console.error(`[exec] FAILED: ${msg}`);
    await notify("fail", "Nidra push FAILED", msg, ["rotating_light"]);
    process.exit(1);
  });
}
