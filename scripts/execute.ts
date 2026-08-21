#!/usr/bin/env bun
/**
 * Script 2 — executor. Cron fires near each slot (10:00, 14:00, 17:00, 19:00,
 * 21:30 IST); this reads today's committed schedule, waits out the remaining
 * jitter, sends the broadcast, polls the campaign to a terminal status, and
 * writes the outcome back into the schedule file.
 *
 * Idempotent: a slot already marked "sent" is skipped, so a rerun of the same
 * cron cannot double-push.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendCampaign, waitForCampaign, type Campaign } from './lib/api.ts';
import { notify } from './lib/ntfy.ts';
import { istDateKey, istISO, istInstant } from './lib/time.ts';
import type { PlannedSlot, Schedule } from './lib/types.ts';

const ROOT = join(import.meta.dirname, '..');
/** How far past its slot time a run may still claim a slot. */
const CLAIM_WINDOW_MIN = 150;
/** Refuse to sit on a runner for longer than this waiting for sendAt. */
const MAX_WAIT_MIN = 45;
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
  const raw = (process.env.FAIL_RATE_ALERT ?? '').trim();
  const pct = raw === '' ? 10 : Number(raw);
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
 * late, so exact matching would strand runs.
 */
function resolveSlot(schedule: Schedule, now: Date): PlannedSlot {
  const override = process.env.SLOT_KEY;
  if (override) {
    const s = schedule.slots.find((x) => x.key === override);
    if (!s) throw new Error(`SLOT_KEY="${override}" is not in ${schedule.date}.json`);
    return s;
  }
  const scored = schedule.slots
    .map((s) => ({ s, lateMin: minutesBetween(now, istInstant(schedule.date, s.slotAt)) }))
    .filter((x) => x.lateMin >= -20 && x.lateMin <= CLAIM_WINDOW_MIN)
    .sort((a, b) => Math.abs(a.lateMin) - Math.abs(b.lateMin));

  if (scored.length === 0) {
    const times = schedule.slots.map((s) => s.slotAt).join(', ');
    throw new Error(
      `no slot near ${istISO(now)} in ${schedule.date}.json (slots: ${times}). Cron fired far ` +
        `outside every window, or the schedule date is not today; ` +
        `set SLOT_KEY to run one deliberately.`,
    );
  }
  return scored[0].s;
}

