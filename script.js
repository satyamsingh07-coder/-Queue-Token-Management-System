/* =========================================================
   Queue & Token Management System - Application Logic
   ---------------------------------------------------------
   Sections:
   1.  Configuration & constants
   2.  State management (localStorage)
   3.  Helper utilities
   4.  Core queue logic (generate, call, complete, skip ...)
   5.  Rendering functions (UI)
   6.  Event handlers
   7.  Initialisation
   ========================================================= */

/* ---------------------------------------------------------
   1. CONFIGURATION
   --------------------------------------------------------- */
const STORAGE_KEY = "qtms_state_v1";
const ADMIN_PIN = "1234";           // Demo PIN (change as needed)
const MAX_RECENT = 6;               // Recently called tokens shown on board

// Each service has a prefix letter used in the token number
const SERVICES = {
  G: { name: "General Enquiry",   icon: "💬", avg: 5  },  // avg = average minutes per customer
  B: { name: "Billing & Payment", icon: "💳", avg: 8  },
  A: { name: "Account Services", icon: "🏦", avg: 10 },
  S: { name: "Customer Support", icon: "🛠️", avg: 7  },
};

/* ---------------------------------------------------------
   2. STATE MANAGEMENT
   --------------------------------------------------------- */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function defaultState() {
  return {
    date: todayStr(),
    tokens: [],                                  // all tokens issued today
    seq: { G: 0, B: 0, A: 0, S: 0 },             // running number per service
    counters: [                                  // service windows
      { id: 1, name: "Counter 1", service: "ALL", current: null },
      { id: 2, name: "Counter 2", service: "ALL", current: null },
      { id: 3, name: "Counter 3", service: "ALL", current: null },
    ],
    recent: [],                                  // [{token, counter}]
    lastCall: null,                              // used for announcements / flash
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // New day => start fresh queue automatically
      if (s.date !== todayStr()) return defaultState();
      return s;
    }
  } catch (e) { console.warn("Could not read saved data", e); }
  return defaultState();
}

let state = loadState();
let lastTicketId = null;       // token shown on the "Get Token" page
let lastAnnouncedStamp = 0;    // avoids repeating voice announcements
let voiceOn = true;

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ---------------------------------------------------------
   3. HELPERS
   --------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const pad = (n, len = 3) => String(n).padStart(len, "0");
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function fmtDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "< 1 min";
  if (totalMin < 60) return totalMin + " min";
  return Math.floor(totalMin / 60) + " h " + (totalMin % 60) + " min";
}

