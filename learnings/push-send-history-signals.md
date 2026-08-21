# What the hand-sent campaign history says (21 Jun – 10 Aug 2026)

41 broadcasts pulled from the admin dashboard's "Recent campaigns" list. 151,456
targeted, 147,233 delivered, 2.79% missed. Source data kept out of the repo — the
figures below are the distilled version.

## `partial` is the terminal status. `completed` never happens.
- **41 of 41 campaigns ended `partial`.** A broadcast to the whole base always hits a
  dead FCM token, so the backend never reports a clean sweep.
- `execute.ts` originally did `slot.status = campaign.status === 'completed' ? 'sent' : 'failed'`.
  That would have marked **every** push failed: fail-topic ping and a red run five times a
  day, and — worse — `slot.status === 'failed'` is not the skip condition, so a rerun of
  the same cron would have sent the slot **a second time**.
- Fixed by judging delivery on the failure *rate*: `delivered = status !== 'failed' && sentCount > 0`.

## A failure spike is a token purge, not an outage
- Normal band: **0.27% – 4.79%** of targeted. Do not alert inside it.
- One outlier: 21 Jun 19:22 lost **1,887 of 3,891 (48.5%)**. The next send three hours
  later targeted **2,025** — `3891 − 1887 = 2004`. The failures pruned the dead tokens.
- So the alert threshold is 10% (`FAIL_RATE_ALERT`), and crossing it pings the fail topic
  **without** failing the run or flipping the slot off `sent` — a purge must never cause a re-push.

## Volume and timing the base has actually seen
- **0.80 pushes/day** over the 51-day span; sent on only **25 of 51 days**; 1.64 on days
  they sent; max 4 in one day (22 Jun). The 5/day schedule is ~6× anything shipped before.
- Send window ever used: **09:32 – 22:43**. Nothing earlier or later. The 21:30 slot plus
  5–30 min jitter tops out at 22:00 — inside it.
- Busiest hours: **17:00 (5) and 22:00 (5)**, then 11:00 / 19:00 / 21:00 (4 each).
  56% of all sends were after 17:00.
- **10:00 and 14:00 have carried one push each in seven weeks** — two of our five slots
  send into untested hours.
- Notifiable base grew **2,025 → 6,031** across the span (~3×), so any per-campaign count
  is only comparable against its own date.

## House style of the shipped copy (vs the new bank)
- **68% (28/41) carried an image.** `SendPayload` supports `imageUrl`; the planner never
  sets it, so every automated push is text-only.
- Emoji in **59%** of history vs 25% of the bank. Duration named in **12%** vs 57%.
  Session named in **93%** vs 91% (that one matches).
- CTA verbs, by frequency: Start 23, Play 9, Tap 4, Begin 4, Listen 3, "Click Here" 3.
  Title-then-body split with an explicit tap instruction is the established shape.
- Copy was reused verbatim two days apart (26 and 27 Jun, identical line) — exactly what
  the 40-variant rotation exists to prevent.
- Four historical lines would fail our own validator: `Start FOCUS BREATHING` and
  `LIVE: 30min…` (the `\b[A-Z]{3,}\b` gate), `Ready For a Deep Sleep!` (exclamation in the
  night slot), and a 49-character title against the 45-char ceiling.
- 3 of 41 pointed at a live group session or the sleep log, not a player screen. The
  planner's `routeTemplate` only deep-links catalog items — those campaigns are not
  reproducible by this pipeline.

## Reading the dashboard list
- Its "Message" column renders as `title — body`, so the em dash is the field separator,
  not copy. Titles there run to 49 chars, i.e. the backend does not enforce our 45 limit.
- Audience was `all notifiable users` on all 41 — matches `audience.mode = "all"`.

## The seven kinds of push that actually ship
Classifying all 41 by what they promote. Five kinds map onto a slot; two do not.

| Kind | n | Hours used | Slot it maps to |
|---|---|---|---|
| Breathing (Focus Breathing) | 6 | 09:32–12:59 | `morning_focus` 10:00 |
| Sound — Om (5), Escape (4) | 9 | 10:05–21:24 | `afternoon_soundscape` / `evening_soundscape` |
| Yog Nidra | 11 | 12:25–21:47 | `morning_focus` / `evening_meditation` |
| Evening wind-down | 6 | 16:19–20:30 | `evening_meditation` 17:00 |
| Night nidra / sleep | 6 | 21:47–22:40 | `night_nidra` 21:30 |
| Live group session | 2 | 13:16, 18:58 | **none** |
| Sleep log ("Record your sleep") | 1 | 09:38 | **none** |

- The five slots cover **38 of 41** sends. The live-session pair and the sleep-log ask deep-link
  somewhere other than a player screen, so `routeTemplate` cannot express them — they stay manual.
- Yog Nidra is the single most-pushed item (11 of 41), and its body is almost always the same
  sentence, *Start Yog Nidra Session*; all variation sits in the title.
- Only two soundtracks were ever pushed: **Om** and **Escape**. Never "follow the voice" — no voice.
- Night sends never left before 21:47; five of six after 22:00. `night_nidra` at 21:30 + jitter
  lands 21:35–22:00, i.e. slightly earlier than the human habit.

## Copy shapes underneath (strip the session names and only two remain)
- **Shape 1 — benefit, then the tap: 30 of 41.** Title is a statement, body is one instruction.
  `Let go of stress. — Tap To Begin - Yog Nidra Session`. This is the shape the new bank inherits.
- **Shape 2 — the session name IS the title: 9 of 41.** `Deep Healing Nidra — Start Now for a Deep
  Sleep`. **Our bank cannot do this**: `{item}` is a token, so the name always sits inside a
  sentence. If a reviewer asks why the new copy "never just names the session", this is why.
- Two sends fit neither (evening wind-down copy with no instruction at all).
- Recurring flavours inside shape 1: staccato commands 6 (`Relax. Breathe. Unwind.`), stacked pipe
  CTA 10 (`… | Click Here` — reads as UI, dropped in the rewrite), straight question 3 (two of
  which have a stray space before the `?`).
- CTA verb frequency: Start 23, Play 9, Tap 4, Begin 4, Take 3, Listen 3, "Click Here" 3,
  "Press play" 2, Join 2, Record 1. Every push ends in an instruction.
