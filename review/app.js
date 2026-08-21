/* Copy-bank sign-off. Renders every variant from the embedded bank, records an
   accept / reject verdict per variant, and saves those verdicts back into the
   artifact so everyone (including Claude) reads the same list.

   Two layers of state, and the split matters:
   - SHARED — the verdicts embedded in this published version, by everyone.
   - EDITS  — only the ids THIS viewer changed and has not published yet, kept in
              localStorage so a reload does not lose a review half-done.

   Decisions never leave this browser on their own: the button copies them as
   text to paste into Slack or a message. An earlier version published them back
   into the artifact, which meant any stale tab could overwrite everyone else's
   verdicts wholesale — the timestamp moved and the list snapped back. Copy-out
   has no such failure mode, and no writer permissions to get wrong. */
const bank = JSON.parse(document.getElementById('bank').textContent);
const saved = JSON.parse(document.getElementById('verdicts').textContent);
const EDITS_KEY = 'nidra-copybank-edits-v3';
/** An edit with this value removes a shared verdict on the next save. */
const CLEARED = 'clear';

let shared = saved.verdicts || {};
let edits = readEdits();
let filter = 'all';

function readEdits() {
  try {
    const raw = localStorage.getItem(EDITS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Private windows and blocked site data both throw. The page still works;
    // it just cannot remember unpublished edits across a reload.
    return {};
  }
}
function writeEdits() {
  try {
    localStorage.setItem(EDITS_KEY, JSON.stringify(edits));
  } catch {}
}

/** The verdict a viewer sees: their own edit if they made one, else the shared one. */
function verdictOf(id) {
  const mine = edits[id];
  if (mine === CLEARED) return undefined;
  return mine || shared[id];
}

/** SHARED with this viewer's edits applied — what a save publishes. */
function merged() {
  const out = { ...shared };
  for (const [id, v] of Object.entries(edits)) {
    if (v === CLEARED) delete out[id];
    else out[id] = v;
  }
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const tokens = (s) =>
  esc(s)
    .replace(/\{item\}/g, '<span class="tok">item</span>')
    .replace(/\{min\}/g, '<span class="tok">min</span>');

/* ── render ─────────────────────────────────────────────────────────────── */
function slotHtml(slot) {
  const options = slot.items
    .map(([title, min]) => `<option value="${esc(title)}|${min}">${esc(title)} &middot; ${min} min</option>`)
    .join('');
  const cards = slot.variants
    .map(
      (v) => `<article class="card" id="${v.id}" data-id="${v.id}">
      <header class="card-head">
        <code class="vid">${v.id}</code>
        <span class="state" aria-live="polite"></span>
      </header>
      <div class="notif">
        <div class="notif-icon" aria-hidden="true"></div>
        <div class="notif-text">
          <span class="notif-app">Nidra</span>
          <span class="notif-title" data-raw="${esc(v.title)}">${tokens(v.title)}</span>
          <span class="notif-body" data-raw="${esc(v.body)}">${tokens(v.body)}</span>
        </div>
      </div>
      <div class="verdict">
        <button class="btn accept" data-act="accept" aria-pressed="false">Accept</button>
        <button class="btn reject" data-act="reject" aria-pressed="false">Reject</button>
      </div>
    </article>`,
    )
    .join('\n');
  return `<section class="slot" style="--hue:${slot.hue}" data-slot="${slot.key}">
    <div class="slot-head">
      <div class="slot-id">
        <span class="slot-time">${slot.at}</span>
        <code class="slot-key">${slot.key}</code>
      </div>
      <div class="slot-about">
        <h2>${esc(slot.name)}</h2>
        <p>${esc(slot.about)}</p>
      </div>
      <label class="picker">Read it as
        <select class="sub-picker">
          <option value="">show tokens</option>
          ${options}
        </select>
      </label>
    </div>
    <div class="cards">
${cards}
    </div>
  </section>`;
}

document.getElementById('slots').innerHTML = bank.slots.map(slotHtml).join('\n');

// Scoped to the rendered bank: the send-history section further down reuses the
// .card class for shipped copy, which carries no verdict.
const cards = [...document.querySelectorAll('#slots .card')];
const chips = [...document.querySelectorAll('.chip[data-filter]')];

function paint() {
  let acc = 0;
  let rej = 0;
  const dirty = Object.keys(edits).length;
  cards.forEach((card) => {
    const id = card.dataset.id;
    const verdict = verdictOf(id);
    if (verdict === 'accept') acc++;
    if (verdict === 'reject') rej++;
    card.classList.toggle('accepted', verdict === 'accept');
    card.classList.toggle('rejected', verdict === 'reject');
    card.classList.toggle('is-dirty', id in edits);
    card.querySelector('.state').textContent =
      verdict === 'accept' ? 'accepted' : verdict === 'reject' ? 'rejected' : '';
    card.querySelectorAll('.verdict .btn').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(verdict === btn.dataset.act));
    });
    const show =
      filter === 'all' ||
      (filter === 'accepted' && verdict === 'accept') ||
      (filter === 'rejected' && verdict === 'reject') ||
      (filter === 'undecided' && !verdict);
    card.classList.toggle('is-hidden', !show);
  });

  document.querySelectorAll('#slots .slot').forEach((slot) => {
    slot.classList.toggle('is-empty', slot.querySelectorAll('.card:not(.is-hidden)').length === 0);
  });

  const ids = (want) => cards.filter((c) => verdictOf(c.dataset.id) === want).map((c) => c.dataset.id);
  const accIds = ids('accept');
  const rejIds = ids('reject');
  document.querySelectorAll('.n-acc').forEach((el) => (el.textContent = acc));
  document.querySelectorAll('.n-rej').forEach((el) => (el.textContent = rej));
  document.querySelectorAll('.n-und').forEach((el) => (el.textContent = cards.length - acc - rej));
  document.querySelector('.out-acc').textContent = accIds.length ? accIds.join('\n') : 'none yet';
  document.querySelector('.out-rej').textContent = rejIds.length ? rejIds.join('\n') : 'none yet';

  const decided = acc + rej;
  const save = document.querySelector('.save');
  save.textContent = decided ? `Copy my ${decided} decisions` : 'Copy my decisions';
  save.disabled = decided === 0;
  document.querySelector('.discard').hidden = dirty === 0;
  document.querySelector('.saved-at').textContent =
    'kept in this browser only — copy them out when you are done';
}

