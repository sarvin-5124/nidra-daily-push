// IST-only date helpers. Asia/Kolkata has no DST and has been +05:30 since
// 1945, so a fixed offset is exact — no tz database, no dependency.
export const IST_OFFSET = '+05:30';
export const IST_OFFSET_MIN = 330;

/** Wall-clock parts in IST for a given instant. */
export function istParts(d: Date) {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
  };
}

/** YYYY-MM-DD for the IST calendar day containing `d`. */
export function istDateKey(d: Date = new Date()): string {
  const p = istParts(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** The IST calendar day after `dateKey`. */
export function nextDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + 86_400_000;
  const n = new Date(t);
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}`;
}

/** The IST calendar day before `dateKey`. */
export function prevDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  const p = new Date(t);
  return `${p.getUTCFullYear()}-${pad(p.getUTCMonth() + 1)}-${pad(p.getUTCDate())}`;
}

/** Absolute instant for an IST wall-clock time on a given IST date. */
export function istInstant(dateKey: string, hhmm: string, plusMinutes = 0): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const utcMs =
    Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * 60_000 + plusMinutes * 60_000;
  return new Date(utcMs);
}

/** ISO-8601 with the literal IST offset, e.g. 2026-08-21T10:17:00+05:30. */
export function istISO(d: Date): string {
  const p = istParts(d);
  const s = new Date(d.getTime() + IST_OFFSET_MIN * 60_000).getUTCSeconds();
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(s)}${IST_OFFSET}`;
}

/** Whole IST days since the epoch — the rotation counter for content picking. */
export function istDayIndex(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}
