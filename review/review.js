// Accept / reject state, the filter chips, and live token substitution.
// Decisions are the reviewer's own — they live in this browser and never leave it.
const KEY = 'nidra-copybank-decisions-v1';
const cards = [...document.querySelectorAll('.card')];
const chips = [...document.querySelectorAll('.chip[data-filter]')];

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Private windows and blocked site data both throw here. The page still works,
    // it just forgets between reloads.
    return {};
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

let state = load();
let filter = 'all';

function paint() {
  let acc = 0;
  let rej = 0;
  cards.forEach((card) => {
    const verdict = state[card.dataset.id];
    if (verdict === 'accept') acc++;
    if (verdict === 'reject') rej++;
    card.classList.toggle('accepted', verdict === 'accept');
    card.classList.toggle('rejected', verdict === 'reject');
    card.querySelector('.state').textContent =
      verdict === 'accept' ? 'accepted' : verdict === 'reject' ? 'rejected' : '';
    card.querySelectorAll('.btn').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(state[card.dataset.id] === btn.dataset.act));
    });
    const show =
      filter === 'all' ||
      (filter === 'accepted' && verdict === 'accept') ||
      (filter === 'rejected' && verdict === 'reject') ||
      (filter === 'undecided' && !verdict);
    card.classList.toggle('is-hidden', !show);
  });

  document.querySelectorAll('.slot').forEach((slot) => {
    slot.classList.toggle('is-empty', slot.querySelectorAll('.card:not(.is-hidden)').length === 0);
  });

  const ids = (want) => cards.filter((c) => state[c.dataset.id] === want).map((c) => c.dataset.id);
  const accIds = ids('accept');
  const rejIds = ids('reject');
  document.querySelectorAll('.n-acc').forEach((el) => (el.textContent = acc));
  document.querySelectorAll('.n-rej').forEach((el) => (el.textContent = rej));
  document.querySelectorAll('.n-und').forEach((el) => (el.textContent = cards.length - acc - rej));
  document.querySelector('.out-acc').textContent = accIds.length ? accIds.join('\n') : 'none yet';
  document.querySelector('.out-rej').textContent = rejIds.length ? rejIds.join('\n') : 'none yet';
}

document.querySelectorAll('.verdict .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const card = btn.closest('.card');
    const id = card.dataset.id;
    // Clicking the standing verdict again clears it, so a misclick is one tap to undo.
    state[id] = state[id] === btn.dataset.act ? undefined : btn.dataset.act;
    if (!state[id]) delete state[id];
    save();
    paint();
  });
});

chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    chips.forEach((c) => c.classList.toggle('is-on', c === chip));
    filter = chip.dataset.filter;
    paint();
  });
});

document.querySelector('.chip.reset').addEventListener('click', () => {
  state = {};
  save();
  paint();
});

function esc(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
function render(el, item, mins) {
  const raw = el.dataset.raw;
  if (!item) {
    el.innerHTML = esc(raw)
      .replace(/\{item\}/g, '<span class="tok">item</span>')
      .replace(/\{min\}/g, '<span class="tok">min</span>');
    return;
  }
  el.innerHTML = esc(raw)
    .replace(/\{item\}/g, `<span class="subbed">${esc(item)}</span>`)
    .replace(/\{min\}/g, `<span class="subbed">${mins}</span>`);
}
document.querySelectorAll('.sub-picker').forEach((picker) => {
  picker.addEventListener('change', () => {
    const [item, mins] = picker.value ? picker.value.split('|') : ['', ''];
    picker
      .closest('.slot')
      .querySelectorAll('.notif-title, .notif-body')
      .forEach((el) => render(el, item, mins));
  });
});

paint();
