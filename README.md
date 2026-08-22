# nidra-daily-push

Two GitHub Actions jobs that drive Nidra's five daily broadcast notifications.
Status of every run is pushed to [ntfy](https://ntfy.sh) — success and failure on
separate topics.

```
00:00 IST  plan-next-day   ──▶ schedules/YYYY-MM-DD.json  (committed)
                                        │
10:00 / 14:00 / 17:00 / 19:00 / 21:30   ▼
  (each fired twice: -37 min, -1 min)
           execute-slot    ──▶ sleep to sendAt ──▶ POST /admin/notifications/send ──▶ FCM
                            ──▶ poll campaign ──▶ result written back into the same file
```

## The two scripts

**`scripts/plan.ts` — planner, 00:00 IST.** For each of the five slots it picks
one catalog item and one copy variant, rolls that slot's jitter, and writes
`schedules/<tomorrow>.json`. Item and copy picking are deterministic (date-seeded
rotation), so re-planning the same date reproduces the same plan. The jitter is
the one random value, and once written it is fixed — the executor never re-rolls
it, which is what makes the exact send times knowable a day in advance.

**`scripts/execute.ts` — executor, ten triggers a day for five sends.** Resolves
which slot this run belongs to from the wall clock, sleeps until that slot's
planned `sendAt`, sends the campaign, polls it to a terminal status, and writes
the outcome back into the schedule file. A slot already marked `sent` is skipped,
so neither a rerun nor the slot's sibling trigger can double-push. Two triggers
per slot because GitHub's scheduler is unreliable — see **Jitter** below.

## Slots

| IST | Slot key | Pool | Notes |
|---|---|---|---|
| 10:00 | `morning_focus` | `med-focus-breathing`, `med-yognidra` | fixed pair |
| 14:00 | `afternoon_soundscape` | all soundscapes | |
| 17:00 | `evening_meditation` | all meditations **minus that day's 10:00 pick** | |
| 19:00 | `evening_soundscape` | all soundscapes minus the 14:00 pick | |
| 21:30 | `night_nidra` | sessions, `power-nap` excluded | |

Everything above lives in `config/slots.json` — pools, exclusions, jitter bounds,
audience, and the deep-link template. No code change needed to retune it.

## Jitter

Each notification gets its own independent roll in `[5, 30]` minutes, added to
the slot's wall-clock time. So 21:30 sends somewhere in 21:35–22:00, and the five
slots on a given day are unrelated to each other.

GitHub's cron is best-effort. The executor absorbs the lag instead of
compounding it: it waits until the planned `sendAt`, and if cron was so late that
`sendAt` has already passed, it sends immediately and records `lateBy` in the
result rather than skipping the push.

That only works while there is still wait left to give up. On 2026-08-22 the
`30 4` trigger started at **05:00:00Z — 30 minutes late**, past that day's
`sendAt` of 10:16 IST, and the 10:00 push went out only because it was fired by
hand. So each slot now has **two** triggers, neither on `:00` or `:30` (the two
most contended minutes on the platform):

| Slot | primary, −37 min | backstop, −1 min |
|---|---|---|
| 10:00 IST | `53 3` | `29 4` |
| 14:00 IST | `53 7` | `29 8` |
| 17:00 IST | `53 10` | `29 11` |
| 19:00 IST | `53 12` | `29 13` |
| 21:30 IST | `23 15` | `59 15` |

The primary fires 37 minutes before the slot so that lag lands in dead time
rather than eating the jitter; the job then sleeps until `sendAt` as before. The
backstop covers the primary arriving after `sendAt` or being dropped outright —
[the docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
allow queued runs to be dropped under load, and no amount of sleeping saves a run
that never starts.

**Two triggers cannot double-send.** `concurrency: nidra-execute` serialises
them, so they never run at once; the loser then reads `status: "sent"` and skips.
That guard depends on reading a *current* schedule file, which is why the
checkout pins `ref: main` rather than the event SHA — a scheduled run pins the
default-branch head as it stood when the run was *created*, and the backstop is
created before the primary sends. On the default ref the backstop would dequeue
after the primary's `"sent"` commit and still check out the pre-send file. The
executor also re-reads the slot's status from the remote after a long sleep
(`sentWhileSleeping`), fail-soft, as a second line of defence.

One hole remains, and it predates this: if a send succeeds but
`commit-schedules.sh` exhausts its 3 push attempts, nothing records `"sent"` and
the next run will legitimately re-send. Closing that needs an idempotency key on
`POST /admin/notifications/send`, which is the backend's call, not this repo's.

## Copy bank

`config/copybank.json` holds 40 title/body variants per slot. Copy may use two
placeholders — `{item}` (catalog title, e.g. `Rain`, `Yog Nidra`) and `{min}`
(duration in minutes). The planner walks a seeded permutation one step per day,
so a variant does not repeat for 40 days.

`scripts/validate-copybank.ts` gates the file and runs before every plan. It
checks variant counts and id format, that lengths hold against the **longest**
item title each slot can serve (title ≤ 45, body ≤ 120 graphemes), token
whitelist, at most one emoji per variant, no duplicate titles or bodies, and no
exclamation marks in `night_nidra`.

```bash
bun run validate     # NIDRA_API_URL set → checks against the live catalog
```

## Configuration

These five may be set as repository **variables** or **secrets** — the workflows
read `${{ vars.X || secrets.X }}`, so either tab works. Variables are easier to
debug, because a secret is masked as `***` everywhere in the logs.

| Name | Example |
|---|---|
| `NIDRA_API_URL` | HTTPS base URL of the backend, no trailing slash |
| `NTFY_BASE` | `https://ntfy.sh` |
| `NTFY_TOPIC_OK` | `nidra-push-ok-<random>` |
| `NTFY_TOPIC_FAIL` | `nidra-push-fail-<random>` |
| `FAIL_RATE_ALERT` | optional; percent, default `10` |

An unset variable arrives at the script as an **empty string**, not as absent —
Actions always defines the env key. Anything reading one has to treat `""` as
unset, which is why `FAIL_RATE_ALERT` parses empty and non-numeric values back to
its 10% default instead of using `??`.

Repository **secrets**:

| Name | Notes |
|---|---|
| `NIDRA_ADMIN_USER` | admin Basic auth user |
| `NIDRA_ADMIN_PASS` | admin Basic auth password |
| `NTFY_TOKEN` | optional; only for a protected ntfy topic |

### Two things worth knowing about this setup

**The backend URL must be HTTPS.** These jobs authenticate with HTTP Basic, which
is base64 — not encryption. Over plain `http://` the admin credentials travel
readable across the public internet on every run, six times a day, from GitHub's
shared runners. Point `NIDRA_API_URL` at an HTTPS host.

**A campaign never reaches `completed`, and that is normal.** All 41 broadcasts in
the admin dashboard's history came to rest at `partial` — a send to the whole base
always hits a dead FCM token. So delivery is judged on the failure *rate*, not the
status string: `failed`, or a send that reached nobody, is a failure; anything else
is a delivered push. A rate above `FAIL_RATE_ALERT` (default 10%, against a
historical normal band of 0.3–4.8%) pings the fail topic but leaves the slot marked
`sent` and the run green — those spikes are dead tokens being pruned, and a slot
that is not `sent` would be re-pushed by a rerun. See
`learnings/push-send-history-signals.md`.

**Public ntfy topics are readable and writable by anyone who knows the name.** On
`ntfy.sh` a topic is not access-controlled by default: anyone who guesses
`nidra-push-ok` can subscribe to it and can publish to it. The pings carry
notification copy and delivery counts — no credentials, no user data — but a
stranger could also post fake "all sent" messages into the same topic. Either
accept that, or run reserved topics with a token in `NTFY_TOKEN`.

## Running by hand

```bash
export NIDRA_API_URL=https://api.nidra.app
export NIDRA_ADMIN_USER=… NIDRA_ADMIN_PASS=…
export NTFY_TOPIC_OK=nidra-push-ok NTFY_TOPIC_FAIL=nidra-push-fail

bun run plan                                  # plans tomorrow
SCHEDULE_DATE=2026-08-25 bun run plan         # plans a specific IST date
SLOT_KEY=night_nidra bun run execute          # sends one slot now
```

Both workflows also have `workflow_dispatch`, with the same overrides as inputs.

## Operational notes

- **Cron only runs on the default branch.** Changes to the schedule times or the
  scripts have to land on `main` to take effect.
- **A green run does not mean the cron was on time.** A run that finds its slot
  already sent exits successfully in ~10s, which is indistinguishable from a
  healthy skip. Lag *before* a job starts is invisible from inside it — the only
  witness is the run's `created_at` against the cron minute (`gh run list`).
  `lateBy` in the schedule file only measures lag after the job began.
- **GitHub disables scheduled workflows in a repo with 60 days of no commits.**
  The executor commits a result on every send, so this repo stays active on its
  own — but if sends stop, the crons eventually stop too. The fail topic going
  quiet is not proof that things are fine.
- **Schedule files are the audit log.** Each slot records `campaignId`,
  targeted/sent/failed counts, `attempts`, `lateBy`, and any error. Git history
  shows what was planned versus what actually went out.
- **Five a day is new for this audience.** The 41 hand-sent campaigns before this
  averaged 0.8 pushes a day and skipped half the days; 10:00 and 14:00 have carried
  one push each ever. Volume, and the fact that 68% of those campaigns carried an
  image while these carry none, are product calls this repo does not make on its own.
- **A missing schedule file fails loudly.** If the midnight planner failed, the
  10:00 executor pings the fail topic instead of sending something improvised.
- **Cron lag is documented behaviour, not a bug to chase.** See
  `learnings/github-cron-lag.md` for the 2026-08-22 incident and the numbers.
