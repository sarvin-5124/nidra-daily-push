# Deterministic rotation for daily content picks

## The bug: per-cycle reshuffle repeats at the boundary

First version of `rotate()` shuffled the pool with a seed derived from the
*cycle* number (`floor(dayIndex / poolSize)`) and indexed with
`dayIndex % poolSize`, so each pass through the pool got a fresh order.

- Every cycle is internally complete — but nothing links the **tail** of one
  cycle to the **head** of the next, so the same item can land on two
  consecutive days.
- Worst on small pools. With a 2-item pool (the 10:00 Focus Breathing / Yog
  Nidra pair) a 400-day simulation produced **106 consecutive-day repeats** —
  the one collision a user would actually notice.
- Patching it by comparing against the previous cycle's tail does not work
  either: to know the *effective* tail you must apply the same de-collide fix to
  cycle − 1, which recurses back to cycle 0.

## What works

One fixed, seed-shuffled permutation per salt, stepped one position per day:

```ts
const perm = shuffled(items, seedFrom(salt));
return perm[((dayIndex % perm.length) + perm.length) % perm.length];
```

Exact guarantees, no simulation needed: every item appears once per pool-length
cycle, and no item can repeat on consecutive days for a pool of 2 or more. The
order within a cycle is fixed, which is invisible to users — they see one push
per slot per day, never the sequence.

## Verify rotation with a simulation, not by eye

A 12-day print-out looked fine and hid the boundary bug. The check that caught
it ran 400 days per pool and counted: consecutive repeats, incomplete cycles,
and the min/max appearance spread. Cheap to write, and it is the only way these
properties are actually observable.

## Pool composition that changes daily needs a separate guard

The 17:00 slot excludes whatever 10:00 picked, so its pool is a *different* pair
each day. Rotation indexes into a pool that isn't stable, so its guarantees do
not carry over. Fixed by also excluding what that same slot served **yesterday**
(read from the previous day's committed schedule file, skipped if it would empty
the pool) — a data check, not a maths one.

## Keep the random part small and write it down

Content picking is fully deterministic so re-planning a date reproduces the plan.
The only genuinely random value is the per-notification jitter, and it is
persisted into the schedule file the moment it is rolled. The executor reads it
and never re-rolls — which is what makes tomorrow's exact send times knowable in
advance and reruns idempotent.
