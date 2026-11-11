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
const resultLabels = { contesto: "Contestó", sin_respuesta: "Sin respuesta", no_contesto: "No contestó", no_contactado: "No contactado", buzon_de_voz: "Buzón de voz", sin_servicio: "Sin servicio", no_disponible: "No disponible", numero_incorrecto: "Número incorrecto", numero_inexistente: "No volver a llamar" };


const tones = { "En llamada": "active", "Marcando": "dialing", "Disponible": "ready", "Desconectado": "offline", "Sin datos": "unknown" };
const duration = n => typeof n === "number" && Number.isFinite(n) ? Math.floor(n / 60) + ":" + String(Math.floor(n % 60)).padStart(2, "0") : "—";
function displayState(item, live) {
  return live && tones[item.state] ? item.state : "Sin datos";
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
  el.innerHTML = '<span class="orb-num"></span><span class="indicator-dot"></span><span class="orb-sub"></span>';
  el.addEventListener("click", () => {
    const card = cards.get(number);
    if (!card) return;
    selectFilter("all");
    filterQuery = "";
    $("searchInput").value = "";
    applyFilters();
    card.scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center"});
    card.focus({preventScroll: true});
  });
  $("equipmentIndicators").appendChild(el);
  orbs.set(number, el);
  return el;
}
function renderOrb(el, number, state, name) {
  el.dataset.tone = tones[state];
  el.setAttribute("aria-label", `Equipo ${number}, ${name || ""}, ${state}. Ver detalle.`);
  el.querySelector(".orb-num").textContent = String(number).padStart(2, "0");
  el.querySelector(".orb-sub").textContent = state;
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
    <div><h3 class="card-title"></h3><span class="card-model"></span></div>
    <span class="card-pill"></span>
  </div>
  <div class="card-meta"></div>
  <div class="card-stats"></div>
  <div class="card-live" hidden></div>
  <details class="card-history"><summary>Actividad del turno <span class="card-activity"></span></summary>
    <div class="history-scroll" tabindex="0" role="region" aria-label="Actividad del equipo ${number}">
      <table><thead><tr><th scope="col">Contacto</th><th scope="col">Hora de Lima</th><th scope="col">Duración</th><th scope="col">Resultado</th></tr></thead><tbody class="card-rows"></tbody></table>
    </div>
  </details>
  <p class="card-scope"></p><p class="card-test" hidden>Equipo de prueba simulada</p>`;
  $("equipmentGrid").appendChild(card);
  cards.set(number, card);
  return card;
}
function renderCard(card, item, state, live) {
  card.dataset.state = state;
  card.dataset.tone = tones[state];
  card.dataset.search = `${item.number} Equipo ${String(item.number).padStart(2, "0")} ${item.name || ""} ${item.rubro || ""}`.toLowerCase();
  card.querySelector(".card-title").textContent = `Equipo ${String(item.number).padStart(2, "0")}`;
  const model = (item.name || "").replace(/\bCelular\b/gi, "Equipo").replace(/^Equipo\s*\d*\s*/i, "").trim();
  const modelEl = card.querySelector(".card-model");
  modelEl.textContent = model;
  modelEl.hidden = !model;
  const meta = card.querySelector(".card-meta");
  meta.innerHTML = [item.rubro, item.schedule].filter(Boolean).map(part => `<span>${esc(part)}</span>`).join("");
  meta.hidden = !meta.textContent;
  const pill = card.querySelector(".card-pill");
  pill.dataset.tone = tones[state];
  pill.textContent = state;
  const m = live && item.turn?.id && item.turn?.startedAt ? item.metrics : null;
  card.querySelector(".card-stats").innerHTML = statCell("Intentos", m?.total) + statCell("Contestadas", m?.answered) + statCell("Pendientes", m ? item.pending ?? m.pending : null);
  const liveBox = card.querySelector(".card-live");
  liveBox.hidden = !(live && item.calling && ["En llamada", "Marcando"].includes(state));
  liveBox.dataset.tone = tones[state];
  liveBox.textContent = state === "Marcando" ? "Llamada saliente en curso de marcación." : "Llamada activa en este equipo.";
  card.querySelector(".card-scope").textContent = item.scopeReason || (item.turn ? item.turn.label : "Sin turno activo");
  card.querySelector(".card-test").hidden = !item.simulated;
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
    historyKeyLoaded = "";
    for (const item of snapshot.equipment) {
      const card = cards.get(item.number);
      if (card) card.querySelector(".card-rows").innerHTML = `<tr><td colspan="4" class="muted">No se pudo cargar la actividad.</td></tr>`;
    }
  }
}

let filterState = "all";
let filterQuery = "";


function applyFilters() {
  let visible = 0;
  for (const card of cards.values()) {
    card.hidden = !((filterState === "all" || card.dataset.state === filterState) && (!filterQuery || (card.dataset.search || "").includes(filterQuery)));
    if (!card.hidden) visible++;
  }
  $("emptyResults").hidden = visible > 0 || !snapshot;
}
function updateFilterCounts() {
  const counts = {all: cards.size};
  for (const card of cards.values()) counts[card.dataset.state] = (counts[card.dataset.state] || 0) + 1;
  document.querySelectorAll("#stateFilters .filter-pill").forEach(button => {
    const base = button.dataset.label || (button.dataset.label = button.textContent.trim());
    button.textContent = `${base} (${counts[button.dataset.filter] ?? 0})`;
  });
}
function render() {
  if (!snapshot) return;
  const live = Boolean(socket?.connected && Date.now() - lastReceived < 6000);
  $("liveStatus").textContent = live ? "Conectado al servidor" : "Sin conexión en vivo";
  $("liveDot").className = "status-dot" + (live ? " connected" : "");
  $("updatedAt").textContent = `Última actualización: ${date(snapshot.generatedAt)}`;
  $("nodeCount").textContent = `${snapshot.equipment.length} posiciones`;
  $("downloadLog").disabled = false;
  const counts = {"En llamada": 0, "Marcando": 0, "Disponible": 0, "Desconectado": 0, "Sin datos": 0};
  const disconnected = [];
  for (const item of snapshot.equipment) {
    const state = displayState(item, live);
    counts[state]++;
    if (state === "Desconectado") disconnected.push(item);
    renderOrb(orbs.get(item.number) || createOrb(item.number), item.number, state, item.name);
    renderCard(cards.get(item.number) || createCard(item.number), item, state, live);
  }
  for (const [id, state] of [["legendActive","En llamada"],["legendDialing","Marcando"],["legendReady","Disponible"],["legendOffline","Desconectado"],["legendNone","Sin datos"]]) $(id).textContent = counts[state];
  const m = live ? snapshot.summary?.metrics : null;
  $("turnUnavailable").hidden = Boolean(m);
  $("turnUnavailable").textContent = live ? "No hay datos de turno para consolidar el resumen." : "El resumen no está disponible hasta recuperar la conexión.";
  $("kpiTotal").textContent = value(m?.total);
  $("kpiAnswered").textContent = value(m?.answered);
  $("kpiPending").textContent = value(m ? snapshot.summary.pending ?? m.pending : null);
  $("kpiProgress").textContent = value(m?.inProgress);
  $("kpiAnsweredPct").textContent = m && m.total > 0 && typeof m.answered === "number" ? `${Math.round(m.answered / m.total * 100)}% de contacto` : "";
  $("alertBanner").hidden = !live || !disconnected.length;
  $("alertTitle").textContent = `${disconnected.length} equipo(s) desconectado(s)`;
  $("alertText").textContent = disconnected.map(item => `Equipo ${item.number}`).join(", ");
  $("overflowNotice").hidden = !snapshot.overflow;
  $("overflowNotice").textContent = snapshot.overflow ? `${snapshot.overflow} equipo(s) adicional(es) fuera de las 10 posiciones.` : "";
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
function unavailable() { lastReceived = 0; $("liveStatus").textContent = "Sin conexión en vivo"; $("liveDot").className = "status-dot"; render(); }


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
        if (!r.ok) throw new Error("No se pudo actualizar el estado de los equipos.");
        const data = await r.json();
        if (data.unavailable || !Array.isArray(data.equipment)) throw new Error("El estado de equipos no está disponible.");
        snapshot = data; lastReceived = Date.now(); $("accountError").textContent = ""; render();
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
    $("searchInput").addEventListener("input", e => { filterQuery = e.target.value.trim().toLowerCase(); applyFilters(); });
    document.querySelectorAll("#stateFilters .filter-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        selectFilter(btn.dataset.filter);
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
    setInterval(() => { if (lastReceived && Date.now() - lastReceived >= 6000) unavailable(); }, 1000);
  }
} catch (error) { $("accountError").textContent = error.message; unavailable(); }
