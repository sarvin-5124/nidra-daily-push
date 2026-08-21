#!/usr/bin/env bun
/**
 * Builds the reviewer-facing sign-off page for config/copybank.json: every
 * variant as a phone-notification preview with an accept / reject verdict.
 *
 * The page renders itself from an embedded copy of the bank and an embedded
 * verdict blob, and it can republish itself — a reviewer's Save writes their
 * verdicts back into the artifact, so decisions are shared rather than stuck in
 * one person's browser. That is why the static markup lives in a <template>:
 * the page rebuilds a clean copy of itself from it and never serialises the
 * live DOM.
 *
 *   bun run build-review
 *
 * Verdicts already saved into the published artifact are NOT in this repo, so
 * rebuilding resets them to empty. Pull them off the live page first if a
 * review is in progress.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CopyBank } from './lib/types.ts';

const ROOT = join(import.meta.dirname, '..');
const REVIEW = join(ROOT, 'review');
const OUT = join(REVIEW, 'copybank-review.html');

/** Real catalog titles and durations, worst case last — for the token picker. */
const SLOTS = [
  {
    key: 'morning_focus', at: '10:00', hue: '#7b95d6', name: 'Mid-morning reset',
    about: 'The workday is underway and attention is already going. Short, energising, clarity-led — not sleep.',
    items: [['Focus Breathing', 4], ['Yog Nidra', 13]],
  },
  {
    key: 'afternoon_soundscape', at: '14:00', hue: '#c9a463', name: 'After-lunch dip',
    about: 'Background sound for work, or a real pause. Light, sensory, unhurried.',
    items: [['Escape', 20], ['Om', 20], ['Rain', 20], ['Waves', 20], ['Thunder', 20]],
  },
  {
    key: 'evening_meditation', at: '17:00', hue: '#d1854a', name: 'Work-to-evening handoff',
    about: 'Putting the workday down. Not sleeping yet.',
    items: [['Wind Down', 3], ['Focus Breathing', 4], ['Yog Nidra', 13]],
  },
  {
    key: 'evening_soundscape', at: '19:00', hue: '#9a76c4', name: 'Evening at home',
    about: 'Cooking, commuting, kids, screens. Sound as a change of room.',
    items: [['Escape', 20], ['Om', 20], ['Rain', 20], ['Waves', 20], ['Thunder', 20]],
  },
  {
    key: 'night_nidra', at: '21:30', hue: '#6355b0', name: 'Bedtime cue',
    about: 'The core promise. Warm, slow, and still direct.',
    items: [['Sleep Onset', 17], ['Deep Healing', 21], ['Stress Relief', 27]],
  },
] as const;

const bankFile = JSON.parse(readFileSync(join(ROOT, 'config', 'copybank.json'), 'utf8')) as CopyBank;
const bank = {
  slots: SLOTS.map((s) => ({ ...s, variants: bankFile.slots[s.key]?.variants ?? [] })),
};
const total = bank.slots.reduce((n, s) => n + s.variants.length, 0);
if (total === 0) throw new Error('copybank.json produced no variants — check the slot keys');

const css = readFileSync(join(REVIEW, 'review.css'), 'utf8');
const js = readFileSync(join(REVIEW, 'app.js'), 'utf8');
const history = existsSync(join(REVIEW, 'history-section.html'))
  ? readFileSync(join(REVIEW, 'history-section.html'), 'utf8')
  : '';
/**
 * Verdicts already signed off. The published page is the live record — reviewers
 * save into it — so a rebuild must not wipe it: pull the current blob off the
 * artifact into review/verdicts.json first, and it gets carried into the new
 * page. Missing file means "no decisions yet".
 */
const verdicts = existsSync(join(REVIEW, 'verdicts.json'))
  ? JSON.parse(readFileSync(join(REVIEW, 'verdicts.json'), 'utf8'))
  : { verdicts: {}, savedAt: '', saves: [] };
for (const [name, src] of [['app.js', js], ['review.css', css], ['history', history]] as const) {
  // The page republishes itself by inlining these, so a literal closing script
  // tag anywhere inside would truncate the published document.
  if (src.includes('</script>')) throw new Error(`${name} contains a literal </script> — escape it as <\\/script>`);
}

/** JSON safe to embed in a script element. */
const blob = (id: string, value: unknown) =>
  `<script id="${id}" type="application/json">${JSON.stringify(value, null, 2).replace(/</g, '\\u003c')}</script>`;

const shell = `<header class="page-head">
  <p class="eyebrow">For sign-off &middot; nidra-daily-push</p>
  <h1>${total} pushes to accept or reject</h1>
  <p class="lede">One variant per slot goes out each night, stepping forward one place, so a member
  sees the same line again after 40 days at the earliest. Accept the ones that can ship and reject
  the rest &mdash; every slot needs at least one line left standing. Nothing here is live yet.</p>
  <p class="lede">Written against the 41 pushes sent by hand before this: verb first, the session
  named in the title as often as they named it, <i>Start</i> for guided sessions and <i>play</i> or
  <i>listen</i> for soundscapes, and the duration mentioned only where it earns its place. The
  numbers behind that are at the foot of the page.</p>
</header>

<nav class="bar" aria-label="Filter and progress">
  <button class="chip is-on" data-filter="all">All ${total}</button>
  <button class="chip" data-filter="undecided">Undecided</button>
  <button class="chip" data-filter="accepted">Accepted</button>
  <button class="chip" data-filter="rejected">Rejected</button>
  <span class="tally"><b class="n-acc">0</b> accepted &middot; <b class="n-rej">0</b> rejected &middot; <b class="n-und">${total}</b> to go</span>
  <button class="btn save" type="button" disabled>Copy my decisions</button>
  <button class="chip discard" type="button" hidden>Clear my picks</button>
</nav>
<p class="save-line"><span class="save-status"></span> <span class="saved-at"></span></p>

<div id="slots"></div>

<section class="export">
  <h2>Your decisions</h2>
  <p>Your picks stay in this browser. <b>Copy my decisions</b> puts the whole list on your
  clipboard as plain text &mdash; paste it into Slack, a message, or straight back to whoever asked
  for the review. The lists below are the same ids, if you would rather copy one side only.</p>
  <div class="lists">
    <div><h3>Accepted <span class="n-acc">0</span></h3><pre class="out-acc">none yet</pre></div>
    <div><h3>Rejected <span class="n-rej">0</span></h3><pre class="out-rej">none yet</pre></div>
  </div>
  <pre class="out-report" hidden></pre>
</section>

${history}
<footer class="page-foot">
  <p>Generated from <code>config/copybank.json</code> by <code>scripts/build-review-page.ts</code>.
  Decisions are per-reviewer and never published back into this page &mdash; they travel by copy and
  paste, so two people reviewing at once cannot overwrite each other.</p>
</footer>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nidra Push Copy Bank</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,500;1,6..72,300&family=Karla:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style id="css">${css}</style>
</head>
<body>
${blob('bank', bank)}
${blob('verdicts', verdicts)}
<template id="shell">${shell}</template>
${shell}
<script id="app-js">${js}</script>
</body>
</html>
`;

writeFileSync(OUT, page, 'utf8');
console.log(
  `[review] wrote ${OUT} — ${total} variants, ` +
    `${Object.keys(verdicts.verdicts ?? {}).length} verdicts carried over, ` +
    `${(page.length / 1024).toFixed(0)} KB`,
);