/* ── interaction ────────────────────────────────────────────────────────── */
document.getElementById('slots').addEventListener('click', (e) => {
  const btn = e.target.closest('.verdict .btn');
  if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  const act = btn.dataset.act;
  // Clicking the standing verdict again clears it, so a misclick is one tap to
  // undo. Clearing a verdict that is already SHARED needs a tombstone, or the
  // merge would simply put it back.
  if (verdictOf(id) === act) edits[id] = shared[id] === act ? CLEARED : undefined;
  else edits[id] = act;
  if (edits[id] === undefined || edits[id] === shared[id]) delete edits[id];
  writeEdits();
  paint();
});

chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    chips.forEach((c) => c.classList.toggle('is-on', c === chip));
    filter = chip.dataset.filter;
    paint();
  });
});

document.querySelector('.discard').addEventListener('click', () => {
  // Drops only this viewer's unpublished edits — never anything already shared.
  edits = {};
  writeEdits();
  paint();
});

document.getElementById('slots').addEventListener('change', (e) => {
  const picker = e.target.closest('.sub-picker');
  if (!picker) return;
  const [item, mins] = picker.value ? picker.value.split('|') : ['', ''];
  picker
    .closest('.slot')
    .querySelectorAll('.notif-title, .notif-body')
    .forEach((el) => {
      const raw = el.dataset.raw;
      el.innerHTML = item
        ? esc(raw)
            .replace(/\{item\}/g, `<span class="subbed">${esc(item)}</span>`)
            .replace(/\{min\}/g, `<span class="subbed">${mins}</span>`)
        : tokens(raw);
    });
});

/* ── copying out: the decisions leave as text, nothing is published ─────── */
const label = (id) => {
  const card = document.getElementById(id);
  return card ? card.querySelector('.notif-title').dataset.raw : id;
};

/** The shareable report. Ids first so they can be pasted straight back to me. */
function report() {
  const all = merged();
  const acc = Object.keys(all).filter((id) => all[id] === 'accept').sort();
  const rej = Object.keys(all).filter((id) => all[id] === 'reject').sort();
  const lines = [
    `Nidra push copy bank — decisions (${stamp()})`,
    `${acc.length} accepted · ${rej.length} rejected · ${cards.length - acc.length - rej.length} undecided of ${cards.length}`,
  ];
  for (const [head, ids] of [['ACCEPTED', acc], ['REJECTED', rej]]) {
    if (!ids.length) continue;
    lines.push('', `${head} (${ids.length})`, ...ids.map((id) => `${id}  ${label(id)}`));
  }
  return lines.join('\n');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const status = document.querySelector('.save-status');
function say(msg, kind) {
  status.textContent = msg;
  status.className = `save-status${kind ? ' is-' + kind : ''}`;
}

/**
 * Two ways out, because a sandboxed frame may refuse both: the async clipboard
 * API, then a hidden textarea with execCommand. If neither works the text is
 * selected in place so the reader can copy it by hand.
 */
async function copyOut(text) {
  try {
    await navigator.clipboard.writeText(text);
    return 'clipboard';
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return 'exec';
  } catch {}
  return null;
}

document.querySelector('.save').addEventListener('click', async () => {
  const text = report();
  const how = await copyOut(text);
  if (how) {
    say('Copied. Paste it into Slack or a message.', 'ok');
  } else {
    // Put it on screen and select it — a manual copy still gets the job done.
    const pre = document.querySelector('.out-report');
    pre.textContent = text;
    pre.hidden = false;
    const range = document.createRange();
    range.selectNodeContents(pre);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    say('Copying was blocked here — the selected text below is ready for Cmd-C.', 'warn');
  }
});

paint();