function escapeHTML(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  $("#toastWrap").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function speak(text) {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

/* ---------------------------------------------------------
   4. CORE QUEUE LOGIC
   --------------------------------------------------------- */

/** Waiting tokens, priority first, then first-come-first-served */
function getWaiting(service = "ALL") {
  return state.tokens
    .filter((t) => t.status === "waiting" && (service === "ALL" || t.service === service))
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.createdAt - b.createdAt);
}

function getToken(id) {
  return state.tokens.find((t) => t.id === id);
}

/** Number of counters able to serve a given service */
function countersFor(service) {
  const n = state.counters.filter((c) => c.service === "ALL" || c.service === service).length;
  return Math.max(1, n);
}

/** Position of a waiting token inside its own service queue (1-based) */
function positionOf(token) {
  const list = getWaiting(token.service);
  return list.findIndex((t) => t.id === token.id) + 1;
}

/** Estimated waiting time in minutes */
function etaMinutes(token) {
  const pos = positionOf(token);
  if (pos <= 0) return 0;
  const avg = SERVICES[token.service].avg;
  return Math.ceil(((pos - 1) * avg) / countersFor(token.service) + avg / 2);
}

function generateToken({ name, phone, service, priority }) {
  state.seq[service] += 1;
  const token = {
    id: `${service}-${pad(state.seq[service])}`,
    service,
    name,
    phone,
    priority,
    status: "waiting",       // waiting | serving | completed | skipped | cancelled
    createdAt: Date.now(),
    calledAt: null,
    completedAt: null,
    counter: null,
  };
  state.tokens.push(token);
  saveState();
  return token;
}

function callNext(counterId) {
  const counter = state.counters.find((c) => c.id === counterId);
  if (!counter) return;

  if (counter.current) {
    toast(`${counter.name} is still serving ${counter.current}. Complete or skip first.`, "warn");
    return;
  }
  const next = getWaiting(counter.service)[0];
  if (!next) {
    toast("No customers waiting for this counter.", "warn");
    return;
  }
  next.status = "serving";
  next.calledAt = Date.now();
  next.counter = counter.name;
  counter.current = next.id;
  announce(next, counter);
  saveState();
  toast(`Called ${next.id} to ${counter.name}`, "success");
}

function announce(token, counter) {
  state.recent = state.recent.filter((r) => r.token !== token.id);
  state.recent.unshift({ token: token.id, counter: counter.name });
  state.recent = state.recent.slice(0, MAX_RECENT);
  state.lastCall = { token: token.id, counter: counter.name, stamp: Date.now() };
}

function recall(counterId) {
  const counter = state.counters.find((c) => c.id === counterId);
  if (!counter || !counter.current) return toast("Nothing to recall.", "warn");
  state.lastCall = { token: counter.current, counter: counter.name, stamp: Date.now() };
  saveState();
  toast(`Recalled ${counter.current}`, "success");
}

function finishCurrent(counterId, status) {
  const counter = state.counters.find((c) => c.id === counterId);
  if (!counter || !counter.current) return toast("No active token at this counter.", "warn");
  const token = getToken(counter.current);
  token.status = status;                 // "completed" or "skipped"
  token.completedAt = Date.now();
  counter.current = null;
  saveState();
  toast(`${token.id} marked ${status}`, status === "completed" ? "success" : "warn");
}

function cancelToken(id) {
  const t = getToken(id);
  if (!t || t.status !== "waiting") return;
  t.status = "cancelled";
  t.completedAt = Date.now();
  saveState();
  toast(`${id} cancelled`, "warn");
}

function togglePriority(id) {
  const t = getToken(id);
  if (!t || t.status !== "waiting") return;
  t.priority = !t.priority;
  saveState();
}

function addCounter() {
  const nextId = Math.max(0, ...state.counters.map((c) => c.id)) + 1;
  state.counters.push({ id: nextId, name: "Counter " + nextId, service: "ALL", current: null });
  saveState();
  toast("Counter added", "success");
}

function removeCounter(id) {
  const c = state.counters.find((x) => x.id === id);
  if (!c) return;
  if (c.current) return toast("Finish the active token first.", "warn");
  if (state.counters.length <= 1) return toast("At least one counter is required.", "warn");
  state.counters = state.counters.filter((x) => x.id !== id);
  saveState();
}

function resetDay() {
  if (!confirm("This will delete ALL tokens and reset numbering. Continue?")) return;
  state = defaultState();
  saveState();
  lastTicketId = null;
  $("#ticketCard").hidden = true;
  toast("Queue reset for a fresh day", "success");
}

function exportCSV() {
  if (!state.tokens.length) return toast("No data to export.", "warn");
  const head = ["Token", "Name", "Phone", "Service", "Priority", "Status", "Counter", "Issued", "Called", "Finished"];
  const rows = state.tokens.map((t) => [
    t.id, t.name, t.phone, SERVICES[t.service].name, t.priority ? "Yes" : "No", t.status,
    t.counter || "", fmtTime(t.createdAt), t.calledAt ? fmtTime(t.calledAt) : "", t.completedAt ? fmtTime(t.completedAt) : "",
  ]);
  const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tokens-${state.date}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------------------------------------------------
   5. RENDERING
   --------------------------------------------------------- */

/* ---- Service selector on Get Token page ---- */
function renderServiceOptions() {
  const grid = $("#serviceGrid");
  if (grid.dataset.built) return;             // build only once so the selection is kept
  grid.innerHTML = Object.entries(SERVICES).map(([key, s], i) => `
    <div class="service-option">
      <input type="radio" name="service" id="svc-${key}" value="${key}" ${i === 0 ? "checked" : ""} />
      <label for="svc-${key}">
        <span class="s-icon">${s.icon}</span>
        <span class="s-name">${s.name}</span>
        <span class="s-meta">Avg. ${s.avg} min • Prefix ${key}</span>
      </label>
    </div>`).join("");
  grid.dataset.built = "1";
}

/* ---- Live queue summary ---- */
function renderLiveSummary() {
  $("#liveSummary").innerHTML = Object.entries(SERVICES).map(([key, s]) => {
    const waiting = getWaiting(key).length;
    const serving = state.tokens.filter((t) => t.service === key && t.status === "serving").map((t) => t.id).join(", ");
    return `
      <div class="summary-item">
        <div><b>${s.icon} ${s.name}</b>
          <small>${serving ? "Now serving: " + serving : "No token being served"}</small></div>
        <span class="badge-count">${waiting}</span>
      </div>`;
  }).join("");
}

/* ---- Ticket card ---- */
function renderTicket() {
  const t = lastTicketId ? getToken(lastTicketId) : null;
  const card = $("#ticketCard");
  if (!t) { card.hidden = true; return; }
  card.hidden = false;
  $("#tkNumber").textContent = t.id;
  $("#tkService").textContent = SERVICES[t.service].name;
  $("#tkName").textContent = t.name;
  $("#tkTime").textContent = fmtTime(t.createdAt);
  $("#tkPriority").hidden = !t.priority;

  if (t.status === "waiting") {
    $("#tkPos").textContent = "#" + positionOf(t);
    $("#tkEta").textContent = "~" + etaMinutes(t) + " min";
  } else {
    $("#tkPos").textContent = t.status.toUpperCase();
    $("#tkEta").textContent = "-";
  }
}

/* ---- Track page ---- */
function renderTrack() {
  const id = $("#trackInput").value.trim().toUpperCase();
  const box = $("#trackResult");
  if (!id) { box.innerHTML = ""; return; }

  const t = getToken(id);
  if (!t) {
    box.innerHTML = `<div class="track-box">❌ Token <b>${escapeHTML(id)}</b> not found for today.</div>`;
    return;
  }

  let detail = "";
  if (t.status === "waiting") {
    const pos = positionOf(t);
    const total = getWaiting(t.service).length;
    const pct = Math.round(((total - pos + 1) / total) * 100);
    detail = `
      <div class="track-meta">
        <div><span>Position in queue</span><b>#${pos}</b></div>
        <div><span>Customers ahead</span><b>${pos - 1}</b></div>
        <div><span>Estimated wait</span><b>~${etaMinutes(t)} min</b></div>
        <div><span>Issued at</span><b>${fmtTime(t.createdAt)}</b></div>
      </div>
      <div class="progress"><div style="width:${pct}%"></div></div>`;
  } else if (t.status === "serving") {
    detail = `<p style="margin-top:10px">🎉 Please proceed to <b>${escapeHTML(t.counter)}</b> now!</p>`;
  } else if (t.status === "completed") {
    detail = `<p style="margin-top:10px">✅ Served in ${fmtDuration(t.completedAt - t.calledAt)}. Thank you!</p>`;
  } else {
    detail = `<p style="margin-top:10px">This token was ${t.status}. Please generate a new token.</p>`;
  }

  box.innerHTML = `
    <div class="track-box">
      <div class="big">${t.id}</div>
      <div>${SERVICES[t.service].name} ${t.priority ? '<span class="star">⭐</span>' : ""}</div>
      <span class="status-pill st-${t.status}">${t.status}</span>
      ${detail}
    </div>`;
}

/* ---- Display board ---- */
function renderBoard() {
  const flashId = state.lastCall && Date.now() - state.lastCall.stamp < 4000 ? state.lastCall.counter : null;

  $("#counterBoard").innerHTML = state.counters.map((c) => `
    <div class="board-counter ${c.current ? "active" : ""} ${flashId === c.name ? "flash" : ""}">
      <h4>${escapeHTML(c.name)} ${c.service !== "ALL" ? "• " + SERVICES[c.service].name : ""}</h4>
      ${c.current ? `<div class="num">${c.current}</div><small>Please proceed</small>`
                  : `<div class="num idle">— Free —</div><small>Waiting for next customer</small>`}
    </div>`).join("");

  const next = getWaiting().slice(0, 8);
  $("#nextUp").innerHTML = next.length
    ? next.map((t) => `<div class="chip ${t.priority ? "priority" : ""}">${t.id}<small>${t.priority ? "⭐ Priority" : SERVICES[t.service].name}</small></div>`).join("")
    : '<span class="muted">Queue is empty.</span>';

  $("#recentCalls").innerHTML = state.recent.length
    ? state.recent.map((r) => `<div class="chip">${r.token}<small>${escapeHTML(r.counter)}</small></div>`).join("")
    : '<span class="muted">No calls yet.</span>';
}

/* ---- Admin: stats ---- */
function renderStats() {
  const done = state.tokens.filter((t) => t.status === "completed");
  const avgMs = done.length ? done.reduce((s, t) => s + (t.completedAt - t.calledAt), 0) / done.length : 0;
  const stats = [
    ["Total Tokens", state.tokens.length],
    ["Waiting", getWaiting().length],
    ["Being Served", state.tokens.filter((t) => t.status === "serving").length],
    ["Completed", done.length],
    ["Skipped / Cancelled", state.tokens.filter((t) => t.status === "skipped" || t.status === "cancelled").length],
    ["Avg Service Time", done.length ? fmtDuration(avgMs) : "-"],
  ];
  $("#stats").innerHTML = stats.map(([l, v]) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`).join("");
}

/* ---- Admin: counter cards ---- */
function renderCounterAdmin() {
  // Do not rebuild while an admin is choosing from a dropdown
  if (document.activeElement && document.activeElement.classList.contains("svc-select")) return;

  $("#counterAdmin").innerHTML = state.counters.map((c) => {
    const t = c.current ? getToken(c.current) : null;
    const opts = ['<option value="ALL">All services</option>']
      .concat(Object.entries(SERVICES).map(([k, s]) =>
        `<option value="${k}" ${c.service === k ? "selected" : ""}>${s.name}</option>`))
      .join("").replace('value="ALL"', `value="ALL" ${c.service === "ALL" ? "selected" : ""}`);

    return `
      <div class="c-card ${t ? "busy" : ""}">
        <div class="c-top">
          <b>${escapeHTML(c.name)}</b>
          <button class="btn danger small" data-action="removeCounter" data-id="${c.id}">✕</button>
        </div>
        <select class="svc-select" data-action="setService" data-id="${c.id}">${opts}</select>
        <div class="c-current">
          ${t ? `<b>${t.id}</b><small>${escapeHTML(t.name)} ${t.priority ? "⭐" : ""}</small>`
              : '<small>Counter is free</small>'}
        </div>
        <div class="c-actions">
          <button class="btn primary" data-action="callNext" data-id="${c.id}" ${t ? "disabled" : ""}>📢 Call Next</button>
          <button class="btn" data-action="recall" data-id="${c.id}" ${t ? "" : "disabled"}>🔁 Recall</button>
          <button class="btn success" data-action="complete" data-id="${c.id}" ${t ? "" : "disabled"}>✅ Complete</button>
          <button class="btn warn" data-action="skip" data-id="${c.id}" ${t ? "" : "disabled"}>⏭ Skip</button>
        </div>
      </div>`;
  }).join("");
}

/* ---- Admin: waiting table ---- */
function renderQueueTable() {
  const list = getWaiting();
  $("#queueBody").innerHTML = list.length
    ? list.map((t, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><b>${t.id}</b> ${t.priority ? '<span class="star">⭐</span>' : ""}</td>
        <td>${escapeHTML(t.name)}</td>
        <td>${escapeHTML(t.phone)}</td>
        <td>${SERVICES[t.service].name}</td>
        <td>${fmtDuration(Date.now() - t.createdAt)}</td>
        <td>
          <button class="btn small" data-action="priority" data-token="${t.id}">${t.priority ? "Remove ⭐" : "Make ⭐"}</button>
          <button class="btn danger small" data-action="cancel" data-token="${t.id}">Cancel</button>
        </td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="empty">No customers are waiting 🎉</td></tr>';
}

/* ---- Admin: history table ---- */
function renderHistory() {
  const done = state.tokens
    .filter((t) => t.status !== "waiting")
    .sort((a, b) => b.createdAt - a.createdAt);
  $("#historyBody").innerHTML = done.length
    ? done.map((t) => `
      <tr>
        <td><b>${t.id}</b></td>
        <td>${escapeHTML(t.name)}</td>
        <td>${SERVICES[t.service].name}</td>
        <td>${t.counter || "-"}</td>
        <td><span class="status-pill st-${t.status}">${t.status}</span></td>
        <td>${fmtTime(t.createdAt)}</td>
        <td>${t.calledAt && t.completedAt ? fmtDuration(t.completedAt - t.calledAt) : "-"}</td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="empty">No history yet.</td></tr>';
}

/* ---- Master render (called after every change) ---- */
function renderAll() {
  renderServiceOptions();
  renderLiveSummary();
  renderTicket();
  renderTrack();
  renderBoard();
  if (isAdmin()) {
    renderStats();
    renderCounterAdmin();
    renderQueueTable();
    renderHistory();
  }
  handleAnnouncement();
}

/** Speak a new call once per call (works across browser tabs too) */
function handleAnnouncement() {
  const lc = state.lastCall;
  if (!lc || lc.stamp <= lastAnnouncedStamp) return;
  lastAnnouncedStamp = lc.stamp;
  if (Date.now() - lc.stamp > 5000) return;      // ignore old calls on page load
  if ($("#view-board").classList.contains("active")) {
    speak(`Token number ${lc.token.replace("-", " ")}, please proceed to ${lc.counter}`);
  }
}

/* ---------------------------------------------------------
   6. EVENT HANDLERS
   --------------------------------------------------------- */
const isAdmin = () => sessionStorage.getItem("qtms_admin") === "1";

/* ---- Navigation ---- */
function showView(name) {
  $$(".view").forEach((v) => v.classList.remove("active"));
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#view-" + name).classList.add("active");
  renderAll();
}
$("#nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-btn");
  if (btn) showView(btn.dataset.view);
});

/* ---- Token form ---- */
$("#tokenForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#custName").value.trim();
  const phone = $("#custPhone").value.trim();
  const service = document.querySelector('input[name="service"]:checked').value;
  const priority = $("#custPriority").checked;

  if (name.length < 2) return toast("Please enter a valid name.", "error");
  if (!/^[0-9]{10}$/.test(phone)) return toast("Mobile number must be 10 digits.", "error");

  const token = generateToken({ name, phone, service, priority });
  lastTicketId = token.id;
  $("#tokenForm").reset();
  $("#svc-" + service).checked = true;
  renderAll();
  toast(`Token ${token.id} generated!`, "success");
});

