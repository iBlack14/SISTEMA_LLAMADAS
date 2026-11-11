import { requireLogin, bindAccountControls, apiFetch } from "./modules/auth.js";

let snapshot;
let socket;
let lastReceived = 0;
let historyTimer;
let historyKeyLoaded = "";
const cards = new Map();
const orbs = new Map();
const histories = new Map();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "Sin datos";
const value = n => typeof n === "number" ? n.toLocaleString("es-PE") : "—";
const resultLabels = { contesto: "Contestó", sin_respuesta: "Sin respuesta", no_contesto: "No contestó", no_contactado: "No contactado", buzon_de_voz: "Buzón de voz", sin_servicio: "Sin servicio", no_disponible: "No disponible", numero_incorrecto: "Número incorrecto" };

const ORB = {
  "En llamada": { border: "border-[#39ffb4]", text: "text-[#39ffb4]", pulse: "orb-pulse-green", badge: "bg-[#39ffb4] text-[#00391d]", icon: "call", spin: false, label: "En llamada", wave: true, hover: "hover:border-[#39ffb4]/40" },
  "Marcando": { border: "border-[#ffb236]", text: "text-[#ffb236]", pulse: "orb-pulse-amber", badge: "bg-[#ffb236] text-[#3d2400]", icon: "ring_volume", spin: true, label: "Marcando", wave: false, hover: "hover:border-[#ffb236]/40" },
  "Disponible": { border: "border-outline-variant/60", text: "text-on-surface-variant", pulse: "", badge: "bg-outline-variant/80 text-on-surface", icon: "pause", spin: false, label: "Espera", wave: false, hover: "hover:border-secondary/40" },
  "Desconectado": { border: "border-error", text: "text-error", pulse: "orb-pulse-red", badge: "bg-error text-[#410002]", icon: "error", spin: false, label: "Fallo SIP", wave: false, hover: "hover:border-error/40" },
  "Sin datos": { border: "border-outline-variant/60", text: "text-on-surface-variant", pulse: "", badge: "bg-outline-variant/80 text-on-surface", icon: "help", spin: false, label: "—", wave: false, hover: "hover:border-secondary/40" }
};

const PILL = {
  "En llamada": { cls: "bg-[#39ffb4]/15 text-[#39ffb4] border-[#39ffb4]/35", dot: "bg-[#39ffb4] animate-ping", icon: "", text: "EN LLAMADA" },
  "Marcando": { cls: "bg-[#ffb236]/15 text-[#ffb236] border-[#ffb236]/35", dot: "", icon: '<span class="material-symbols-outlined text-xs animate-spin" data-icon="progress_activity">progress_activity</span>', text: "MARCANDO" },
  "Disponible": { cls: "bg-surface-container-high text-on-surface-variant border-outline-variant/40", dot: "bg-outline-variant", icon: "", text: "DISPONIBLE" },
  "Desconectado": { cls: "bg-[#ffb4ab]/15 text-error border-error/40", dot: "bg-error", icon: "", text: "DESCONECTADO" },
  "Sin datos": { cls: "bg-surface-container-high text-on-surface-variant border-outline-variant/40", dot: "bg-outline-variant", icon: "", text: "SIN DATOS" }
};

const CARD_TONE = {
  "En llamada": { border: "border-primary-container/30", icon: "bg-[#39ffb4]/10 border-[#39ffb4]/30 text-[#39ffb4]" },
  "Marcando": { border: "border-[#ffb236]/30", icon: "bg-[#ffb236]/10 border-[#ffb236]/30 text-[#ffb236]" },
  "Disponible": { border: "border-outline-variant/30", icon: "bg-surface-container border-outline-variant/40 text-secondary" },
  "Desconectado": { border: "border-error/40", icon: "bg-error/10 border-error/40 text-error" },
  "Sin datos": { border: "border-outline-variant/20", icon: "bg-surface-container border-outline-variant/40 text-on-surface-variant" }
};

const WAVE = '<div class="telecom-wave mt-1"><span></span><span></span><span></span><span></span><span></span></div>';

function displayState(item, live) {
  if (!live) return "Sin datos";
  const s = item.state;
  return (s === "Sin vincular" || s === "Sin datos") ? "Sin datos" : s;
}

