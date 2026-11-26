import { requireLogin, bindAccountControls, apiFetch } from "../../auth/auth-session.js";
import { equipmentStatus, displayState } from "./equipment-status.js";
import { shortDeviceId } from "../../../shared/device-id.js";

let snapshot;
let socket;
let lastReceived = 0;
let receivedAt = 0;
let reconnectingAll = false;
let equipmentPage = 0;
let equipmentLive = false;
let orderedEquipmentSnapshot = [];
const EQUIPMENT_PAGE_SIZE = 10;
// El monitor publica cada 30 s (NETWORK_MONITOR_INTERVAL_MS). Un umbral de 6 s
// marcaba "Sin conexión" entre publicaciones aunque el socket estuviera sano.
const STALE_MS = 45000;
const cards = new Map();
const orbs = new Map();
const histories = new Map();
const reconnectingEquipment = new Set();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "Sin datos";
const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "Sin datos";
const value = n => typeof n === "number" ? n.toLocaleString("es-PE") : "—";
const resultLabels = { contesto: "Contestó", sin_respuesta: "Sin respuesta", no_contesto: "No contestó", no_contactado: "No contactado", buzon_de_voz: "Buzón de voz", sin_servicio: "Sin servicio", no_disponible: "No disponible", numero_incorrecto: "Número incorrecto", numero_inexistente: "No volver a llamar" };


const tones = { "En llamada": "active", "Marcando": "dialing", "Disponible": "ready", "Desconectado": "offline", "Sin equipo": "unknown", "Sin señal de estado": "unknown" };
const duration = n => typeof n === "number" && Number.isFinite(n) ? Math.floor(n / 60) + ":" + String(Math.floor(n % 60)).padStart(2, "0") : "—";

