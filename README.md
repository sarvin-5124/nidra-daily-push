# nidra-daily-push

A single long-lived service on the VPS that plans and sends Nidra's daily
broadcast notifications, with an operations dashboard over the top. Status of
every send is pushed to [ntfy](https://ntfy.sh) — success and failure on separate
topics.

```
┌─ container: nidra-daily-push (VPS) ──────────────────────────────────┐
│                                                                      │
│  scheduler — 20 s tick, IST clock                                    │
│    ├─ today's schedule missing?     → plan it                        │
│    ├─ tomorrow's missing?           → plan it  (this is "00:00 IST") │
│    └─ a planned slot past sendAt?   → send it                        │
│                     │                                                │
│                     ▼                                                │
│   POST /admin/notifications/send → poll campaign → write result       │
│                     │                                                │
│                     ▼                                                │
│   /data/schedules/YYYY-MM-DD.json   (Docker volume, source of truth) │
│                     │                                                │
│         ┌───────────┴────────────┐                                   │
│         ▼                        ▼                                   │
│   dashboard on :3000       nightly mirror → git (02:00 IST)          │
└──────────────────────────────────────────────────────────────────────┘
```

## Why it is not on GitHub Actions any more

It used to be two scheduled workflows. On **2026-08-27, -28, -29 and -30** the
`schedule` event dequeued 4–12 hours late every single day; every trigger landed
outside its send window and **four consecutive days of pushes were lost**. The
last two days were lost *silently* — five green no-op runs, no page.

Adding more triggers did not help and could not have: all crons in a repo share
one queue, so they arrive late together. On 08-29 five triggers spread across
2 h 48 m of cron time were released inside a 55-minute window, all of them hours
past the slot.

The clock is now a 20-second tick inside this container (`src/scheduler.ts`), so
a slot fires within 20 s of its `sendAt`. GitHub's remaining jobs are hosting the
code, taking the manual deploy, and receiving the nightly mirror.

The lateness that remains is *downtime* — this box, this container — which is a
different problem with a different answer. A 14:00 push delivered at 21:00 is
worse than no push, so anything more than **60 minutes** past `sendAt` is
recorded as `missed` and paged, not sent.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | entry point: binds the port, starts the scheduler, drains on SIGTERM |
| `src/scheduler.ts` | the clock — planning, due-slot detection, crash recovery |
| `src/server.ts` | dashboard, read API, token-gated action routes |
| `src/store.ts` | schedule reads/writes on the volume |
| `src/mirror.ts` | nightly push of schedule files to git via the Contents API |
| `src/auth.ts` | bearer-token gate for every mutating route |
| `scripts/plan.ts` | `buildSchedule(date)` — picks item + copy, rolls jitter |
| `scripts/execute.ts` | `sendSlot(schedule, slot)` — sends one slot, records outcome |
| `public/` | the dashboard (no framework, no build step) |
| `config/` | slots, copy bank — baked into the image, versioned in git |

`config/` is read from the image; everything written goes to `DATA_DIR`
(`/data`, a Docker volume). A redeploy rebuilds the image from a fresh clone, so
state kept in the checkout would roll backwards — see `src/paths.ts`.

## Slots

| IST | Slot key | Pool | Notes |
|---|---|---|---|
| 10:00 | `morning_focus` | `med-focus-breathing`, `med-yognidra` | fixed pair |
| 14:00 | `afternoon_soundscape` | all soundscapes | **the only live slot** |
| 17:00 | `evening_meditation` | all meditations **minus that day's 10:00 pick** | parked |
| 19:00 | `evening_soundscape` | all soundscapes minus the 14:00 pick | parked |
| 21:30 | `night_nidra` | sessions, `power-nap` excluded | parked |

Everything above lives in `config/slots.json` — pools, exclusions, jitter bounds,
audience, and the deep-link template. Parked slots sit in `disabledSlots`; move
one back into `slots` to re-enable it. No code change needed.

## Jitter

Each notification gets its own independent roll in `[5, 30]` minutes, added to
the slot's wall-clock time, so 14:00 sends somewhere in 14:05–14:30. The roll
happens once, at plan time, and is then fixed — the executor obeys the file and
never re-rolls, which is what makes the exact send time knowable a day ahead.

Item and copy picking are deterministic (date-seeded rotation), so re-planning
the same date reproduces the same plan apart from the jitter.

## How a double-send is prevented

One process owns the schedule, so this is much smaller than it was. `sendSlot`
refuses any slot not in `planned` or `failed`, and the write order is the safety
property:

1. `status: "sending"` + `startedAt` — persisted **before** the backend call
2. `campaignId` — persisted the moment it comes back
3. terminal status + delivery counts — persisted at the end

A crash between 1 and 2 leaves `sending` with no campaign id: the send may or may
not have been accepted, so startup **pages a human and changes nothing** rather
than risk a second broadcast to the whole base. A crash between 2 and 3 leaves a
campaign id, which is enough to resume the poll with no send at all. Both the
tick and the dashboard's manual send go through one in-memory lock.

One hole remains, and it predates the migration: a send that succeeds while the
result write fails leaves no record. Closing it needs an idempotency key on
`POST /admin/notifications/send` keyed on `data.slot` + `data.scheduleDate` —
both already in the payload. That is the backend's call, not this repo's.

## The dashboard

Served at `/`. Read routes are open; the repo it mirrors to is public, so the
schedule, the copy and the delivery counts are already open information.

Everything that changes state is behind `DASHBOARD_TOKEN` as a bearer token:

| Route | Does |
|---|---|
| `GET /api/status` | today, next slot, scheduler + mirror health |
| `GET /api/history?days=30` | past schedules |
| `GET /healthz` | 503 once the tick loop stops advancing |
| `GET /api/logs` | **auth** — in-memory log tail |
| `POST /api/actions/send` | **auth** — send a slot now (`mode: single_user` for a rehearsal) |
| `POST /api/actions/plan` | **auth** — build or rebuild a day |
| `POST /api/actions/resolve` | **auth** — close out a slot stuck at `sending` |
| `POST /api/actions/mirror` | **auth** — mirror to git now |

`Send to everyone` also makes the operator type the slot key back before it
fires. There is no undo on a broadcast.

## Copy bank

`config/copybank.json` holds 40 title/body variants per slot. Copy may use two
placeholders — `{item}` (catalog title, e.g. `Rain`, `Yog Nidra`) and `{min}`
(duration in minutes). The planner walks a seeded permutation one step per day,
so a variant does not repeat for 40 days.

`scripts/validate-copybank.ts` gates the file. It checks variant counts and id
format, that lengths hold against the **longest** item title each slot can serve
(title ≤ 45, body ≤ 120 graphemes), token whitelist, at most one emoji per
variant, no duplicate titles or bodies, and no exclamation marks in
`night_nidra`.

```bash
bun run validate     # NIDRA_API_URL set → checks against the live catalog
```

## Configuration

Values come from secrets-manager at deploy time, prefixed `NIDRA_DAILY_PUSH_`
(repo name uppercased, hyphens to underscores). The prefix is stripped before it
reaches the container, so `NIDRA_DAILY_PUSH_NTFY_BASE` populates `NTFY_BASE`.
See `.env.example` for the full list.

| Name | Notes |
|---|---|
| `NIDRA_API_URL` | HTTPS base URL of the backend, no trailing slash |
| `NIDRA_ADMIN_USER` / `NIDRA_ADMIN_PASS` | admin Basic auth |
| `NTFY_BASE` / `NTFY_TOPIC_OK` / `NTFY_TOPIC_FAIL` / `NTFY_TOKEN` | status pings |
| `DASHBOARD_TOKEN` | the only guard on the broadcast route — 32+ random chars |
| `DASHBOARD_URL` | included in ntfy pings so a page links back |
| `GITHUB_TOKEN` | fine-grained PAT, this repo, Contents r/w — mirror is skipped without it |
| `FAIL_RATE_ALERT` | optional; percent, default `10` |

An unset variable arrives as an **empty string**, not as absent. Anything reading
one has to treat `""` as unset, which is why `FAIL_RATE_ALERT` parses empty and
non-numeric values back to its 10% default instead of using `??`.

### Three things worth knowing

**The backend URL must be HTTPS.** These calls authenticate with HTTP Basic,
which is base64 — not encryption. Over plain `http://` the admin credentials
travel readable on every send.

**A campaign never reaches `completed`, and that is normal.** All 41 broadcasts in
the admin dashboard's history came to rest at `partial` — a send to the whole base
always hits a dead FCM token. So delivery is judged on the failure *rate*, not the
status string: `failed`, or a send that reached nobody, is a failure; anything else
is a delivered push. A rate above `FAIL_RATE_ALERT` (default 10%, against a
historical normal band of 0.3–4.8%) pings the fail topic but leaves the slot
`sent` — those spikes are dead tokens being pruned. See
`learnings/push-send-history-signals.md`.

**Public ntfy topics are readable and writable by anyone who knows the name.** On
`ntfy.sh` a topic is not access-controlled by default. The pings carry
notification copy and delivery counts — no credentials, no user data — but a
stranger could also post fake "all sent" messages into the same topic. Either
accept that, or run reserved topics with a token in `NTFY_TOKEN`.

## Deploying

Deploys are **manual by design** — a push must never redeploy the process that
owns a live broadcast schedule.

1. Land the change on `main`.
2. Run the **Deploy to VPS** workflow from the Actions tab (`workflow_dispatch`).

It fetches host and key from secrets-manager, resets the checkout at
`/root/apps/nidra-daily-push` to `origin/main`, and runs the standard VPS deploy
step, which assigns the port, writes `.env` from secrets-manager, and brings the
container up.

## Running locally

```bash
export NIDRA_API_URL=https://api.nidra.app
export NIDRA_ADMIN_USER=… NIDRA_ADMIN_PASS=…
export DASHBOARD_TOKEN=$(openssl rand -base64 32)

bun run dev                                   # service + dashboard on :3000, state in ./.data
bun run plan                                  # plans tomorrow
SCHEDULE_DATE=2026-08-25 bun run plan         # plans a specific IST date
SLOT_KEY=night_nidra bun run execute          # sends one slot now
bun run typecheck
```

Point `NIDRA_API_URL` at an unreachable host (`http://127.0.0.1:1`) to exercise
the scheduler and dashboard with no chance of a real send.

## Operational notes

- **Schedule files are the record of what real people received.** Each slot keeps
  `campaignId`, targeted/sent/failed counts, `attempts`, `lateBy`, and any error.
  The volume is the source of truth; git holds the nightly mirror so the history
  survives losing the box.
- **`/healthz` is the only witness to a stalled tick.** The service cannot page
  about its own clock stopping, so Docker's healthcheck watches it: 503 once no
  tick has completed for 5 minutes, including a first tick that never finished.
- **A slot stuck at `sending` needs a human.** Check the admin send history for
  that date, then either send it or use `POST /api/actions/resolve`. Automatic
  retry there is not safe.
- **Past days settle themselves.** Startup closes out any slot still `planned` on
  a past date — `missed` normally, `skipped` when the schedule was generated after
  its own send time — so the dashboard never shows a stale day as upcoming.
- **Five a day is new for this audience.** The 41 hand-sent campaigns before this
  averaged 0.8 pushes a day and skipped half the days. Volume, and the fact that
  68% of those campaigns carried an image while these carry none, are product
  calls this repo does not make on its own.
- **The cron-lag history is worth reading before re-adding any external
  scheduler.** `learnings/github-cron-lag.md`.