$("#btnPrint").addEventListener("click", () => window.print());
$("#btnTrackNow").addEventListener("click", () => {
  $("#trackInput").value = lastTicketId || "";
  showView("track");
});

/* ---- Track ---- */
$("#btnTrack").addEventListener("click", renderTrack);
$("#trackInput").addEventListener("keydown", (e) => { if (e.key === "Enter") renderTrack(); });

/* ---- Board voice toggle ---- */
$("#btnSound").addEventListener("click", () => {
  voiceOn = !voiceOn;
  $("#btnSound").textContent = "🔊 Voice: " + (voiceOn ? "ON" : "OFF");
  if (voiceOn) speak("Voice announcements enabled");
});

/* ---- Admin login ---- */
function updateAdminUI() {
  $("#adminLogin").hidden = isAdmin();
  $("#adminPanel").hidden = !isAdmin();
}
$("#btnLogin").addEventListener("click", () => {
  if ($("#adminPin").value === ADMIN_PIN) {
    sessionStorage.setItem("qtms_admin", "1");
    $("#adminPin").value = "";
    updateAdminUI();
    renderAll();
    toast("Welcome, Admin!", "success");
  } else {
    toast("Incorrect PIN.", "error");
  }
});
$("#adminPin").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnLogin").click(); });
$("#btnLogout").addEventListener("click", () => {
  sessionStorage.removeItem("qtms_admin");
  updateAdminUI();
});