function formatElapsed(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}d ${remH}h`;
}

function getItemElapsedSeconds(item, state) {
  if (!item) return null;
  const isConn = ["Disponible", "En llamada", "Marcando"].includes(state);
  if (isConn) {
    if (item.connectedAt && Number.isFinite(Date.parse(item.connectedAt))) {
      return Math.max(0, Math.floor((Date.now() - Date.parse(item.connectedAt)) / 1000));
    }
    if (typeof item.connectedDurationSeconds === "number") return item.connectedDurationSeconds;
  } else if (state === "Desconectado") {
    if (item.disconnectedAt && Number.isFinite(Date.parse(item.disconnectedAt))) {
      return Math.max(0, Math.floor((Date.now() - Date.parse(item.disconnectedAt)) / 1000));
    }
    if (typeof item.disconnectedDurationSeconds === "number") return item.disconnectedDurationSeconds;
  }
  return null;
}

function selectFilter(state) {
  filterState = state;
  document.querySelectorAll("#stateFilters .filter-pill").forEach(button => {
    const selected = button.dataset.filter === state;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}
function createOrb(number) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "indicator";
  el.innerHTML = '<span class="indicator-dot" aria-hidden="true"></span><span class="orb-num"></span><span class="orb-device-id"></span><span class="orb-sub"></span><span class="orb-time-caption"></span><span class="orb-time"></span><span class="orb-connection"><span></span></span>';
  el.addEventListener("click", () => {
    const card = cards.get(number);
    if (!card) return;
    selectFilter("all");
    filterQuery = "";
    $("searchInput").value = "";
    const itemIndex = orderedEquipmentSnapshot.findIndex(item => item.number === number);
    equipmentPage = Math.max(0, Math.floor(itemIndex / EQUIPMENT_PAGE_SIZE));
    render();
    card.scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center"});
    card.focus({preventScroll: true});
  });
  const position = document.createElement("div");
  position.className = "equipment-position";
  position.dataset.equipment = number;
  const reconnect = document.createElement("button");
  reconnect.type = "button";
  reconnect.className = "button secondary equipment-reconnect-btn";
  reconnect.textContent = "Reconectar";
  reconnect.disabled = true;
  const message = document.createElement("span");
  message.className = "equipment-reconnect-msg";
  message.hidden = true;
  message.setAttribute("role", "status");
  reconnect.addEventListener("click", () => reconnectSingleEquipment(number, reconnect, message));
  const renumber = document.createElement("button");
  renumber.type = "button";
  renumber.className = "button secondary equipment-number-btn";
  renumber.textContent = "Cambiar número";
  renumber.addEventListener("click", () => changeEquipmentNumber(number, renumber, message));
  position.append(el, reconnect, renumber, message);
  $("equipmentIndicators").appendChild(position);
  orbs.set(number, el);
  return el;
}
function renderOrb(el, number, state, name, item, live) {
  el.dataset.tone = tones[state];
  const serverNow = Date.parse(snapshot.generatedAt) + Math.max(0, performance.now() - receivedAt);
  const status = equipmentStatus(item, live, serverNow);
  const timeText = status.seconds === null ? "—" : formatElapsed(status.seconds);
  el.setAttribute("aria-label", `Equipo ${number}, ${name || ""}, ${status.label}. ${status.caption}: ${timeText}. ${status.connectionLabel}. Ver detalle.`);
  el.querySelector(".orb-num").textContent = String(number).padStart(2, "0");
  const deviceIdEl = el.querySelector(".orb-device-id");
  deviceIdEl.textContent = item.deviceId ? `ID: ${shortDeviceId(item.deviceId)}` : "Sin ID";
  deviceIdEl.title = item.deviceId ? `ID corto del dispositivo: ${shortDeviceId(item.deviceId)}` : "Sin ID vinculado";
  deviceIdEl.hidden = !item.deviceId;
  el.querySelector(".orb-sub").textContent = status.label;
  el.querySelector(".orb-time-caption").textContent = status.caption;
  const connection = el.querySelector(".orb-connection");
  connection.dataset.connection = status.connection;
  connection.querySelector("span").textContent = status.connectionLabel;
  const timeEl = el.querySelector(".orb-time");
  if (timeEl) {
    timeEl.textContent = timeText;
    timeEl.title = status.seconds === null ? "Inicio del estado no disponible" : `${status.caption}: ${timeText}`;
  }
  const reconnect = el.parentElement.querySelector(".equipment-reconnect-btn");
  reconnect.disabled = reconnectingEquipment.has(number) || !live || !item.deviceId || item.calling || ["En llamada", "Marcando"].includes(state);
  reconnect.setAttribute("aria-label", `Reconectar equipo ${String(number).padStart(2, "0")}`);
  reconnect.title = !item.deviceId ? "Sin dispositivo vinculado" : !live ? "Sin conexion con el servidor"
    : item.calling || ["En llamada", "Marcando"].includes(state) ? "No disponible durante una llamada"
    : "Solicitar reconexion de este equipo";
}
function statCell(label, n) {
  return `<div><span>${label}</span><strong>${value(n)}</strong></div>`;
}
function resultPill(row) {
  const label = !row.endedAt ? "En curso" : resultLabels[row.result] || row.result || "Sin resultado";
  const tone = !row.endedAt ? "dialing" : row.category === "ok" ? "active" : row.category === "err" ? "offline" : "unknown";
  return `<span class="result-pill" data-tone="${tone}">${esc(label)}</span>`;
}
function createCard(number) {
  const card = document.createElement("article");
  card.className = "net-card";
  card.id = `equip-${number}`;
  card.tabIndex = -1;
  card.innerHTML = `<div class="card-heading">
    <div><h3 class="card-title"></h3><span class="card-model"></span><span class="card-device-id"></span></div>
    <span class="card-pill"></span>
  </div>
  <div class="card-time-badge"></div>
  <div class="card-meta"></div>
  <div class="card-stats"></div>
  <div class="card-live" hidden></div>
  <details class="card-history"><summary>Actividad del turno <span class="card-activity"></span></summary>
    <div class="history-scroll" tabindex="0" role="region" aria-label="Actividad del equipo ${number}">
      <table><thead><tr><th scope="col">Contacto</th><th scope="col">Hora de Lima</th><th scope="col">Duración</th><th scope="col">Resultado</th></tr></thead><tbody class="card-rows"></tbody></table>
    </div>
  </details>
  <p class="card-scope"></p>`;
  $("equipmentGrid").appendChild(card);
  cards.set(number, card);
  return card;
}
function renderCard(card, item, state, live) {
  card.dataset.state = state;
  card.dataset.tone = tones[state];
  card.dataset.search = `${item.number} Equipo ${String(item.number).padStart(2, "0")} ${item.deviceId || ""} ${item.deviceId ? shortDeviceId(item.deviceId) : ""} ${item.name || ""} ${item.rubro || ""} ${item.call?.name || ""} ${item.call?.phone || ""}`.toLowerCase();
  card.querySelector(".card-title").textContent = `Equipo ${String(item.number).padStart(2, "0")}`;
  const model = (item.name || "").replace(/\bCelular\b/gi, "Equipo").replace(/^Equipo\s*\d*\s*/i, "").trim();
  const modelEl = card.querySelector(".card-model");
  modelEl.textContent = model;
  modelEl.hidden = !model;
  const deviceIdEl = card.querySelector(".card-device-id");
  deviceIdEl.textContent = item.deviceId ? `ID: ${shortDeviceId(item.deviceId)}` : "Sin ID vinculado";
  deviceIdEl.hidden = !item.deviceId;
  deviceIdEl.title = item.deviceId ? `ID corto del dispositivo: ${shortDeviceId(item.deviceId)}` : "";
  const meta = card.querySelector(".card-meta");
  meta.innerHTML = [item.rubro, item.schedule].filter(Boolean).map(part => `<span>${esc(part)}</span>`).join("");
  meta.hidden = !meta.textContent;
  const pill = card.querySelector(".card-pill");
  pill.dataset.tone = tones[state];
  pill.textContent = state;

  const timeBadge = card.querySelector(".card-time-badge");
  if (timeBadge) {
    const isConn = ["Disponible", "En llamada", "Marcando"].includes(state);
    const secs = getItemElapsedSeconds(item, state);
    if (isConn && typeof secs === "number") {
      const atStr = item.connectedAt && Number.isFinite(Date.parse(item.connectedAt)) ? stamp(item.connectedAt) : "";
      timeBadge.innerHTML = `<span class="time-badge connected">🟢 Conectado hace <strong>${formatElapsed(secs)}</strong>${atStr ? ` <small>(desde ${atStr})</small>` : ""}</span>`;
      timeBadge.hidden = false;
    } else if (state === "Desconectado" && typeof secs === "number") {
      const atStr = item.disconnectedAt && Number.isFinite(Date.parse(item.disconnectedAt)) ? stamp(item.disconnectedAt) : "";
      timeBadge.innerHTML = `<span class="time-badge disconnected">🔴 Desconectado hace <strong>${formatElapsed(secs)}</strong>${atStr ? ` <small>(desde ${atStr})</small>` : ""}</span>`;
      timeBadge.hidden = false;
    } else {
      timeBadge.innerHTML = "";
      timeBadge.hidden = true;
    }
  }

  const m = live && item.turn?.id && item.turn?.startedAt ? item.metrics : null;
  card.querySelector(".card-stats").innerHTML = statCell("Intentos", m?.total) + statCell("Contestadas", m?.answered) + statCell("Pendientes", m ? item.pending ?? m.pending : null);
  const liveBox = card.querySelector(".card-live");
  liveBox.hidden = !(live && item.calling && ["En llamada", "Marcando"].includes(state));
  if (!liveBox.hidden) {
    liveBox.dataset.tone = tones[state];
    const contact = item.call;
    if (contact?.name || contact?.phone) {
      liveBox.innerHTML = `<span class="live-label">${state === "Marcando" ? "Marcando a" : "En llamada con"}</span>
        <strong>${esc(contact.name || "Sin nombre")}</strong>
        ${contact.phone ? `<span class="live-phone">📞 ${esc(contact.phone)}</span>` : ""}
        ${contact.list ? `<span class="live-list">${esc(contact.list)}</span>` : ""}`;
    } else {
      liveBox.textContent = state === "Marcando" ? "Marcando… (contacto no identificado)" : "Llamada activa en este equipo.";
    }
  }
  card.querySelector(".card-scope").textContent = item.scopeReason || (item.turn ? item.turn.label : "Sin turno activo");

  renderCardHistory(card, item);
}
function renderCardHistory(card, item) {
  const cached = histories.get(item.number);
  const rows = cached?.key === historyKey(item) ? cached.activity : null;
  card.querySelector(".card-activity").textContent = rows ? `(${rows.length})` : "";
  card.querySelector(".card-rows").innerHTML = rows === null
    ? '<tr><td colspan="4" class="muted">Cargando actividad…</td></tr>'
    : !rows.length
      ? '<tr><td colspan="4" class="muted">No hay actividad registrada para este turno.</td></tr>'
      : rows.map(row => `<tr><td>${esc(row.name || "Sin nombre")}<small>${esc(row.list || "Sin rubro")}</small></td>
        <td>${esc(date(row.startedAt))}</td><td>${row.endedAt ? duration(row.durationSeconds) : "En curso"}</td>
        <td>${resultPill(row)}</td></tr>`).join("");
}

const historyKey = item => JSON.stringify([item.deviceId, item.turn?.id, item.historyVersion]);

async function loadEquipmentHistory(item) {
  const key = historyKey(item);
  if (histories.get(item.number)?.key === key) return;
  const numbers = item.number;
  try {
    const response = await apiFetch(`/api/network/activity?equipment=${numbers}`, { cache: "no-store" });
    if (!response.ok) throw new Error("error");
    const data = await response.json();
    const activity = data.equipment?.[0]?.activity || [];
    histories.set(item.number, { key, activity });
    const card = cards.get(item.number);
    const current = snapshot?.equipment.find(e => e.number === item.number);
    if (card && current && historyKey(current) === key) renderCardHistory(card, current);
  } catch {
    const card = cards.get(item.number);
    if (card) card.querySelector(".card-rows").innerHTML = '<tr><td colspan="4" class="muted">No se pudo cargar la actividad.</td></tr>';
  }
}

let filterState = "all";
let filterQuery = "";


function matchesEquipmentFilters(item) {
  const state = displayState(item, equipmentLive);
  const query = `${item.number} Equipo ${String(item.number).padStart(2, "0")} ${item.deviceId || ""} ${item.deviceId ? shortDeviceId(item.deviceId) : ""} ${item.name || ""} ${item.rubro || ""} ${item.call?.name || ""} ${item.call?.phone || ""}`.toLowerCase();
  return (filterState === "all" || state === filterState) && (!filterQuery || query.includes(filterQuery));
}
function applyFilters() {
  let visible = 0;
  for (const card of cards.values()) {
    card.hidden = card.dataset.sliderVisible !== "true"
      || !((filterState === "all" || card.dataset.state === filterState) && (!filterQuery || (card.dataset.search || "").includes(filterQuery)));
    if (!card.hidden) visible++;
  }
  $("emptyResults").hidden = visible > 0 || !snapshot;
}
function updateFilterCounts() {
  const counts = {all: orderedEquipmentSnapshot.length};
  for (const item of orderedEquipmentSnapshot) {
    const state = displayState(item, equipmentLive);
    counts[state] = (counts[state] || 0) + 1;
  }
  document.querySelectorAll("#stateFilters .filter-pill").forEach(button => {
    const base = button.dataset.label || (button.dataset.label = button.textContent.trim());
    button.textContent = `${base} (${counts[button.dataset.filter] ?? 0})`;
  });
}
function equipmentOrder(item) {
  return Number(item.number) || 0;
}
function render() {
  if (!snapshot) return;
  const live = Boolean(socket?.connected && Date.now() - lastReceived < STALE_MS);
  equipmentLive = live;
  $("liveStatus").textContent = live ? "En vivo" : "Sin conexión";
  $("liveDot").className = "status-dot" + (live ? " connected" : "");
  document.querySelector(".connection").classList.toggle("is-offline", !live);
  $("updatedAt").textContent = `Actualizado ${stamp(snapshot.generatedAt)}`;
  const connectedCount = snapshot.equipment.filter(item => ["Disponible", "En llamada", "Marcando"].includes(item.state)).length;
  const linkedCount = snapshot.equipment.filter(item => item.deviceId).length;
  $("nodeCount").textContent = live
    ? `${connectedCount} conectados · ${linkedCount} vinculados · ${snapshot.equipment.length} posiciones`
    : `Sin conexión · ${linkedCount} vinculados · ${snapshot.equipment.length} posiciones`;
  $("downloadLog").disabled = false;
  const counts = {"En llamada": 0, "Marcando": 0, "Disponible": 0, "Desconectado": 0, "Sin equipo": 0, "Sin señal de estado": 0};
  const disconnected = [];
  orderedEquipmentSnapshot = [...snapshot.equipment].sort((left, right) =>
    equipmentOrder(left) - equipmentOrder(right) || left.number - right.number
  );
  for (const item of orderedEquipmentSnapshot) {
    const state = displayState(item, live);
    counts[state]++;
    if (state === "Desconectado") disconnected.push(item);
  }
  const matchingEquipment = orderedEquipmentSnapshot.filter(matchesEquipmentFilters);
  const pageCount = Math.max(1, Math.ceil(matchingEquipment.length / EQUIPMENT_PAGE_SIZE));
  equipmentPage = Math.min(equipmentPage, pageCount - 1);
  const firstVisibleIndex = equipmentPage * EQUIPMENT_PAGE_SIZE;
  for (const card of cards.values()) {
    card.dataset.sliderVisible = "false";
    card.hidden = true;
  }
  for (const orb of orbs.values()) orb.parentElement.hidden = true;
  for (const item of matchingEquipment.slice(firstVisibleIndex, firstVisibleIndex + EQUIPMENT_PAGE_SIZE)) {
    const state = displayState(item, live);
    const orb = orbs.get(item.number) || createOrb(item.number);
    renderOrb(orb, item.number, state, item.name, item, live);
    orb.parentElement.hidden = false;
    $("equipmentIndicators").appendChild(orb.parentElement);
    const card = cards.get(item.number) || createCard(item.number);
    renderCard(card, item, state, live);
    card.dataset.sliderVisible = "true";
    $("equipmentGrid").appendChild(card);
  }
  const slider = $("equipmentSlider");
  slider.hidden = matchingEquipment.length <= EQUIPMENT_PAGE_SIZE;
  $("equipmentSliderPrev").disabled = equipmentPage === 0;
  $("equipmentSliderNext").disabled = equipmentPage >= pageCount - 1;
  const pageStart = matchingEquipment.length ? firstVisibleIndex + 1 : 0;
  const pageEnd = Math.min(firstVisibleIndex + EQUIPMENT_PAGE_SIZE, matchingEquipment.length);
  $("equipmentSliderPage").textContent = `Página ${equipmentPage + 1} de ${pageCount} · ${pageStart}–${pageEnd} de ${matchingEquipment.length}`;
  for (const [id, state] of [["legendActive","En llamada"],["legendDialing","Marcando"],["legendReady","Disponible"],["legendOffline","Desconectado"],["legendNone","Sin equipo"],["legendUnknown","Sin señal de estado"]]) $(id).textContent = counts[state];
  const m = live ? snapshot.summary?.metrics : null;
  $("turnUnavailable").hidden = Boolean(m);
  $("turnUnavailable").textContent = live ? "No hay datos de turno para consolidar el resumen." : "El resumen no está disponible hasta recuperar la conexión.";
  $("kpiTotal").textContent = value(m?.total);
  $("kpiAnswered").textContent = value(m?.answered);
  $("kpiPending").textContent = value(m ? snapshot.summary.pending ?? m.pending : null);
  $("kpiProgress").textContent = value(m?.inProgress);
  $("kpiAnsweredPct").textContent = m && m.total > 0 && typeof m.answered === "number" ? `${Math.round(m.answered / m.total * 100)}% de contacto` : "";
  const hasDisconnected = live && Boolean(disconnected.length);
  const reconnectAll = $("reconnectAllAlertBtn");
  reconnectAll.disabled = reconnectingAll || !hasDisconnected;
  reconnectAll.title = !live ? "Sin conexion con el servidor" : hasDisconnected
    ? `Reconectar ${disconnected.length} equipo(s) desconectado(s)` : "No hay equipos desconectados";
  $("overflowNotice").hidden = !snapshot.overflow;
  $("overflowNotice").textContent = snapshot.overflow ? `${snapshot.overflow} equipo(s) adicional(es) identificados por ID. Usa el slider para recorrerlos.` : "";
  updateFilterCounts();
  applyFilters();
}

$("equipmentGrid").addEventListener("toggle", event => {
  const details = event.target.closest("details.card-history");
  if (!details?.open) return;
  const card = details.closest(".net-card");
  const item = snapshot?.equipment.find(e => e.number === Number(card?.id.replace("equip-", "")));
  if (item) loadEquipmentHistory(item);
}, true);

async function reconnectSingleEquipment(number, btn, msgEl) {
  if (btn.disabled) return;
  const originalHtml = btn.innerHTML;
  reconnectingEquipment.add(number);
  btn.disabled = true;
  btn.textContent = "Reconectando…";
  if (msgEl) {
    msgEl.hidden = true;
    msgEl.textContent = "";
    msgEl.className = "equipment-reconnect-msg";
  }
  try {
    const res = await apiFetch(`/api/network/equipment/${number}/reconnect`, { method: "POST" });
    if (!res.ok) throw new Error("No se pudo enviar orden");
    if (msgEl) {
      msgEl.textContent = "✓ Señal enviada";
      msgEl.className = "equipment-reconnect-msg";
      msgEl.hidden = false;
      setTimeout(() => { if (msgEl) msgEl.hidden = true; }, 4000);
    }
    const r = await apiFetch("/api/network", { cache: "no-store" });
    if (r.ok) {
      const snap = await r.json();
      if (snap && Array.isArray(snap.equipment)) {
        accept(snap);
      }
    }
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = "⚠️ Error al reconectar";
      msgEl.className = "equipment-reconnect-msg error";
      msgEl.hidden = false;
      setTimeout(() => { if (msgEl) msgEl.hidden = true; }, 4000);
    }
  } finally {
    reconnectingEquipment.delete(number);
    btn.innerHTML = originalHtml;
    render();
  }
}

async function changeEquipmentNumber(number, btn, msgEl) {
  if (btn.disabled) return;
  const current = snapshot?.equipment.find(item => item.number === number);
  if (!current?.deviceId) {
    if (msgEl) { msgEl.textContent = "Vincula un dispositivo antes de cambiar su número."; msgEl.hidden = false; }
    return;
  }
  const answer = window.prompt(`Nuevo número para el equipo con ID ${shortDeviceId(current.deviceId)} (1–255):`, String(number));
  if (answer === null) return;
  const newNumber = Number(answer.trim());
  if (!Number.isInteger(newNumber) || newNumber < 1 || newNumber > 255) {
    if (msgEl) { msgEl.textContent = "Ingresa un número entero del 1 al 255."; msgEl.hidden = false; msgEl.className = "equipment-reconnect-msg error"; }
    return;
  }
  if (newNumber === number) return;
  btn.disabled = true;
  btn.textContent = "Guardando…";
  if (msgEl) { msgEl.hidden = true; msgEl.textContent = ""; }
  try {
    const response = await apiFetch(`/api/network/equipment/${number}/position`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number: newNumber, deviceId: current.deviceId })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "No se pudo cambiar el número.");
    if (msgEl) { msgEl.textContent = `✓ Equipo ${String(newNumber).padStart(2, "0")} guardado`; msgEl.hidden = false; msgEl.className = "equipment-reconnect-msg"; }
    if (Array.isArray(result.snapshot?.equipment)) accept(result.snapshot);
  } catch (error) {
    if (msgEl) { msgEl.textContent = `⚠ ${error.message}`; msgEl.hidden = false; msgEl.className = "equipment-reconnect-msg error"; }
  } finally {
    btn.disabled = false;
    btn.textContent = "Cambiar número";
  }
}

async function reconnectAllDisconnected() {
  if (!snapshot || !Array.isArray(snapshot.equipment)) return;
  const live = Boolean(socket?.connected && Date.now() - lastReceived < STALE_MS);
  const disconnected = snapshot.equipment.filter(item => displayState(item, live) === "Desconectado");
  if (!disconnected.length) return;

  const alertBtn = $("reconnectAllAlertBtn");
  if (reconnectingAll) return;
  reconnectingAll = true;
  $("reconnectFeedback").textContent = "";
  const btns = [alertBtn].filter(Boolean);
  btns.forEach(b => { b.disabled = true; b.textContent = "Reconectando…"; });

  try {
    const numbers = disconnected.map(item => item.number);
    const res = await apiFetch("/api/network/reconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equipment: numbers })
    });
    if (!res.ok) throw new Error("Error en la reconexión");

    $("reconnectFeedback").textContent = `Solicitud enviada a ${numbers.length} equipo(s). Esperando conexion...`;

    const r = await apiFetch("/api/network", { cache: "no-store" });
    if (r.ok) {
      const snap = await r.json();
      if (snap && Array.isArray(snap.equipment)) {
        accept(snap);
      }
    }
  } catch (err) {
    if ($("accountError")) {
      $("accountError").textContent = "Error al solicitar reconexión de equipos: " + err.message;
      setTimeout(() => { if ($("accountError")) $("accountError").textContent = ""; }, 5000);
    }
  } finally {
    reconnectingAll = false;
    if (alertBtn) alertBtn.textContent = "Reconectar bridges";
    render();
  }
}

function accept(data) {
  if (data.unavailable || !Array.isArray(data.equipment)) return unavailable();
  snapshot = data; lastReceived = Date.now();
  receivedAt = performance.now();
  render();
}
function unavailable() { lastReceived = 0; $("liveStatus").textContent = "Sin conexión"; $("liveDot").className = "status-dot"; document.querySelector(".connection").classList.add("is-offline"); render(); }

function tickLiveDurations() {
  if (!snapshot || !Array.isArray(snapshot.equipment)) return;
  const live = Boolean(socket?.connected && Date.now() - lastReceived < STALE_MS);
  for (const item of snapshot.equipment) {
    const state = displayState(item, live);
    const orb = orbs.get(item.number);
    if (orb) renderOrb(orb, item.number, state, item.name, item, live);
    const card = cards.get(item.number);
    if (card) {
      const strong = card.querySelector(".card-time-badge strong");
      if (strong) {
        const secs = getItemElapsedSeconds(item, state);
        if (typeof secs === "number") {
          const formatted = formatElapsed(secs);
          if (strong.textContent !== formatted) strong.textContent = formatted;
        }
      }
    }
  }
}
let networkInitialization;
export function initNetworkPage() {
  if (networkInitialization) return networkInitialization;
  networkInitialization = initializeNetworkPage().catch(error => {
    networkInitialization = null;
    throw error;
  });
  return networkInitialization;
}

async function initializeNetworkPage() {
setInterval(tickLiveDurations, 1000);
try {
  const user = await requireLogin();
  if (user.role !== "ADMINISTRADOR") window.location.replace("/");
  else if (window.location.pathname !== "/usuarios") {
    bindAccountControls();
    const response = await apiFetch("/api/network", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo cargar Núcleo de Red.");
    accept(await response.json());

    if ($("reconnectAllAlertBtn")) $("reconnectAllAlertBtn").addEventListener("click", reconnectAllDisconnected);

    $("refreshButton").addEventListener("click", async () => {
      $("refreshButton").disabled = true;
      try {
        const r = await apiFetch("/api/network", { cache: "no-store" });
        if (!r.ok) throw new Error("No se pudo actualizar el estado de los equipos.");
        const data = await r.json();
        if (data.unavailable || !Array.isArray(data.equipment)) throw new Error("El estado de equipos no está disponible.");
        $("accountError").textContent = ""; accept(data);
      } catch (error) { $("accountError").textContent = error.message; unavailable(); }
      finally { $("refreshButton").disabled = false; }
    });
    $("downloadLog").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `nucleo-red-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $("searchInput").addEventListener("input", e => { filterQuery = e.target.value.trim().toLowerCase(); equipmentPage = 0; render(); });
    document.querySelectorAll("#stateFilters .filter-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        selectFilter(btn.dataset.filter);
        equipmentPage = 0;
        render();
      });
    });
    $("equipmentSliderPrev").addEventListener("click", () => { equipmentPage = Math.max(0, equipmentPage - 1); render(); });
    $("equipmentSliderNext").addEventListener("click", () => { equipmentPage += 1; render(); });
    document.querySelector('#stateFilters .filter-pill[data-filter="all"]').classList.add("active");

    socket = window.io(window.location.origin, { transports: ["websocket"], auth: { client: "dashboard", userId: user.id } });
    socket.on("connect", () => socket.emit("admin:subscribe", result => { if (!result?.ok) unavailable(); }));
    socket.on("admin:network", accept);
    socket.on("disconnect", unavailable);
    socket.on("connect_error", error => { unavailable(); if (["AUTH_REQUIRED", "AUTH_CHANGED"].includes(error.message)) window.location.replace("/login"); });
    socket.on("session:error", data => { unavailable(); $("accountError").textContent = data.message; if (data.reason === "AUTH_REQUIRED") window.location.replace("/login"); });
    setInterval(() => { if (lastReceived && Date.now() - lastReceived >= STALE_MS) unavailable(); }, 1000);
  }
} catch (error) { $("accountError").textContent = error.message; unavailable(); throw error; }
}
