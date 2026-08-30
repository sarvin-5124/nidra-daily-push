/* Nidra Daily Push — dashboard client.

   Two clocks, deliberately separate. The server is polled every 10 s for state;
   the countdown to the next sendAt ticks locally every second off the sendAt
   timestamp, so the big number stays smooth without ten times the requests.

   Everything the read API returns is already public (the repo it mirrors to is
   public), so nothing here is secret. The token is only ever sent on the POST
   routes, and lives in sessionStorage — a closed tab re-locks the actions. */

const TOKEN_KEY = "nidra-push-token";
const POLL_MS = 10_000;

const el = (id) => document.getElementById(id);
const IST = { timeZone: "Asia/Kolkata" };

let state = null;
let token = readToken();

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    // Private windows and blocked site data both throw. Actions still work for
    // this page view; they just re-lock on reload.
    return "";
  }
}
function writeToken(v) {
  try {
    if (v) sessionStorage.setItem(TOKEN_KEY, v);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

/* ── formatting ─────────────────────────────────────────────────────────── */

function istNow() {
  return new Date().toLocaleString("en-GB", {
    ...IST,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** "1h 24m 09s" / "2m 05s" / "14s" */
function humanGap(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

const clockOf = (iso) => (iso ? String(iso).slice(11, 16) : "—");

/* ── rendering ──────────────────────────────────────────────────────────── */

function badge(status) {
  const b = document.createElement("span");
  b.className = `badge ${status}`;
  b.textContent = status;
  return b;
}

function renderHero() {
  const next = state?.next;
  const cd = el("countdown");
  const phone = el("phone");

  if (!next) {
    el("hero-eyebrow").textContent = "Nothing pending";
    cd.textContent = "—";
    cd.className = "countdown is-idle";
    el("hero-sub").textContent = state?.todaySchedule
      ? "Today's slots have all resolved. Tomorrow is planned at 00:00 IST."
      : "No schedule on the volume yet.";
    el("hero-pills").replaceChildren();
    phone.hidden = true;
    return;
  }

  el("hero-eyebrow").textContent =
    next.date === state.today
      ? "Next push · today"
      : `Next push · ${next.date}`;

  const target = new Date(next.sendAt).getTime();
  const gap = target - Date.now();
  if (next.status === "sending") {
    cd.textContent = "sending";
    cd.className = "countdown is-past";
  } else if (gap <= 0) {
    cd.textContent = `+${humanGap(-gap)}`;
    cd.className = "countdown is-past";
  } else {
    cd.textContent = humanGap(gap);
    cd.className = "countdown";
  }

  el("hero-sub").textContent =
    `${next.key} · slot ${next.slotAt} · sendAt ${clockOf(next.sendAt)} IST ` +
    `(${next.jitterMin} min jitter)`;

  const pills = [
    `${next.item.title}`,
    next.item.durationMin ? `${next.item.durationMin} min` : null,
    next.copyId,
    next.status,
  ].filter(Boolean);
  el("hero-pills").replaceChildren(
    ...pills.map((t) => {
      const s = document.createElement("span");
      s.className = "pill";
      s.textContent = t;
      return s;
    }),
  );

  phone.hidden = false;
  el("notif-when").textContent = clockOf(next.sendAt);
  el("notif-title").textContent = next.title;
  el("notif-body").textContent = next.body;
}

function renderToday() {
  const sched = state?.todaySchedule;
  el("today-date").textContent = state ? `${state.today} IST` : "";
  const host = el("today-slots");

  if (!sched || !sched.slots.length) {
    host.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "muted",
        textContent: "No schedule for today on the volume.",
      }),
    );
  } else {
    host.replaceChildren(
      ...sched.slots.map((s) => {
        const row = document.createElement("div");
        row.className = "slot";

        const time = document.createElement("span");
        time.className = "slot-time";
        time.textContent = clockOf(s.sendAt);

        const copy = document.createElement("div");
        copy.className = "slot-copy";
        const b = document.createElement("b");
        b.textContent = s.title;
        const p = document.createElement("p");
        const r = s.result;
        p.textContent = r?.campaignId
          ? `${s.item.title} · ${r.sent ?? "?"}/${r.targeted ?? "?"} delivered · ${r.failRatePct ?? "?"}% failed`
          : `${s.item.title} · ${s.copyId}`;
        copy.append(b, p);

        row.append(time, copy, badge(s.status));
        return row;
      }),
    );
  }

  const h = state?.scheduler;
  const m = state?.mirror;
  el("today-health").replaceChildren(
    ...[
      ["Tick", h ? `every ${h.tickSeconds}s · ${h.ticks} so far` : "—"],
      ["Last tick", h?.lastTickAt ? clockOf(h.lastTickAt) : "never"],
      ["Late window", h ? `${h.maxLateMin} min` : "—"],
      ["Tomorrow", state?.tomorrowPlanned ? "planned" : "not planned"],
      ["Actions", state?.authConfigured ? "token set" : "NO TOKEN SET"],
      ["Mirror", m?.enabled ? (m.lastResult ?? "idle") : "disabled"],
      ["Last error", h?.lastError ?? "none"],
    ].map(([k, v]) => {
      const d = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      d.append(dt, dd);
      return d;
    }),
  );
}

function renderSlotPickers() {
  const sched = state?.todaySchedule;
  const keys = sched ? sched.slots.map((s) => `${s.key} (${s.status})`) : [];
  const values = sched ? sched.slots.map((s) => s.key) : [];
  for (const id of ["test-slot", "send-slot"]) {
    const sel = el(id);
    const prev = sel.value;
    sel.replaceChildren(
      ...values.map((v, i) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = keys[i];
        return o;
      }),
    );
    if (values.includes(prev)) sel.value = prev;
  }
}

function renderHealthDot() {
  const dot = el("health-dot");
  const h = state?.scheduler;
  if (!state) {
    dot.className = "dot";
    dot.title = "no contact with the service";
    return;
  }
  const stale =
    h?.lastTickAt && Date.now() - new Date(h.lastTickAt).getTime() > 120_000;
  const today = state.todaySchedule;
  const broken = today?.slots.some((s) =>
    ["failed", "missed"].includes(s.status),
  );
  if (stale) {
    dot.className = "dot is-bad";
    dot.title = "tick loop has stalled";
  } else if (broken || !state.authConfigured) {
    dot.className = "dot is-warn";
    dot.title = broken
      ? "a slot failed or was missed today"
      : "DASHBOARD_TOKEN not set";
  } else {
    dot.className = "dot is-ok";
    dot.title = "scheduler healthy";
  }
}

function renderHistory(schedules) {
  const body = document.querySelector("#history tbody");
  const rows = [];
  let sent = 0;
  let delivered = 0;

  for (const sched of schedules) {
    for (const s of sched.slots) {
      const r = s.result || {};
      if (s.status === "sent") sent++;
      delivered += r.sent || 0;
      const tr = document.createElement("tr");
      const cells = [
        [sched.date, ""],
        [s.key, ""],
        [r.startedAt ? clockOf(r.startedAt) : clockOf(s.sendAt), ""],
        [null, ""],
        [r.targeted ?? "", "num"],
        [r.sent ?? "", "num"],
        [r.failed ?? "", "num"],
        [
          r.failRatePct != null ? `${r.failRatePct}%` : "",
          `num${r.failRatePct > 10 ? " rate-hi" : ""}`,
        ],
        [r.lateBy ? `${r.lateBy}m` : "", "num"],
        [`${s.item.title} · ${s.copyId}`, "wrap"],
      ];
      cells.forEach(([text, cls], i) => {
        const td = document.createElement("td");
        if (cls) td.className = cls;
        if (i === 3) td.appendChild(badge(s.status));
        else td.textContent = String(text);
        tr.appendChild(td);
      });
      rows.push(tr);
    }
  }

  body.replaceChildren(
    ...(rows.length
      ? rows
      : [
          Object.assign(document.createElement("tr"), {
            innerHTML: '<td colspan="10" class="muted">no schedules yet</td>',
          }),
        ]),
  );
  el("history-summary").textContent = rows.length
    ? `${rows.length} slots · ${sent} sent · ${delivered.toLocaleString("en-IN")} delivered`
    : "";
}

function renderLog(lines) {
  const pre = el("log");
  pre.hidden = false;
  el("log-note").textContent = `last ${lines.length} lines`;
  pre.replaceChildren(
    ...lines.map((l) => {
      const div = document.createElement("div");
      div.className = `lv-${l.level}`;
      const at = document.createElement("span");
      at.className = "at";
      at.textContent = `${clockOf(l.at)} `;
      div.append(at, document.createTextNode(l.msg));
      return div;
    }),
  );
}

/* ── data ───────────────────────────────────────────────────────────────── */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function refresh() {
  try {
    state = await api("/api/status");
    renderHero();
    renderToday();
    renderSlotPickers();
    renderHealthDot();
  } catch (e) {
    state = null;
    renderHealthDot();
    el("hero-sub").textContent = `cannot reach the service: ${e.message}`;
  }
  try {
    const { schedules } = await api("/api/history?days=30");
    renderHistory(schedules);
  } catch {
    // The history table keeps whatever it last showed; status is the live view.
  }
  if (token) {
    try {
      const { lines } = await api("/api/logs?n=300");
      renderLog(lines);
    } catch {
      // Almost always a stale token — the unlock state below reports it.
    }
  }
}

/* ── actions ────────────────────────────────────────────────────────────── */

function setUnlocked(on) {
  el("actionpad").hidden = !on;
  el("lockpad").hidden = on;
  el("actions").classList.toggle("locked", !on);
  el("actions-state").textContent = on ? "unlocked for this tab" : "locked";
  el("unlock-btn").textContent = on ? "Lock" : "Unlock actions";
  el("log-note").textContent = on
    ? "loading…"
    : "unlock actions to read the log";
  if (!on) el("log").hidden = true;
}

function showOut(msg, ok) {
  const out = el("action-out");
  out.hidden = false;
  out.className = `out ${ok ? "is-ok" : "is-bad"}`;
  out.textContent = msg;
}

/** Run a guarded action with the button disabled and the result surfaced. */
async function guarded(form, fn) {
  const button = form.querySelector("button");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "working…";
  try {
    showOut(await fn(), true);
  } catch (e) {
    showOut(e.message, false);
  } finally {
    button.disabled = false;
    button.textContent = label;
    refresh();
  }
}

function wire() {
  el("unlock-btn").addEventListener("click", () => {
    if (token) {
      token = "";
      writeToken("");
      setUnlocked(false);
    } else {
      el("actions").scrollIntoView({ behavior: "smooth", block: "center" });
      el("token-input").focus();
    }
  });

  el("token-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const candidate = el("token-input").value.trim();
    if (!candidate) return;
    const err = el("token-err");
    err.hidden = true;
    // Validate against a real guarded route rather than trusting the input:
    // /api/logs is the only read route behind the token, so it doubles as the
    // cheapest possible credential check with no side effects.
    const previous = token;
    token = candidate;
    try {
      const { lines } = await api("/api/logs?n=300");
      writeToken(candidate);
      el("token-input").value = "";
      setUnlocked(true);
      renderLog(lines);
    } catch (e2) {
      token = previous;
      err.hidden = false;
      err.textContent = e2.message;
    }
  });

  el("test-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const userId = el("test-user").value.trim();
    if (!userId) return showOut("a user id is required for a test send", false);
    const slot = el("test-slot").value;
    guarded(e.target, async () => {
      const r = await api("/api/actions/send", {
        method: "POST",
        body: JSON.stringify({ slot, mode: "single_user", userId }),
      });
      const c = r.campaign || {};
      return `test send ${r.ok ? "delivered" : "FAILED"} · ${c.sentCount ?? "?"}/${c.targetedCount ?? "?"} · status ${c.status ?? "?"}\nslot untouched, it will still send to everyone at its own time`;
    });
  });

  el("send-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const slot = el("send-slot").value;
    const sched = state?.todaySchedule;
    const target = sched?.slots.find((s) => s.key === slot);
    const audience = target?.result?.targeted;
    // A broadcast has no undo, so make the operator type the slot key back.
    const typed = prompt(
      `This sends "${slot}" to the ENTIRE member base immediately` +
        (audience ? ` (~${audience} devices last time)` : "") +
        `.\n\nThere is no undo. Type the slot key to confirm:`,
    );
    if (typed !== slot)
      return showOut("cancelled — confirmation did not match", false);
    guarded(e.target, async () => {
      const r = await api("/api/actions/send", {
        method: "POST",
        body: JSON.stringify({ slot, mode: "schedule" }),
      });
      const c = r.campaign || {};
      return `sent · campaign ${c.campaignId ?? r.slot?.result?.campaignId ?? "?"} · ${c.sentCount ?? "?"}/${c.targetedCount ?? "?"} delivered · status ${c.status ?? "?"}`;
    });
  });

  el("plan-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const date = el("plan-date").value;
    const force = el("plan-force").checked;
    guarded(e.target, async () => {
      const r = await api("/api/actions/plan", {
        method: "POST",
        body: JSON.stringify({ ...(date ? { date } : {}), force }),
      });
      const s = r.schedule;
      return `planned ${s.date}\n${s.slots.map((x) => `${clockOf(x.sendAt)} ${x.key} · ${x.item.title} · "${x.title}"`).join("\n")}`;
    });
  });

  el("mirror-form").addEventListener("submit", (e) => {
    e.preventDefault();
    guarded(e.target, async () => {
      const r = await api("/api/actions/mirror", { method: "POST" });
      return `mirror: ${r.lastResult}`;
    });
  });
}

/* ── boot ───────────────────────────────────────────────────────────────── */

el("plan-date").value = new Date(Date.now() + 86_400_000)
  .toISOString()
  .slice(0, 10);
wire();
setUnlocked(Boolean(token));
refresh();
setInterval(refresh, POLL_MS);
setInterval(() => {
  el("clock").textContent = `${istNow()} IST`;
  if (state?.next) renderHero();
}, 1000);
