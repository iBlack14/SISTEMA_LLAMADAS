import { requireLogin, bindAccountControls, apiFetch } from "./modules/auth.js";

let snapshot;
let socket;
let lastReceived = 0;
let historyTimer;
let historyBusy = false;
const cards = new Map();
const indicators = new Map();
const histories = new Map();
const pendingHistories = new Set();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "Sin datos";
const value = n => typeof n === "number" ? n.toLocaleString("es-PE") : "—";
const metricLabels = { total: "Total de llamadas", answered: "Contestadas", unanswered: "No contestadas", pending: "Pendientes", inoperable: "Inoperable", inProgress: "En curso", unclassified: "Sin clasificar" };
const primaryLabels = { total: "Total de llamadas", answered: "Contestadas", pending: "Pendientes" };
const secondaryLabels = { unanswered: "No contestadas", inoperable: "Inoperable", inProgress: "En curso", unclassified: "Sin clasificar" };
const resultLabels = { contesto: "Contestó", sin_respuesta: "Sin respuesta", no_contesto: "No contestó", no_contactado: "No contactado", buzon_de_voz: "Buzón de voz", sin_servicio: "Sin servicio", no_disponible: "No disponible", numero_incorrecto: "Número incorrecto" };
const historyKey = item => JSON.stringify([item.deviceId, item.turn?.id, item.historyVersion]);
const statClass = { total: "stat-primary", answered: "stat-green", pending: "stat-amber" };

function metrics(target, counts, pending, labels = metricLabels) {
  const html = Object.entries(labels).map(([key, label]) => {
    const count = key === "pending" ? pending : counts?.[key];
    const known = typeof count === "number";
    return `<div class="net-stat ${statClass[key] || ""}"><span class="stat-label">${label}</span><span class="stat-value"${known ? "" : ' title="Dato desconocido"'}>${known ? value(count) : "—"}</span></div>`;
  }).join("");
  if (target.innerHTML !== html) target.innerHTML = html;
}

function createCard(number) {
  const card = document.createElement("article");
  card.className = "net-card";
  card.dataset.equipment = number;
  card.setAttribute("aria-labelledby", `equipment-title-${number}`);
  card.innerHTML = `<header class="net-card-head"><div><h3 id="equipment-title-${number}">Equipo ${number}</h3><p class="net-card-sub" data-field="name"></p></div><span class="net-state" data-field="state">Sin datos</span></header>
    <p class="net-test" data-field="test" hidden>Prueba simulada</p>
    <p class="net-activity" data-field="activity" hidden></p>
    <p class="net-context" data-field="context"></p>
    <div class="net-live" data-field="live" hidden><div><span class="live-label">Llamada en curso</span><div class="live-number" data-field="liveNumber"></div></div><span class="live-duration" data-field="liveDuration"></span></div>
    <div class="net-stats" data-field="metrics" aria-label="Métricas principales del turno"></div>
    <details class="net-details"><summary>Ver detalle del turno</summary>
      <div class="net-detail-body">
        <p><strong>Rubro:</strong> <span data-field="rubro">—</span> · <strong>Horario:</strong> <span data-field="schedule">—</span></p>
        <p data-field="scope"></p>
        <div class="net-stats" data-field="secondary" aria-label="Métricas secundarias del turno"></div>
        <table class="net-history"><caption style="text-align:left;font-size:10px;color:var(--muted);padding:6px 0">Equipo ${number} · Hasta 30 intentos recientes</caption><thead><tr><th>Empresa / contacto</th><th>Hora Lima</th><th>Duración</th><th>Resultado</th></tr></thead><tbody data-field="rows"></tbody></table>
      </div></details>`;
  card.querySelector("details").addEventListener("toggle", () => {
    const item = snapshot?.equipment.find(e => e.number === number);
    if (item && card.querySelector("details").open) requestHistory(item);
    else pendingHistories.delete(number);
  });
  $("equipmentGrid").appendChild(card);
  cards.set(number, card);
  return card;
}

function renderHistory(item, error) {
  const card = cards.get(item.number);
  if (!card?.querySelector("details").open) return;
  const cached = histories.get(item.number);
  const rows = cached?.key === historyKey(item) ? cached.activity : null;
  card.querySelector('[data-field="rows"]').innerHTML = error || rows === null || !rows.length
    ? `<tr><td colspan="4" class="net-history-empty">${esc(error || (rows === null ? "Cargando actividad…" : item.metrics ? "No hay intentos registrados en este turno." : "Sin datos para un turno verificable."))}</td></tr>`
    : rows.map(row => `<tr><td>${esc(row.name)}<br><small style="color:var(--muted)">${esc(row.list || "Sin rubro")}</small></td><td>${esc(date(row.startedAt))}</td><td>${row.durationSeconds === null ? "Sin datos" : `${Math.floor(row.durationSeconds / 60)}:${String(row.durationSeconds % 60).padStart(2, "0")}`}</td><td><span class="result-pill ${row.endedAt ? (row.category === "ok" ? "ok" : row.category === "warn" ? "warn" : "err") : "mut"}">${esc(!row.endedAt ? "En curso" : resultLabels[row.result] || row.result || "Sin clasificar")}</span></td></tr>`).join("");
}