/* ---- Admin top buttons ---- */
$("#btnAddCounter").addEventListener("click", () => { addCounter(); renderAll(); });
$("#btnExport").addEventListener("click", exportCSV);
$("#btnReset").addEventListener("click", () => { resetDay(); renderAll(); });

/* ---- Admin: buttons inside counters / tables (event delegation) ---- */
$("#adminPanel").addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.tagName === "SELECT") return;
  const id = Number(el.dataset.id);
  const action = el.dataset.action;

  if (action === "callNext") callNext(id);
  else if (action === "recall") recall(id);
  else if (action === "complete") finishCurrent(id, "completed");
  else if (action === "skip") finishCurrent(id, "skipped");
  else if (action === "removeCounter") removeCounter(id);
  else if (action === "cancel") cancelToken(el.dataset.token);
  else if (action === "priority") togglePriority(el.dataset.token);
  renderAll();
});

$("#adminPanel").addEventListener("change", (e) => {
  if (e.target.dataset.action === "setService") {
    const c = state.counters.find((x) => x.id === Number(e.target.dataset.id));
    if (c) { c.service = e.target.value; saveState(); }
    e.target.blur();
    renderAll();
  }
});

/* ---- Sync between browser tabs (e.g. admin tab + display board tab) ---- */
window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY && e.newValue) {
    state = JSON.parse(e.newValue);
    renderAll();
  }
});

/* ---------------------------------------------------------
   7. INITIALISATION
   --------------------------------------------------------- */
function tickClock() {
  $("#clock").textContent = new Date().toLocaleTimeString();
}

function init() {
  updateAdminUI();
  renderAll();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(renderAll, 5000);   // keeps waiting times & ETAs fresh
}
init();