function createOrb(number) {
  const el = document.createElement("div");
  el.className = "flex flex-col items-center gap-2 p-2 rounded-xl bg-surface-container-lowest/50 border border-outline-variant/20 group transition-all cursor-pointer";
  el.dataset.number = number;
  el.innerHTML = `<div class="relative">
      <div class="orb-circle w-12 h-12 rounded-full bg-[#170624] border-2 flex items-center justify-center"><span class="font-mono font-bold text-sm orb-num"></span></div>
      <span class="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center orb-badge"></span>
    </div>
    <div class="text-center">
      <span class="block text-[11px] font-mono text-on-surface font-semibold orb-name"></span>
      <span class="orb-sub block text-[10px] mt-1"></span>
    </div>`;
  el.addEventListener("click", () => {
    const card = cards.get(number);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("equipmentIndicators").appendChild(el);
  orbs.set(number, el);
  return el;
}

function renderOrb(el, number, state, name) {
  const cfg = ORB[state] || ORB["Sin datos"];
  el.className = `flex flex-col items-center gap-2 p-2 rounded-xl bg-surface-container-lowest/50 border border-outline-variant/20 group ${cfg.hover} transition-all cursor-pointer`;
  el.setAttribute("aria-label", `Equipo ${number} · ${name || ""} · ${state}`);
  const circle = el.querySelector(".orb-circle");
  circle.className = `orb-circle w-12 h-12 rounded-full bg-[#170624] border-2 ${cfg.border} flex items-center justify-center ${cfg.pulse}`;
  const num = el.querySelector(".orb-num");
  num.className = `font-mono font-bold text-sm ${cfg.text}`;
  num.textContent = String(number).padStart(2, "0");
  const badge = el.querySelector(".orb-badge");
  badge.className = `absolute -top-1 -right-1 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center ${cfg.badge} ${cfg.spin ? "animate-spin" : ""}`;
  badge.innerHTML = `<span class="material-symbols-outlined" style="font-size:10px">${cfg.icon}</span>`;
  el.querySelector(".orb-name").textContent = name || `Nodo-${String(number).padStart(2, "0")}`;
  const sub = el.querySelector(".orb-sub");
  if (state === "En llamada") {
    sub.className = "orb-sub block mt-1";
    sub.innerHTML = WAVE;
  } else {
    sub.className = `orb-sub block text-[10px] mt-1 ${state === "Marcando" ? "text-[#ffb236] font-mono" : state === "Desconectado" ? "text-error font-mono" : "text-on-surface-variant"}`;
    sub.textContent = cfg.label;
  }
}

function statCell(label, val, cls = "text-on-surface") {
  return `<div><span class="text-[10px] text-on-surface-variant uppercase block">${label}</span><span class="text-sm font-bold ${cls}">${val}</span></div>`;
}

function resultPill(row) {
  if (!row.endedAt) return '<span class="inline-block px-1.5 py-0.5 rounded text-[10px] bg-outline-variant/20 text-on-surface-variant border border-outline-variant/40">En curso</span>';
  const map = {
    ok: ['bg-[#39ffb4]/10 text-[#39ffb4] border-[#39ffb4]/30', "Conectada"],
    warn: ['bg-[#ffb236]/10 text-[#ffb236] border-[#ffb236]/30', "Ocupado"],
    err: ['bg-error/10 text-error border-error/30', "Error"]
  };
  const [cls, fallback] = map[row.category] || ['bg-outline-variant/20 text-on-surface-variant border-outline-variant/40', "Sin Respuesta"];
  const label = resultLabels[row.result] || row.result || fallback;
  const display = row.category === "ok" ? "Conectada" : row.category === "warn" ? (label === "Buzón de voz" ? "Buzón" : label) : label;
  return `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] ${cls} border">${esc(display)}</span>`;
}

function createCard(number) {
  const card = document.createElement("div");
  card.className = "glass-card-interactive rounded-xl p-5 border relative flex flex-col net-card";
  card.id = `equip-${number}`;
  card.innerHTML = `<div>
    <div class="flex items-start justify-between pb-3 border-b border-outline-variant/20">
      <div class="flex items-center gap-3">
        <div class="card-icon w-10 h-10 rounded-xl border flex items-center justify-center"><span class="material-symbols-outlined" data-icon="smartphone">smartphone</span></div>
        <div>
          <div class="flex items-center gap-2"><h3 class="font-title-md text-title-md font-bold text-on-surface card-title"></h3><span class="font-mono text-xs text-outline card-model"></span></div>
          <div class="flex items-center gap-3 text-xs text-on-surface-variant mt-0.5 card-meta"></div>
        </div>
      </div>
      <div class="flex flex-col items-end gap-1">
        <span class="card-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-bold border"></span>
        <span class="text-[10px] text-on-surface-variant font-mono card-id"></span>
      </div>
    </div>
    <div class="grid grid-cols-3 gap-2 my-3 py-2 px-3 rounded-lg bg-surface-container-lowest/60 border border-outline-variant/20 text-center font-mono card-stats"></div>
    <div class="card-live mb-4" hidden></div>
    <div>
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-label-md text-on-surface-variant uppercase tracking-wider font-semibold">Últimos Intentos de Marcación</span>
        <span class="text-[10px] text-primary font-mono card-activity"></span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs font-mono">
          <thead><tr class="text-on-surface-variant border-b border-outline-variant/30 text-[10px]">
            <th class="pb-1.5 font-medium">CONTACTO / NÚMERO</th><th class="pb-1.5 font-medium">HORA</th><th class="pb-1.5 font-medium">DURACIÓN</th><th class="pb-1.5 font-medium text-right">RESULTADO</th>
          </tr></thead>
          <tbody class="divide-y divide-outline-variant/15 text-on-surface card-rows"></tbody>
        </table>
      </div>
    </div>
  </div>
  <div class="mt-4 pt-3 border-t border-outline-variant/20 flex items-center justify-between text-xs">
    <span class="text-on-surface-variant font-mono text-[11px] card-scope"></span>
    <span class="text-[10px] text-outline font-mono card-test" hidden>PRUEBA SIMULADA</span>
  </div>`;
  $("equipmentGrid").appendChild(card);
  cards.set(number, card);
  return card;
}

function renderCard(card, item, state, live) {
  const tone = CARD_TONE[state] || CARD_TONE["Sin datos"];
  const pill = PILL[state] || PILL["Sin datos"];
  card.className = `glass-card-interactive rounded-xl p-5 border ${tone.border} relative flex flex-col net-card`;
  card.dataset.state = state;
  card.dataset.search = `${item.number} ${item.name || ""} ${item.rubro || ""}`.toLowerCase();

  card.querySelector(".card-icon").className = `card-icon w-10 h-10 rounded-xl border flex items-center justify-center ${tone.icon}`;
  card.querySelector(".card-title").textContent = `Equipo ${String(item.number).padStart(2, "0")}`;
  const model = (item.name || "").replace(/\bCelular\b/gi, "Equipo").replace(/^Equipo\s*\d*\s*/i, "").trim();
  const modelEl = card.querySelector(".card-model");
  modelEl.textContent = model ? `• ${model}` : "";
  modelEl.hidden = !model;

  const meta = card.querySelector(".card-meta");
  const metaParts = [];
  if (item.rubro) metaParts.push(`<span class="flex items-center gap-1"><span class="material-symbols-outlined text-xs text-primary" data-icon="sell">sell</span>${esc(item.rubro)}</span>`);
  if (item.schedule) metaParts.push(`<span class="flex items-center gap-1 font-mono"><span class="material-symbols-outlined text-xs" data-icon="schedule">schedule</span>${esc(item.schedule)}</span>`);
  meta.innerHTML = metaParts.join("");

  const pillEl = card.querySelector(".card-pill");
  pillEl.className = `card-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-bold border ${pill.cls}`;
  pillEl.innerHTML = `${pill.dot ? `<span class="w-2 h-2 rounded-full ${pill.dot}"></span>` : ""}${pill.icon}${pill.text}`;
  card.querySelector(".card-id").textContent = `ID: NODO-CL-${String(item.number).padStart(2, "0")}`;

  const m = item.metrics || {};
  const hasTurn = Boolean(item.turn?.id && item.turn?.startedAt);
  const showStats = hasTurn && (m.total !== undefined || item.pending !== undefined);
  card.querySelector(".card-stats").innerHTML = showStats
    ? statCell("Total", value(m.total)) + `<div class="border-x border-outline-variant/20">${statCell("Contestadas", value(m.answered), "text-primary")}</div>` + statCell("Pendientes", value(item.pending ?? m.pending), "text-[#ffb236]")
    : `<div class="col-span-3 text-[11px] text-on-surface-variant py-1">${esc(!hasTurn ? "No hay un turno activo verificable." : item.scopeReason || "Sin datos para un turno verificable.")}</div>`;

  const liveBox = card.querySelector(".card-live");
  const inCall = live && item.calling && item.state === "En llamada";
  const dialing = live && item.calling && item.state === "Marcando";
  if (inCall) {
    liveBox.hidden = false;
    liveBox.className = "card-live p-3 rounded-xl bg-gradient-to-r from-primary-container/15 via-secondary-container/10 to-transparent border border-primary-container/30 mb-4 relative overflow-hidden";
    liveBox.innerHTML = `<div class="flex items-center justify-between">
      <div class="flex items-center gap-2.5">
        <div class="w-8 h-8 rounded-lg bg-primary-container/30 flex items-center justify-center text-primary"><span class="material-symbols-outlined text-base" data-icon="phone_in_talk">phone_in_talk</span></div>
        <div>
          <div class="flex items-center gap-2"><span class="text-xs text-on-surface-variant uppercase">Contacto actual:</span><span class="font-mono font-bold text-on-surface text-sm">${esc(item.calling?.number || item.calling?.contact || "—")}</span></div>
          <div class="text-[11px] text-on-surface-variant font-mono">Llamada activa</div>
        </div>
      </div>
      <div class="text-right"><span class="text-[10px] text-on-surface-variant uppercase block">Duración</span><span class="font-mono text-base font-extrabold text-[#39ffb4]">${item.calling?.duration ? `${Math.floor(item.calling.duration / 60)}:${String(item.calling.duration % 60).padStart(2, "0")}` : "—"}</span></div>
    </div>`;
  } else if (dialing) {
    liveBox.hidden = false;
    liveBox.className = "card-live p-3 rounded-xl bg-gradient-to-r from-[#ffb236]/15 via-transparent to-transparent border border-[#ffb236]/30 mb-4 flex items-center justify-between";
    liveBox.innerHTML = `<div class="flex items-center gap-2.5">
      <div class="w-8 h-8 rounded-lg bg-[#ffb236]/20 flex items-center justify-center text-[#ffb236]"><span class="material-symbols-outlined text-base animate-bounce" data-icon="ring_volume">ring_volume</span></div>
      <div>
        <div class="flex items-center gap-2"><span class="text-xs text-on-surface-variant uppercase">Destino saliente:</span><span class="font-mono font-bold text-on-surface text-sm">${esc(item.calling?.number || item.calling?.contact || "—")}</span></div>
        <div class="text-[11px] text-[#ffb236] font-mono">Señal de timbrado SIP 180 Ringing…</div>
      </div>
    </div>`;
  } else {
    liveBox.hidden = true;
    liveBox.innerHTML = "";
  }

  const hasActivity = Boolean(item.lastActivityAt && Number.isFinite(Date.parse(item.lastActivityAt)));
  card.querySelector(".card-activity").textContent = hasActivity ? date(item.lastActivityAt) : "";
  card.querySelector(".card-scope").textContent = (item.scopeReason || (item.turn ? item.turn.label : "Sin un turno verificable.")).replace(/\bcelular\b/gi, "equipo");
  card.querySelector(".card-test").hidden = !item.simulated;
  renderCardHistory(card, item);
}

function renderCardHistory(card, item) {
  const tbody = card.querySelector(".card-rows");
  const cached = histories.get(item.number);
  const rows = cached?.key === historyKey(item) ? cached.activity : null;
  tbody.innerHTML = rows === null
    ? `<tr><td colspan="4" class="py-3 text-center text-on-surface-variant">Cargando actividad…</td></tr>`
    : !rows.length
      ? `<tr><td colspan="4" class="py-3 text-center text-on-surface-variant">${esc(item.metrics ? "No hay intentos registrados en este turno." : "Sin datos para un turno verificable.")}</td></tr>`
      : rows.map(row => `<tr>
          <td class="py-1.5 text-on-surface">${esc(row.name)}<br><span class="text-[10px] text-on-surface-variant">${esc(row.list || "Sin rubro")}</span></td>
          <td class="py-1.5 text-on-surface-variant">${esc(date(row.startedAt))}</td>
          <td class="py-1.5 ${row.endedAt ? "text-on-surface" : "text-[#ffb236]"}">${row.durationSeconds === null ? "—" : row.endedAt ? `${Math.floor(row.durationSeconds / 60)}:${String(row.durationSeconds % 60).padStart(2, "0")}` : "En curso"}</td>
          <td class="py-1.5 text-right">${resultPill(row)}</td>
        </tr>`).join("");
}

const historyKey = item => JSON.stringify([item.deviceId, item.turn?.id, item.historyVersion]);

async function loadAllHistories() {
  if (!snapshot) return;
  const key = snapshot.equipment.map(historyKey).join("|");
  if (key === historyKeyLoaded) return;
  historyKeyLoaded = key;
  const numbers = snapshot.equipment.map(e => e.number).join(",");
  try {
    const response = await apiFetch(`/api/admin/network/activity?equipment=${numbers}`, { cache: "no-store" });
    if (!response.ok) throw new Error("error");
    const data = await response.json();
    for (const item of data.equipment) {
      histories.set(item.number, { key: historyKey(item), activity: item.activity });
      const card = cards.get(item.number);
      const current = snapshot.equipment.find(e => e.number === item.number);
      if (card && current && historyKey(current) === historyKey(item)) renderCardHistory(card, current);
    }
  } catch {
    for (const item of snapshot.equipment) {
      const card = cards.get(item.number);
      if (card) card.querySelector(".card-rows").innerHTML = `<tr><td colspan="4" class="py-3 text-center text-on-surface-variant">No se pudo cargar la actividad.</td></tr>`;
    }
  }
}

let filterState = "all";
let filterQuery = "";

function applyFilters() {
  for (const item of snapshot?.equipment || []) {
    const card = cards.get(item.number);
    if (!card) continue;
    const state = card.dataset.state;
    const matchState = filterState === "all" || state === filterState;
    const matchQuery = !filterQuery || (card.dataset.search || "").includes(filterQuery);
    card.style.display = matchState && matchQuery ? "" : "none";
  }
}

function updateFilterCounts() {
  const counts = { all: 0, "En llamada": 0, "Marcando": 0, "Disponible": 0, "Desconectado": 0 };
  for (const card of cards.values()) {
    counts.all++;
    if (counts[card.dataset.state] !== undefined) counts[card.dataset.state]++;
  }
  document.querySelectorAll("#stateFilters .filter-pill").forEach(btn => {
    const f = btn.dataset.filter;
    const base = btn.dataset.label || (btn.dataset.label = btn.textContent.trim());
    btn.textContent = `${base} (${counts[f] ?? 0})`;
  });
}

function render() {
  if (!snapshot) return;
  const live = Boolean(socket?.connected && Date.now() - lastReceived < 6000);
  const legend = { active: 0, dialing: 0, ready: 0, offline: 0, none: 0 };
  const disconnected = [];

  $("liveStatus").textContent = live ? "En vivo · Conectado al servidor" : "Sin conexión en vivo · Esperando al servidor";
  $("liveDot").className = `inline-block w-2 h-2 rounded-full animate-pulse ${live ? "bg-[#39ffb4]" : "bg-outline-variant"}`;
  $("updatedAt").textContent = `Actualizado ${date(snapshot.generatedAt)}`;
  $("nodeCount").textContent = `${snapshot.equipment.length} Nodos${live ? " Conectados" : ""}`;
  $("syncStatus").textContent = live ? "Cluster Android Sync: En Línea" : "Cluster Android Sync: Sin conexión";
  $("equipmentTitle").textContent = `Estado General de Dispositivos (${snapshot.equipment.length} Nodos${live ? " en Línea" : ""})`;

  for (const item of snapshot.equipment) {
    const state = displayState(item, live);
    if (state === "En llamada") legend.active++;
    else if (state === "Marcando") legend.dialing++;
    else if (state === "Disponible") legend.ready++;
    else if (state === "Desconectado") { legend.offline++; disconnected.push(item); }
    else legend.none++;

    const orb = orbs.get(item.number) || createOrb(item.number);
    renderOrb(orb, item.number, state, item.name?.replace(/\bCelular\b/gi, "Equipo"));

    const card = cards.get(item.number) || createCard(item.number);
    renderCard(card, item, state, live);
  }

  $("legendActive").textContent = legend.active;
  $("legendDialing").textContent = legend.dialing;
  $("legendReady").textContent = legend.ready;
  $("legendOffline").textContent = legend.offline;
  $("legendNone").textContent = legend.none;

  const m = snapshot.summary?.metrics;
  const knownSummary = Boolean(m);
  $("turnUnavailable").hidden = knownSummary;
  if (knownSummary) {
    const total = m.total || 0;
    const answered = m.answered || 0;
    const pending = snapshot.summary.pending ?? m.pending ?? 0;
    const progress = m.inProgress || 0;
    const contactRate = total ? Math.round((answered / total) * 1000) / 10 : null;
    $("kpiTotal").textContent = value(m.total);
    $("kpiTotalBar").style.width = `${total ? Math.min(100, ((answered + (m.unanswered || 0) + progress) / total) * 100) : 0}%`;
    $("kpiTotalPct").textContent = "";
    $("kpiAnswered").textContent = value(m.answered);
    $("kpiAnsweredSub").textContent = "Tasa de contacto";
    $("kpiAnsweredPct").textContent = contactRate === null ? "" : `${contactRate}%`;
    $("kpiAnsweredBar").style.width = `${contactRate ?? 0}%`;
    $("kpiPending").textContent = value(pending);
    $("kpiPendingPct").textContent = total + pending ? `${Math.round((pending / (total + pending)) * 100)}%` : "";
    $("kpiPendingBar").style.width = `${total + pending ? (pending / (total + pending)) * 100 : 0}%`;
    $("kpiProgress").textContent = value(progress);
    $("kpiProgressPct").textContent = `${progress}/10`;
    $("kpiProgressBar").style.width = `${(progress / 10) * 100}%`;
  }

  const banner = $("alertBanner");
  if (disconnected.length && live) {
    banner.hidden = false;
    $("alertTitle").textContent = `Alerta de Enlace: ${disconnected.length} equipo(s) fuera de línea`;
    $("alertText").textContent = disconnected.map(e => `Equipo ${e.number}${e.name ? ` (${e.name.replace(/\bCelular\b/gi, "Equipo")})` : ""}`).join(" · ");
  } else {
    banner.hidden = true;
  }

  $("overflowNotice").hidden = !snapshot.overflow;
  $("overflowNotice").textContent = snapshot.overflow ? `${snapshot.overflow} equipo(s) adicional(es) fuera de las 10 posiciones.` : "";
  $("autoBalance").style.display = snapshot.overflow ? "none" : "";

  updateFilterCounts();
  applyFilters();
  clearTimeout(historyTimer);
  historyTimer = setTimeout(loadAllHistories, 400);
}

function accept(data) {
  if (data.unavailable || !Array.isArray(data.equipment)) return unavailable();
  snapshot = data; lastReceived = Date.now();
  render();
}
function unavailable() { lastReceived = 0; render(); }

function updateSyncLabel() {
  const el = $("syncLabel");
  if (!el || !lastReceived) { if (el) el.textContent = "Sincronización activa"; return; }
  const secs = Math.max(0, Math.floor((Date.now() - lastReceived) / 1000));
  el.textContent = `Sincronización activa: hace ${secs} segundo${secs === 1 ? "" : "s"}`;
}

try {
  const user = await requireLogin();
  if (user.role !== "ADMINISTRADOR") window.location.replace("/");
  else {
    bindAccountControls();
    const response = await apiFetch("/api/admin/network", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo cargar Núcleo de Red.");
    snapshot = await response.json(); render();

    $("refreshButton").addEventListener("click", async () => {
      $("refreshButton").disabled = true;
      try {
        const r = await apiFetch("/api/admin/network", { cache: "no-store" });
        if (r.ok) { snapshot = await r.json(); lastReceived = Date.now(); render(); }
      } finally { $("refreshButton").disabled = false; }
    });
    $("downloadLog").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `nucleo-red-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $("searchInput").addEventListener("input", e => { filterQuery = e.target.value.trim().toLowerCase(); applyFilters(); });
    document.querySelectorAll("#stateFilters .filter-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        filterState = btn.dataset.filter;
        document.querySelectorAll("#stateFilters .filter-pill").forEach(b => b.classList.toggle("active", b === btn));
        applyFilters();
      });
    });
    document.querySelector('#stateFilters .filter-pill[data-filter="all"]').classList.add("active");

    socket = window.io(window.location.origin, { transports: ["websocket"], auth: { client: "dashboard", userId: user.id } });
    socket.on("connect", () => socket.emit("admin:subscribe", result => { if (!result?.ok) unavailable(); }));
    socket.on("admin:network", accept);
    socket.on("disconnect", unavailable);
    socket.on("connect_error", error => { unavailable(); if (["AUTH_REQUIRED", "AUTH_CHANGED"].includes(error.message)) window.location.replace("/login"); });
    socket.on("session:error", data => { unavailable(); $("accountError").textContent = data.message; if (data.reason === "AUTH_REQUIRED") window.location.replace("/login"); });
    setInterval(() => { updateSyncLabel(); if (lastReceived && Date.now() - lastReceived >= 6000) unavailable(); }, 1000);
    updateSyncLabel();
  }
} catch (error) { $("accountError").textContent = error.message; unavailable(); }