function requestHistory(item) {
  if (histories.get(item.number)?.key === historyKey(item)) { renderHistory(item); return; }
  pendingHistories.add(item.number);
  renderHistory(item);
  clearTimeout(historyTimer);
  historyTimer = setTimeout(loadHistories, 100);
}

async function loadHistories() {
  if (historyBusy) return;
  const numbers = [...pendingHistories].filter(n => {
    const details = cards.get(n)?.querySelector("details");
    return details?.open;
  });
  pendingHistories.clear();
  if (!numbers.length) return;
  historyBusy = true;
  try {
    const response = await apiFetch(`/api/admin/network/activity?equipment=${numbers.join(",")}`, { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo cargar la actividad. Cierra y vuelve a abrir para reintentar.");
    const data = await response.json();
    for (const item of data.equipment) {
      histories.set(item.number, { key: historyKey(item), activity: item.activity });
      const current = snapshot?.equipment.find(e => e.number === item.number);
      if (current && historyKey(current) === historyKey(item)) renderHistory(current);
    }
  } catch (error) {
    for (const number of numbers) {
      const item = snapshot?.equipment.find(e => e.number === number);
      if (item) renderHistory(item, error.message);
    }
  } finally {
    historyBusy = false;
    if (pendingHistories.size) historyTimer = setTimeout(loadHistories, 100);
  }
}

const orbBadge = {
  "En llamada": '<span class="material-symbols-outlined" style="font-size:10px">call</span>',
  "Marcando": '<span class="material-symbols-outlined" style="font-size:10px">ring_volume</span>',
  "Disponible": '<span class="material-symbols-outlined" style="font-size:10px">pause</span>',
  "Desconectado": '<span class="material-symbols-outlined" style="font-size:10px">error</span>',
  "Sin datos": '<span class="material-symbols-outlined" style="font-size:10px">help</span>'
};

function render() {
  if (!snapshot) return;
  const live = Boolean(socket?.connected && Date.now() - lastReceived < 6000);
  const legend = { active: 0, dialing: 0, ready: 0, offline: 0, none: 0 };
  const disconnected = [];

  for (const item of snapshot.equipment) {
    const state = live ? item.state : "Sin datos";
    const inCall = live && item.calling && item.state === "En llamada";

    if (state === "En llamada") legend.active++;
    else if (state === "Marcando") legend.dialing++;
    else if (state === "Disponible") legend.ready++;
    else if (state === "Desconectado") { legend.offline++; disconnected.push(item); }
    else legend.none++;

    let indicator = indicators.get(item.number);
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "net-orb";
      indicator.tabIndex = 0;
      indicator.setAttribute("role", "img");
      indicator.dataset.number = item.number;
      indicator.innerHTML = `<div class="orb-circle"><span class="orb-num"></span><span class="orb-badge"></span></div><span class="orb-name"></span><span class="orb-state"></span>`;
      $("equipmentIndicators").appendChild(indicator);
      indicators.set(item.number, indicator);
    }
    const deviceName = item.name?.replace(/\bCelular\b/gi, "Equipo");
    const description = [`Equipo ${item.number}`, deviceName && deviceName !== `Equipo ${item.number}` ? deviceName : null, state, item.simulated ? "Prueba simulada" : null].filter(Boolean).join(" · ");
    indicator.setAttribute("aria-label", description);
    indicator.dataset.state = state;
    indicator.querySelector(".orb-num").textContent = String(item.number).padStart(2, "0");
    indicator.querySelector(".orb-badge").innerHTML = orbBadge[state] || orbBadge["Sin datos"];
    indicator.querySelector(".orb-name").textContent = `Nodo-${String(item.number).padStart(2, "0")}`;
    indicator.querySelector(".orb-state").textContent = state === "En llamada" ? "En llamada" : state === "Marcando" ? "Marcando" : state === "Disponible" ? "Espera" : state === "Desconectado" ? "Fallo" : "—";

    const card = cards.get(item.number) || createCard(item.number);
    card.dataset.state = state;
    const field = name => card.querySelector(`[data-field="${name}"]`);
    field("state").textContent = state;
    field("state").dataset.state = state;
    const name = item.name?.replace(/\bCelular\b/gi, "Equipo");
    card.querySelector("h3").title = name || `Equipo ${item.number}`;
    field("name").textContent = name === `Equipo ${item.number}` ? "" : name || "";
    field("name").hidden = !field("name").textContent;
    field("test").hidden = !item.simulated;
    const hasActivity = Boolean(item.lastActivityAt && Number.isFinite(Date.parse(item.lastActivityAt)));
    const empty = item.state === "Sin vincular" && !hasActivity && !item.metrics?.total;
    const hasTurn = Boolean(item.turn?.id && item.turn?.startedAt);
    field("rubro").textContent = item.rubro || "—";
    field("schedule").textContent = item.schedule || "—";
    field("activity").hidden = !hasActivity;
    field("activity").textContent = hasActivity ? `Última actividad · ${date(item.lastActivityAt)}` : "";
    field("context").textContent = empty ? "Vincula el equipo para consultar su actividad." : !hasTurn ? "No hay un turno activo verificable." : item.scopeReason || "";
    field("context").hidden = !field("context").textContent;
    field("scope").textContent = (item.scopeReason || (item.turn ? item.turn.label : "Sin un turno verificable.")).replace(/\bcelular\b/gi, "equipo");
    field("metrics").hidden = empty || !hasTurn;
    metrics(field("metrics"), item.metrics, item.pending, primaryLabels);
    metrics(field("secondary"), item.metrics, item.pending, secondaryLabels);

    const liveWidget = field("live");
    liveWidget.hidden = !inCall;
    if (inCall) {
      field("liveNumber").textContent = item.calling?.number || item.calling?.contact || "En llamada";
      field("liveDuration").textContent = item.calling?.duration ? `${Math.floor(item.calling.duration / 60)}:${String(item.calling.duration % 60).padStart(2, "0")}` : "—";
    }

    const details = card.querySelector("details");
    details.hidden = empty;
    if (details.open && !details.hidden) requestHistory(item);
    else pendingHistories.delete(item.number);
  }

  $("legendActive").textContent = legend.active;
  $("legendDialing").textContent = legend.dialing;
  $("legendReady").textContent = legend.ready;
  $("legendOffline").textContent = legend.offline;
  $("legendNone").textContent = legend.none;

  const knownSummary = Boolean(snapshot.summary.metrics);
  $("turnUnavailable").hidden = knownSummary;
  if (knownSummary) {
    const m = snapshot.summary.metrics;
    $("kpiTotal").textContent = value(m.total);
    $("kpiAnswered").textContent = value(m.answered);
    $("kpiPending").textContent = value(snapshot.summary.pending ?? m.pending);
    $("kpiProgress").textContent = value(m.inProgress);
  }

  const banner = $("alertBanner");
  if (disconnected.length && live) {
    banner.hidden = false;
    $("alertTitle").textContent = `${disconnected.length} equipo(s) desconectado(s)`;
    $("alertText").textContent = disconnected.map(e => `Equipo ${e.number}${e.name ? ` (${e.name})` : ""}`).join(" · ");
  } else {
    banner.hidden = true;
  }

  $("overflowNotice").hidden = !snapshot.overflow;
  $("overflowNotice").textContent = `${snapshot.overflow} equipo(s) adicional(es) fuera de las 10 posiciones.`;
}

function accept(data) {
  if (data.unavailable || !Array.isArray(data.equipment)) return unavailable();
  snapshot = data; lastReceived = Date.now();
  $("liveStatus").textContent = "En vivo · Conectado al servidor";
  $("updatedAt").textContent = `Actualizado ${date(data.generatedAt)}`; render();
}
function unavailable() { lastReceived = 0; $("liveStatus").textContent = "Sin conexión en vivo · Esperando al servidor"; render(); }

try {
  const user = await requireLogin();
  if (user.role !== "ADMINISTRADOR") window.location.replace("/");
  else {
    bindAccountControls();
    const response = await apiFetch("/api/admin/network", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo cargar Núcleo de Red.");
    snapshot = await response.json(); render();
    socket = window.io(window.location.origin, { transports: ["websocket"], auth: { client: "dashboard", userId: user.id } });
    socket.on("connect", () => socket.emit("admin:subscribe", result => { if (!result?.ok) unavailable(); }));
    socket.on("admin:network", accept);
    socket.on("disconnect", unavailable);
    socket.on("connect_error", error => { unavailable(); if (["AUTH_REQUIRED", "AUTH_CHANGED"].includes(error.message)) window.location.replace("/login"); });
    socket.on("session:error", data => { unavailable(); $("accountError").textContent = data.message; if (data.reason === "AUTH_REQUIRED") window.location.replace("/login"); });
    setInterval(() => { if (lastReceived && Date.now() - lastReceived >= 6000) unavailable(); }, 1000);
  }
} catch (error) { $("accountError").textContent = error.message; unavailable(); }
