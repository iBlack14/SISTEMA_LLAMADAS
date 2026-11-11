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
const esc = value => String(value ?? "").replace(/[&<>"\']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "Sin datos";
const value = n => typeof n === "number" ? n.toLocaleString("es-PE") : "Sin datos";
const metricLabels = { total: "Total de llamadas", answered: "Contestadas", unanswered: "No contestadas", pending: "Pendientes", inoperable: "Inoperable", inProgress: "En curso", unclassified: "Sin clasificar" };
const primaryLabels = { total: "Total de llamadas", answered: "Contestadas", pending: "Pendientes" };
const secondaryLabels = { unanswered: "No contestadas", inoperable: "Inoperable", inProgress: "En curso", unclassified: "Sin clasificar" };
const resultLabels = { contesto: "Contestó", sin_respuesta: "Sin respuesta", no_contesto: "No contestó", no_contactado: "No contactado", buzon_de_voz: "Buzón de voz", sin_servicio: "Sin servicio", no_disponible: "No disponible", numero_incorrecto: "Número incorrecto" };
const historyKey = item => JSON.stringify([item.deviceId, item.turn?.id, item.historyVersion]);
function metrics(target, counts, pending, labels = metricLabels) {
  const html = Object.entries(labels).map(([key, label]) => {
    const count = key === "pending" ? pending : counts?.[key];
    const known = typeof count === "number";
    return `<div class="network-metric"><dt>${label}</dt><dd class="${known ? "metric-value" : "metric-unknown"}"${known ? "" : ' title="Dato desconocido" aria-label="Dato desconocido"'}>${known ? value(count) : "—"}</dd></div>`;
  }).join("");
  if (target.innerHTML !== html) target.innerHTML = html;
}
function createCard(number) {
  const card = document.createElement("article");
  card.className = "network-surface network-equipment-card";
  card.dataset.equipment = number;
  card.setAttribute("aria-labelledby", `equipment-title-${number}`);
  card.innerHTML = `<header class="network-card-head"><h2 id="equipment-title-${number}">Equipo ${number}</h2><span class="campaign-report-result" data-field="state">Sin datos</span></header>
    <p class="network-card-name" data-field="name"></p>
    <p class="network-test" data-field="test" hidden>Prueba simulada</p>
    <p class="network-last-activity" data-field="activity" hidden></p>
    <p class="network-context" data-field="context"></p>
    <dl class="network-primary-metrics" data-field="metrics" aria-label="Métricas principales del turno"></dl>
    <details class="network-details"><summary>Ver detalle del turno</summary>
      <dl class="network-device-meta"><div><dt>Rubro</dt><dd data-field="rubro">—</dd></div><div><dt>Horario del turno</dt><dd data-field="schedule">—</dd></div></dl>
      <p class="network-note" data-field="scope"></p>
      <dl class="network-secondary-metrics" data-field="secondary" aria-label="Métricas secundarias del turno"></dl>
      <div class="campaign-report-table-wrap"><table class="campaign-report-table"><caption class="network-table-caption">Equipo ${number} · Hasta 30 intentos recientes</caption><thead><tr><th>Empresa / contacto</th><th>Hora Lima</th><th>Duración</th><th>Resultado</th></tr></thead><tbody data-field="rows"></tbody></table></div></details>`;
  card.querySelector("details").addEventListener("toggle", () => {
    const item = snapshot?.equipment.find(e => e.number === number);
    if (item && card.querySelector("details").open && !card.querySelector("details").hidden) requestHistory(item);
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
    ? `<tr><td colspan="4" class="campaign-report-empty">${esc(error || (rows === null ? "Cargando actividad…" : item.metrics ? "No hay intentos registrados en este turno." : "Sin datos para un turno verificable."))}</td></tr>`
    : rows.map(row => `<tr class="campaign-report-row"><td>${esc(row.name)}<small>${esc(row.list || "Sin rubro")}</small></td><td>${esc(date(row.startedAt))}</td><td>${row.durationSeconds === null ? "Sin datos" : `${Math.floor(row.durationSeconds / 60)}:${String(row.durationSeconds % 60).padStart(2, "0")}`}</td><td><span class="campaign-report-result result-${esc(row.category)}">${esc(!row.endedAt ? "En curso" : resultLabels[row.result] || row.result || "Sin clasificar")}</span></td></tr>`).join("");
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
    return details?.open && !details.hidden;
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
function render() {
  if (!snapshot) return;
  const live = Boolean(socket?.connected && Date.now() - lastReceived < 6000);
  const countLabel = live ? `${snapshot.callingCount} de 10 llamando` : "Sin datos en vivo";
  if ($("callingCount").textContent !== countLabel) $("callingCount").textContent = countLabel;
  for (const item of snapshot.equipment) {
    const state = live ? item.state : "Sin datos en vivo";
    const inCall = live && item.calling && item.state === "En llamada";
    let indicator = indicators.get(item.number);
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "network-indicator";
      indicator.tabIndex = 0;
      indicator.setAttribute("role", "img");
      indicator.dataset.number = item.number;
      indicator.setAttribute("aria-describedby", `indicator-tip-${item.number}`);
      indicator.innerHTML = `<span class="network-orb" aria-hidden="true">${item.number}</span><span class="network-tooltip" role="tooltip" id="indicator-tip-${item.number}"></span>`;
      $("equipmentIndicators").appendChild(indicator);
      indicators.set(item.number, indicator);
    }
    const deviceName = item.name?.replace(/\bCelular\b/gi, "Equipo");
    const description = [`Equipo ${item.number}`, deviceName && deviceName !== `Equipo ${item.number}` ? deviceName : null, state, item.simulated ? "Prueba simulada" : null].filter(Boolean).join(" · ");
    indicator.setAttribute("aria-label", description);
    indicator.querySelector(".network-tooltip").textContent = description;
    indicator.dataset.state = state;
    indicator.classList.toggle("is-in-call", Boolean(inCall));
    const card = cards.get(item.number) || createCard(item.number);
    card.dataset.state = state;
    card.classList.toggle("is-in-call", Boolean(inCall));
    const field = name => card.querySelector(`[data-field="${name}"]`);
    field("state").textContent = state;
    field("state").className = `campaign-report-result ${inCall ? "network-active-label" : ""}`;
    const name = item.name?.replace(/\bCelular\b/gi, "Equipo");
    card.querySelector("h2").title = name || `Equipo ${item.number}`;
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
    const details = card.querySelector("details");
    details.hidden = empty;
    if (details.open && !details.hidden) requestHistory(item);
    else pendingHistories.delete(item.number);
  }
  const knownSummary = Boolean(snapshot.summary.metrics);
  $("turnUnavailable").hidden = knownSummary;
  $("turnSummaryContent").hidden = !knownSummary;
  if (knownSummary) {
    $("turnLabel").textContent = snapshot.summary.label;
    $("turnScope").textContent = snapshot.summary.scope.replace(/\bcelular/g, "equipo");
    metrics($("turnMetrics"), snapshot.summary.metrics, snapshot.summary.pending);
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
// Keep focus/scroll targets below the sticky monitor without using a fixed overlay.
const overview = document.querySelector(".network-overview");
const monitorSize = new ResizeObserver(() => {
  document.documentElement.style.setProperty("--network-monitor-offset", `${Math.ceil(overview.getBoundingClientRect().height) + 24}px`);
});
monitorSize.observe(overview);
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
