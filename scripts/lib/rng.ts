// Deterministic, seeded helpers. Content picking must be reproducible: rerunning
// the planner for the same date has to produce the same plan, so nothing here
// touches Math.random. (Jitter is the one deliberate exception — see plan.ts.)

/** FNV-1a → 32-bit seed from an arbitrary string. */
export function seedFrom(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for shuffling a 40-item list. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded source; returns a new array. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Rotation pick: one fixed, seed-shuffled permutation per salt, stepped one
 * position per day. Guarantees are what matter here and they are exact — every
 * item appears once per pool-length cycle, and no item can land on consecutive
 * days (for a pool of 2 or more).
 *
 * An earlier version reshuffled the permutation each cycle for extra variety;
 * it produced consecutive-day repeats at the cycle boundary, badly so for the
 * two-item morning pool. The fixed order is less clever and actually correct —
 * the order within a cycle is not something a user can perceive anyway.
 */
export function rotate<T>(items: readonly T[], dayIndex: number, salt: string): T {
  if (items.length === 0) throw new Error(`rotate: empty pool for ${salt}`);
  const perm = shuffled(items, seedFrom(salt));
  // dayIndex is always positive (days since 1970) but stay safe under overrides.
  const i = ((dayIndex % perm.length) + perm.length) % perm.length;
  return perm[i];
}
