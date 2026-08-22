# GitHub Actions cron lag can be 30 min, not the documented "a few minutes"

## Observed (2026-08-22, morning_focus)
- Trigger `cron: '30 4 * * *'` (04:30 UTC = 10:00 IST) actually **started at 05:00:00 UTC**
  (10:30 IST) — run `32553178811`. Exactly 30 min late, landing precisely on the hour.
- Planned `sendAt` was 10:16 IST (jitter 16). The push therefore missed its window with
  nothing wrong in the repo: no failure, no log, no ntfy ping — the run simply did not exist yet.
- A manual `workflow_dispatch` at 10:25 IST sent it (`10 min past sendAt, sending immediately`,
  6152/6501, 5.37% fail). The cron run arrived at 10:30, saw `status: "sent"`, skipped in 11s,
  and reported **success**.

## Why this is invisible
- A skipped-because-already-sent run is a green run. Nothing in the repo distinguishes
  "cron was 30 min late" from "cron was on time and the slot was handled".
- `lateBy` only records lag *after* the run starts. Lag *before* the run starts is unobservable
  from inside the job — the only witness is `created_at` vs the cron minute, via
  `gh run list` / the API.

## What actually helps
- **`:00` and `:30` are the worst minutes to pick.** GitHub's shared scheduler queues by minute
  and those two are the most contended; the observed delay snapped the run to the next hour
  boundary. Use an odd minute (`:07`, `:23`).
- **Fire earlier than the slot, not on it.** The executor already sleeps out jitter, so an early
  trigger costs runner-idle minutes and buys slack. Doing this needs two constants widened in
  `scripts/execute.ts`: `resolveSlot`'s `lateMin >= -20` guard (how early a run may claim a slot)
  and `MAX_WAIT_MIN = 45` (how long it will sit waiting). 30 min early + 30 min jitter = 60 min.
- **A second cron per slot is free redundancy.** `concurrency: nidra-execute` plus the `sent`
  guard already make a double-send impossible, so two triggers per slot means whichever the
  scheduler honours first wins. Cheaper and more robust than widening the wait.
- **Alert on lateness, not just on failure.** `lateBy > 0`, or a run that finds the slot already
  sent, is the signal that the schedule is drifting. Today it produced silence.

## The fix applied (2026-08-22)
Two triggers per slot, neither on `:00` or `:30` — primary at −37 min, backstop at −1 min:

| Slot IST | primary | backstop |
|---|---|---|
| 10:00 | `53 3` | `29 4` |
| 14:00 | `53 7` | `29 8` |
| 17:00 | `53 10` | `29 11` |
| 19:00 | `53 12` | `29 13` |
| 21:30 | `23 15` | `59 15` |

Supporting changes in `scripts/execute.ts`: `EARLY_WINDOW_MIN = 45` (new; `resolveSlot`
previously hardcoded `lateMin >= -20`, which would have rejected a −37 min fire) and
`MAX_WAIT_MIN` 45 → 75 (37 lead + 30 max jitter = 67). `timeout-minutes` 60 → 100.

`resolveSlot` picks the nearest slot by `|lateMin|`, so firing 37 min early cannot steal the
previous slot even though `CLAIM_WINDOW_MIN` is 150: worst case is 20:53 IST, where
`night_nidra` scores −37 and `evening_soundscape` +113.

## The trap that adding a backstop creates: `actions/checkout` pins the EVENT SHA
This nearly turned one duplicate trigger into a duplicate broadcast to 6.5k users.

- `concurrency: nidra-execute` serialises the two triggers — they never run **simultaneously**.
  The danger is **sequential with stale data**.
- `actions/checkout`'s `ref` defaults to *"the reference or SHA for that event"*. For a
  `schedule` event that is the default-branch head **as it stood when the run was created** —
  not the tip at checkout time.
- The primary sleeps 37+ min holding the concurrency slot. The backstop is created *during*
  that sleep, so it pins the pre-send SHA, queues, and dequeues only after the primary's
  `"sent"` commit — then checks out its own stale SHA, reads `status: "planned"`, and sends again.
  The `status === 'sent'` guard is correct code reading a stale file; it never fires.
- Fix: `with: { ref: main }` on the checkout, which resolves the **branch** at checkout time.
  Any workflow whose idempotency depends on state a *sibling run* commits needs this.
- Second line of defence: `sentWhileSleeping()` re-fetches and re-reads the slot's status from
  `FETCH_HEAD` after the sleep, right before the POST. Reads `FETCH_HEAD` rather than
  `origin/main` because every fetch writes it regardless of the remote's configured refspec.
  Deliberately **fail-soft** — a git error must never convert into a *missed* push.

## Still open: a successful send whose commit never lands
If the send succeeds but `commit-schedules.sh` exhausts its 3 push attempts, nothing records
`"sent"`, and the next trigger legitimately re-sends. Predates the backstop (a rerun did the
same). No repo-side fix exists — it needs an idempotency key on
`POST /admin/notifications/send`, keyed on slot + date, on the backend.

## Verifying lag after the fact
`gh run list` shows the run's start, not the cron minute it was meant to serve. Compare
`created_at` against the cron expression:
`gh run list --workflow execute-slot --json createdAt,event,conclusion,databaseId`