async function sendWithRetry(
  slot: PlannedSlot,
  schedule: Schedule,
  audience: PlannedSlot['audience'] = slot.audience,
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
      source: 'push_daily',
    },
    sentBy: 'gha-daily-push',
  };
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await sendCampaign(payload);
      console.log(
        `[exec] queued campaign ${res.campaignId} · targeted ${res.targetedCount} · ${res.audienceDesc ?? ''}`,
      );
      return { res, attempts: attempt };
    } catch (e) {
      lastErr = e as Error;
      console.warn(`[exec] send attempt ${attempt}/3 failed: ${lastErr.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 15_000));
    }
  }
  throw lastErr ?? new Error('send failed');
}

/**
 * Test mode, read from the workflow's own inputs. Deliberately fails closed:
 * `single_user` with no id throws BEFORE the send rather than falling back to
 * the scheduled audience, because that fallback is a broadcast to the whole base.
 */
function resolveTestSend(): { userId: string } | null {
  const mode = (process.env.AUDIENCE_MODE || 'schedule').trim();
  const userId = (process.env.TEST_USER_ID || '').trim();
  if (mode === 'single_user') {
    if (!userId) {
      throw new Error(
        'AUDIENCE_MODE=single_user needs TEST_USER_ID — refusing to send. Without an id this ' +
          'run would fall through to the scheduled audience, which is every notifiable user.',
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
  const path = join(ROOT, 'schedules', `${date}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `no schedule for ${date} — schedules/${date}.json is missing. The midnight planner ` +
        `either failed or its commit never landed on the default branch.`,
    );
  }
  const schedule = JSON.parse(readFileSync(path, 'utf8')) as Schedule;
  const now = new Date();
  const slot = resolveSlot(schedule, now);

  if (slot.status === 'sent' && !test) {
    const r = slot.result;
    console.log(`[exec] ${slot.key} already sent (campaign ${r?.campaignId}); nothing to do`);
    await notify(
      'info',
      `Nidra ${slot.key} already sent`,
      `Skipped duplicate run for ${date}. Campaign ${r?.campaignId}: ${r?.sent ?? '?'} delivered, ${r?.failed ?? '?'} failed.`,
      ['repeat'],
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
    console.log(`[exec] ${slot.key}: waiting ${Math.round(waitMin)} min for jitter (sendAt ${slot.sendAt})`);
    await new Promise((r) => setTimeout(r, waitMin * 60_000));
  } else {
    // Cron lag ate the jitter. Send now and record how late — never skip.
    lateBy = Math.round(-waitMin);
    console.warn(`[exec] ${slot.key}: ${lateBy} min past sendAt, sending immediately`);
  }

  const audience = test
    ? { mode: 'userIds', userIds: [test.userId] }
    : slot.audience;

  slot.result = { startedAt: istISO(new Date()), lateBy };
  let campaign: Campaign | null = null;
  try {
    const { res, attempts } = await sendWithRetry(slot, schedule, audience);
    if (test && res.targetedCount > TEST_MAX_RECIPIENTS) {
      // The send has already left — the backend fans out in a goroutine — so this
      // cannot prevent delivery, only make a wrong audience impossible to miss.
      await notify(
        'fail',
        'Nidra TEST SEND hit too many recipients',
        `Test send for ${slot.key} targeted ${res.targetedCount} recipients for user ` +
          `${test.userId}, over the ${TEST_MAX_RECIPIENTS} cap. Campaign ${res.campaignId}. ` +
          `Check that the backend still accepts audience mode "userIds" — an unrecognised ` +
          `mode may have resolved to every notifiable user.`,
        ['rotating_light'],
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
    slot.status = 'failed';
    slot.result.error = (e as Error).message;
    slot.result.finishedAt = istISO(new Date());
    writeFileSync(path, JSON.stringify(schedule, null, 2) + '\n', 'utf8');
    throw e;
  }

  const failRate = campaign.targetedCount > 0 ? campaign.failedCount / campaign.targetedCount : 0;
  // "failed", or a send that reached nobody, is the only real delivery failure.
  const delivered = campaign.status !== 'failed' && campaign.sentCount > 0;

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
      await notify('ok', `Nidra TEST SEND ok · ${slot.key}`, line, ['test_tube']);
    } else {
      await notify('fail', `Nidra TEST SEND ${campaign.status} · ${slot.key}`, line, ['rotating_light']);
      process.exitCode = 1;
    }
    return;
  }

  slot.status = delivered ? 'sent' : 'failed';
  writeFileSync(path, JSON.stringify(schedule, null, 2) + '\n', 'utf8');

  const detail =
    `${slot.item.title} · ${slot.copyId}\n"${slot.title}"\n${slot.body}\n\n` +
    `${campaign.sentCount} delivered · ${campaign.failedCount} failed of ${campaign.targetedCount} ` +
    `(${slot.result.failRatePct}%, status ${campaign.status})` +
    (lateBy ? `\nsent ${lateBy} min late (cron lag)` : ` · on time (${slot.jitterMin} min jitter)`);

  if (!delivered) {
    await notify('fail', `Nidra ${slot.slotAt} ${campaign.status} · ${slot.key}`, detail, ['rotating_light']);
    process.exitCode = 1;
  } else if (failRate > FAIL_RATE_ALERT) {
    // Delivered, but far outside the historical band — usually a batch of dead
    // tokens being pruned. Worth a look, not worth failing the run: the slot is
    // marked sent so a rerun cannot re-push it.
    await notify(
      'fail',
      `Nidra ${slot.slotAt} high failure rate · ${slot.key}`,
      `${slot.result.failRatePct}% of the audience did not receive this push ` +
        `(alert above ${Math.round(FAIL_RATE_ALERT * 100)}%).\n\n${detail}`,
      ['warning'],
    );
  } else {
    await notify('ok', `Nidra ${slot.slotAt} sent · ${slot.key}`, detail, ['bell']);
  }
}

main().catch(async (e) => {
  const msg = (e as Error).message;
  console.error(`[exec] FAILED: ${msg}`);
  await notify('fail', 'Nidra push FAILED', msg, ['rotating_light']);
  process.exit(1);
});
