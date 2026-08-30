# Moving a cron job into a long-lived service: what actually bit

All four of these were caught by *booting the thing and poking it*, not by
reading the code or by typechecking. Every one typechecked clean.

## A SIGTERM handler that stops timers but never exits creates a zombie

```ts
// BROKEN
process.on("SIGTERM", () => {
  stopScheduler();          // clearInterval
  clearInterval(mirrorTimer);
});                          // ...and then nothing
```

`Bun.serve` keeps the process alive on its own. So after SIGTERM the container
went on **answering HTTP and looking healthy** while the tick loop was dead and
no push would ever fire again. Observed directly: `ticks` frozen at 9,
`busy: false`, `/healthz` still 200, HTTP serving normally, for minutes.

Worse in Docker: `docker stop` has to wait out its full grace period, and
`restart: unless-stopped` never fires **because the process never exited**. A
crash restarts; a half-shutdown does not.

- Always `process.exit()` (or stop every server) at the end of a shutdown path.
- Drain in-flight work first, with a deadline — here the campaign poll is what
  writes the delivery record, so killing it strands the slot mid-send.
- A liveness endpoint must treat "first tick never completed" as unhealthy, not
  just "last tick is old". `lastTickAt === null` read as healthy on a loop that
  was wedged from boot.

## Bind the port before any startup side effect

Startup order was: sweep stale state → recover in-flight → bind port. Running a
second copy by mistake meant it **rewrote schedule files on the shared volume**
and only then died on `EADDRINUSE`. Bind first: a port clash should kill the
process before it touches anything.

This is also how the zombie above got mistaken for a working service — the
replacement crashed on the bind after doing its writes, leaving the old wedged
process still serving.

## Awaiting slow work inside a tick delays the work the tick exists for

The tick did `ensureSchedule(today)` → `ensureSchedule(tomorrow)` → send-due-slots.
Planning calls the catalog API, and `fetchCatalog` retries 3× with backoff — up to
**~75 s** when the backend is unreachable. With the send check last, a due send
waited behind it, and `ticks` stayed at 0 with `busy: true` for over a minute.

Fix: do the time-critical work **first**, then kick the slow work off detached
(`void ensurePlans(today)`) with its own in-flight guard and backoff so repeat
ticks don't pile up attempts.

## `[hidden]` loses to any class rule that sets `display`

```css
.actionpad { display: grid; }   /* author stylesheet */
```
```html
<div class="actionpad" hidden>  <!-- rendered anyway -->
```

The UA stylesheet's `[hidden] { display: none }` is beaten by *any* author rule
setting `display`, regardless of specificity — author styles always win over UA
styles. The token-gated action panel rendered all its controls while still
locked.

Fix, once, near the top of the stylesheet:
```css
[hidden] { display: none !important; }
```
Elements with no `display` rule of their own (`.phone`, `.log`, `.err`) were fine,
which is what makes this easy to miss in review — only *some* hidden elements
leak.

## Two statuses that look the same and must not be conflated

A slot that never sent is either:

- **`missed`** — the schedule predates the send time, so something really failed
  to fire. Page for it.
- **`skipped`** — the schedule was *generated after* its own send time (first
  deploy at 15:00, volume restored mid-afternoon). Nothing was ever due. Silent.

Without the split, every first deploy after the day's slot time pages a false
alarm, and the real misses lose their signal.

Same idea for a slot stuck at `sending`: **with** a campaign id the send
definitely left, so resume the poll; **without** one it is genuinely unknowable,
so page and change nothing. Guessing wrong means a second broadcast to the whole
base.
