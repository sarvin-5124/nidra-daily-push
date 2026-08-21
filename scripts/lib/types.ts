export interface SlotPool {
  kind: 'sessions' | 'soundscapes' | 'stories' | 'meditations';
  /** Whitelist of catalog ids. Omit to use the whole kind. */
  include?: string[];
  /** Ids never eligible for this slot. */
  exclude?: string[];
  /** Drop whatever these earlier slots picked today (no same-day repeats). */
  excludeSlots?: string[];
}

export interface SlotConfig {
  key: string;
  at: string; // IST wall clock, HH:MM
  copySlot: string; // key into copybank.json slots
  pool: SlotPool;
}

export interface SlotsConfig {
  version: number;
  tz: string;
  sentBy: string;
  audience: { mode: string; segment?: Record<string, unknown> };
  jitterMinutes: { min: number; max: number };
  routeTemplate: string;
  slots: SlotConfig[];
}

export interface CopyVariant {
  id: string;
  title: string;
  body: string;
}

export interface CopyBank {
  version: number;
  notes?: string;
  slots: Record<string, { variants: CopyVariant[] }>;
}

export interface PlannedSlot {
  key: string;
  slotAt: string; // 10:00
  jitterMin: number;
  sendAt: string; // 2026-08-21T10:17:00+05:30
  item: { kind: string; id: string; title: string; durationMin: number | null };
  copyId: string;
  title: string;
  body: string;
  route: string;
  audience: { mode: string; segment?: Record<string, unknown> };
  status: 'planned' | 'sent' | 'failed' | 'skipped';
  result: {
    campaignId?: string;
    campaignStatus?: string;
    targeted?: number;
    sent?: number;
    failed?: number;
    /** failed / targeted, as a percentage. Historical normal band: 0.3-4.8%. */
    failRatePct?: number;
    startedAt?: string;
    finishedAt?: string;
    lateBy?: number; // minutes past sendAt the push actually left
    error?: string;
    attempts?: number;
  } | null;
}

export interface Schedule {
  version: number;
  date: string; // IST YYYY-MM-DD
  tz: string;
  generatedAt: string;
  generatedBy: string;
  slots: PlannedSlot[];
}
