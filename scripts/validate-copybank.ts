#!/usr/bin/env bun
/**
 * Gate for config/copybank.json. Runs in CI and before every plan, so bad copy
 * fails at midnight (fixable) rather than at 10:00 (already sent).
 *
 * Lengths are checked against the worst case: the longest item title that slot
 * can actually serve, and the largest {min} in its pool. Catalog is fetched when
 * NIDRA_API_URL is set; otherwise a conservative placeholder stands in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchCatalog, type CatalogItem, type CatalogKind } from './lib/api.ts';
import type { CopyBank, SlotsConfig } from './lib/types.ts';

const ROOT = join(import.meta.dirname, '..');
const MAX_TITLE = 45;
const MAX_BODY = 120;
const MIN_VARIANTS = 30;
const ALLOWED_TOKENS = new Set(['item', 'min']);
const EMOJI = /\p{Extended_Pictographic}/gu;
/** Stand-in when the catalog is unreachable: longer than any shipped title. */
const FALLBACK_ITEM = { title: 'Evening Wind Down', durationMin: 27 };

const errors: string[] = [];
const warnings: string[] = [];

function readJSON<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as T;
}

function graphemes(s: string): number {
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;
}

async function worstCasePerSlot(cfg: SlotsConfig) {
  const worst = new Map<string, { title: string; durationMin: number }>();
  const catalog = new Map<CatalogKind, CatalogItem[]>();
  let live = true;

  if (process.env.NIDRA_API_URL) {
    for (const kind of new Set(cfg.slots.map((s) => s.pool.kind))) {
      try {
        catalog.set(kind, await fetchCatalog(kind));
      } catch (e) {
        warnings.push(`catalog ${kind} unreachable (${(e as Error).message}); using fallback lengths`);
        live = false;
      }
    }
  } else {
    warnings.push('NIDRA_API_URL unset; using fallback item lengths');
    live = false;
  }

  for (const slot of cfg.slots) {
    if (!live) {
      worst.set(slot.copySlot, { ...FALLBACK_ITEM });
      continue;
    }
    const all = catalog.get(slot.pool.kind) ?? [];
    const banned = new Set(slot.pool.exclude ?? []);
    // excludeSlots is a same-day rule, not a length rule — every id in the kind
    // can still land here on some day, so all of them count for worst case.
    let items = all.filter((i) => !banned.has(i.id));
    if (slot.pool.include?.length) {
      const allow = new Set(slot.pool.include);
      items = items.filter((i) => allow.has(i.id));
    }
    const pool = items.length ? items : all;
    worst.set(slot.copySlot, {
      title: pool.reduce((a, b) => ((b.title ?? '').length > a.length ? (b.title ?? '') : a), ''),
      durationMin: pool.reduce((a, b) => Math.max(a, b.durationMin ?? 0), 0),
    });
  }
  return worst;
}

async function main() {
  const cfg = readJSON<SlotsConfig>('config/slots.json');
  const bank = readJSON<CopyBank>('config/copybank.json');
  const worst = await worstCasePerSlot(cfg);

  const expected = cfg.slots.map((s) => s.copySlot);
  for (const key of expected) {
    if (!bank.slots[key]) errors.push(`missing slot "${key}" in copybank`);
  }
  for (const key of Object.keys(bank.slots)) {
    if (!expected.includes(key)) warnings.push(`copybank slot "${key}" is not referenced by slots.json`);
  }

  const seenTitles = new Map<string, string>();
  const seenBodies = new Map<string, string>();
  let totalVariants = 0;
  let withEmoji = 0;

  for (const key of expected) {
    const variants = bank.slots[key]?.variants ?? [];
    if (variants.length < MIN_VARIANTS) {
      errors.push(`${key}: ${variants.length} variants, expected at least ${MIN_VARIANTS}`);
    }
    const w = worst.get(key) ?? FALLBACK_ITEM;
    const ids = new Set<string>();
    let slotEmoji = 0;

    variants.forEach((v, i) => {
      totalVariants++;
      const at = `${key}[${i}] ${v.id}`;
      if (!v.id) errors.push(`${at}: missing id`);
      if (ids.has(v.id)) errors.push(`${at}: duplicate id`);
      ids.add(v.id);
      if (!/^[a-z]{2}-\d{2}$/.test(v.id)) errors.push(`${at}: id must look like "xx-01"`);

      for (const field of ['title', 'body'] as const) {
        const raw = v[field];
        if (!raw || !raw.trim()) {
          errors.push(`${at}: empty ${field}`);
          continue;
        }
        for (const m of raw.matchAll(/\{([^}]*)\}/g)) {
          if (!ALLOWED_TOKENS.has(m[1])) errors.push(`${at}: unknown token {${m[1]}} in ${field}`);
        }
        const filled = raw
          .replaceAll('{item}', w.title || FALLBACK_ITEM.title)
          .replaceAll('{min}', String(w.durationMin || FALLBACK_ITEM.durationMin));
        const limit = field === 'title' ? MAX_TITLE : MAX_BODY;
        const len = graphemes(filled);
        if (len > limit) {
          errors.push(`${at}: ${field} is ${len} chars worst-case (limit ${limit}): "${filled}"`);
        }
        if (/\b[A-Z]{3,}\b/.test(raw)) errors.push(`${at}: ${field} contains ALL-CAPS`);
      }

      const emoji = [...(v.title + v.body).matchAll(EMOJI)].length;
      if (emoji > 1) errors.push(`${at}: ${emoji} emoji (max 1)`);
      if (emoji === 1) {
        withEmoji++;
        slotEmoji++;
      }
      if (key === 'night_nidra' && /!/.test(v.title + v.body)) {
        errors.push(`${at}: exclamation mark is not allowed in night_nidra`);
      }

      const tKey = v.title.trim().toLowerCase();
      const bKey = v.body.trim().toLowerCase();
      if (seenTitles.has(tKey)) errors.push(`${at}: title duplicates ${seenTitles.get(tKey)}`);
      else seenTitles.set(tKey, at);
      if (seenBodies.has(bKey)) errors.push(`${at}: body duplicates ${seenBodies.get(bKey)}`);
      else seenBodies.set(bKey, at);
    });

    const share = variants.length ? Math.round((slotEmoji / variants.length) * 100) : 0;
    console.log(
      `${key}: ${variants.length} variants · worst-case item "${w.title}" (${w.durationMin} min) · emoji ${share}%`,
    );
  }

  for (const w of warnings) console.warn(`warn: ${w}`);
  if (errors.length) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(
    `\nOK — ${totalVariants} variants across ${expected.length} slots, ${withEmoji} carry an emoji (${Math.round((withEmoji / totalVariants) * 100)}%).`,
  );
}

main().catch((e) => {
  console.error(`validate-copybank failed: ${(e as Error).message}`);
  process.exit(1);
});
