import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { validateReportPeriod, isInReportPeriod, reportPeriodLabel } from './report-period.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import { apiFetch as fetch, currentUser, bindAccountControls } from '../auth/auth-session.js';
import { isAnsweredAttempt } from '../../../shared/reports/report-metrics.js';

/**
 * createAttemptsController: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.buildCallReportPdf, dashboardActions.currentShiftSnapshot, dashboardActions.escHtml, dashboardActions.formatCallDuration, dashboardActions.formatReportDate, dashboardActions.reportResultClass, dashboardActions.reportResultLabel, dashboardState.campaignState, dashboardState.dashboardToken, dashboardState.latestSessionState, dashboardState.reportCacheSession, dashboardState.reportListFilter, dashboardState.reportPeriod, dashboardState.reportRequestSerial, dashboardState.reportResultFilter, dashboardState.reportRowsCache, dashboardState.reportShiftId, dashboardState.reportWorkerFilter, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createAttemptsController(dashboardState, dashboardActions) {
async function downloadCampaignReport() {
  if (!await loadUnifiedReportRows()) return;
  const reportRows = getVisibleReportRows();
  if (!reportRows.length) {
    setStatus("Aún no hay intentos para exportar.", true);
    return;
  }
  const shift = dashboardActions.currentShiftSnapshot()?.current || dashboardActions.currentShiftSnapshot()?.detected || {};
  const selectedShift = dashboardState.reportShiftId ? reportRows[0]?.shiftLabel || "Turno seleccionado" : "Todos los turnos";
  const pdf = await dashboardActions.buildCallReportPdf("Historial de llamadas", reportRows, {
    ...shift, label: selectedShift, date: reportPeriodLabel(dashboardState.reportPeriod), schedule: ""
  });
  const blob = new Blob([pdf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `reporte_llamadas_${dashboardState.reportPeriod.from ? dashboardState.reportPeriod.from + "_a_" + dashboardState.reportPeriod.to : "todo_el_historial"}.pdf`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Reporte PDF generado con ${reportRows.length} llamada${reportRows.length === 1 ? "" : "s"}.`, true);
}

function mapCampaignReportRow(item, fallbackList = "") {
  const workerId = String(item.workerId || "").trim();
  const workerName = String(item.workerName || item.worker || workerId || "").trim();
  return {
    reportDate: item.reportDate || reportDateKey(item.startedAt),
    shiftId: item.shiftId || ((Date.parse(item.startedAt) || 0) >= (Date.parse(dashboardActions.currentShiftSnapshot()?.current?.startedAt) || Infinity) ? dashboardActions.currentShiftSnapshot()?.current?.id || "" : ""),
    shiftLabel: item.shiftLabel || "",
    attemptId: item.attemptId || "",
    contactId: item.contactId || "",
    list: item.list || fallbackList || "",
    name: item.name || "",
    phone: item.phone || "",
    workerId,
    workerName,
    worker: workerName || workerId,
    attemptNumber: Number(item.attemptNumber || 0),
    startedAt: item.startedAt || "",
    answeredAt: item.answeredAt || "",
    endedAt: item.endedAt || "",
    waitingSeconds: Number(item.waitingSeconds ?? (item.startedAt && (item.answeredAt || item.endedAt)
      ? Math.max(0, Math.round((Date.parse(item.answeredAt || item.endedAt) - Date.parse(item.startedAt)) / 1000)) : 0)),
    totalSeconds: Number(item.totalSeconds ?? (item.startedAt && item.endedAt
      ? Math.max(0, Math.round((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 1000)) : 0)),
    durationSeconds: Number(item.durationSeconds || 0),
    technicalResult: item.technicalResult || "",
    disposition: item.disposition || ""
  };
}

function reportWorkerKey(row) {
  return String(row?.workerId || row?.worker || "Sin equipo").trim() || "Sin equipo";
}

function reportWorkerLabel(row) {
  return String(row?.workerName || row?.worker || row?.workerId || "Sin equipo").trim() || "Sin equipo";
}

function reportDateKey(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}

function getUnifiedReportRows() {
  const rows = new Map();
  for (const row of [...(dashboardState.reportCacheSession === dashboardState.sessionCode ? dashboardState.reportRowsCache : []), ...getCampaignReportRows()]) {
    const key = row.attemptId || [row.contactId, row.phone, row.workerId, row.attemptNumber, row.startedAt].join("|");
    const previous = rows.get(key);
    rows.set(key, { ...previous, ...row,
      shiftId: row.shiftId || previous?.shiftId || "",
      shiftLabel: row.shiftLabel || previous?.shiftLabel || ""
    });
  }
  return [...rows.values()].sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}

function getVisibleReportRows() {
  const query = String(refs.campaignReportFilterEl?.value || "").trim().toLocaleLowerCase("es");
  return getUnifiedReportRows().filter(row =>
    isInReportPeriod(row.reportDate, dashboardState.reportPeriod) &&
    (!dashboardState.reportShiftId || row.shiftId === dashboardState.reportShiftId) &&
    (!dashboardState.reportListFilter || String(row.list || "") === dashboardState.reportListFilter) &&
    (!dashboardState.reportWorkerFilter || reportWorkerKey(row) === dashboardState.reportWorkerFilter) &&
    (!dashboardState.reportResultFilter || String(row.disposition || row.technicalResult || "") === dashboardState.reportResultFilter) &&
    (!query || [row.name, row.phone, row.list, row.worker,
      dashboardActions.reportResultLabel(row.technicalResult), dashboardActions.reportResultLabel(row.disposition)]
      .some(value => String(value || "").toLocaleLowerCase("es").includes(query))));
}

async function loadUnifiedReportRows() {
  const status = document.getElementById("reportsLoadStatus");
  if (!dashboardState.sessionCode || !dashboardState.dashboardToken) {
    if (status) status.textContent = "Espera a que cargue tu historial.";
    return false;
  }
  const code = dashboardState.sessionCode;
  const request = ++dashboardState.reportRequestSerial;
  if (dashboardState.reportCacheSession !== code) {
    dashboardState.reportRowsCache = [];
    dashboardState.reportCacheSession = code;
  }
  if (status) status.textContent = "Cargando historial…";
  try {
    const response = await fetch(API_BASE + "/api/session/" + encodeURIComponent(code) + "/reports/attempts", {
      headers: { "X-Dashboard-Token": dashboardState.dashboardToken }
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo cargar el historial");
    if (dashboardState.sessionCode !== code || request !== dashboardState.reportRequestSerial) return false;
    dashboardState.reportRowsCache = (data.rows || []).map(item => mapCampaignReportRow(item));
    if (status) status.textContent = "";
    renderCampaignReport();
    document.dispatchEvent(new CustomEvent("reports:data", { detail: { rows: getUnifiedReportRows() } }));
    return true;
  } catch (error) {
    if (dashboardState.sessionCode === code && request === dashboardState.reportRequestSerial && status) {
      status.textContent = "No se pudo cargar el historial completo. Vuelve a abrir Reportes para reintentar.";
    }
    return false;
  }
}

function getCampaignReportRows() {
  const sources = [dashboardState.campaignState?.turn?.currentReport, dashboardState.campaignState?.history];
  const rows = new Map();
  for (const source of sources) {
    for (const item of Array.isArray(source) ? source : []) {
      const key = item.attemptId || [item.contactId, item.workerId, item.attemptNumber, item.startedAt].join("|");
      rows.set(key, mapCampaignReportRow(item, dashboardState.campaignState?.listName || ""));
    }
  }
  return [...rows.values()].sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}

async function getAllCampaignReportRows() {
  const rows = [];
  // Combina todas las fuentes disponibles. Esto evita perder las llamadas de un
  // equipo cuando el snapshot del turno llega unos instantes antes que el
  // historial más reciente de la campaña.
  const reportSources = [
    dashboardState.campaignState?.turn?.currentReport,
    dashboardState.latestSessionState?.shiftManagement?.currentReport,
    dashboardState.campaignState?.history,
    dashboardState.latestSessionState?.campaign?.history
  ];
  reportSources.forEach((source) => {
    if (!Array.isArray(source)) return;
    for (const item of source) rows.push(mapCampaignReportRow(item, dashboardState.campaignState?.listName || ""));
  });
  const unique = new Map();
  rows.forEach((row, index) => {
    const key = row.attemptId || [row.list, row.phone, reportWorkerKey(row), row.attemptNumber, row.startedAt, row.endedAt, index].join("|");
    unique.set(key, row);
  });
  const currentTurn = dashboardState.campaignState?.turn?.current || dashboardState.latestSessionState?.shiftManagement?.current;
  const turnStart = Date.parse(currentTurn?.startedAt || "") || 0;
  return [...unique.values()].filter((row) => !turnStart || (Date.parse(row.startedAt || "") || 0) >= turnStart).sort((left, right) => {
    const workerOrder = reportWorkerKey(left).localeCompare(reportWorkerKey(right), "es", {
      sensitivity: "base",
      numeric: true
    });
    if (workerOrder !== 0) return workerOrder;
    const leftAnswered = isAnsweredAttempt(left);
    const rightAnswered = isAnsweredAttempt(right);
    if (leftAnswered !== rightAnswered) return leftAnswered ? -1 : 1;
    const leftTime = new Date(left.startedAt || 0).getTime() || 0;
    const rightTime = new Date(right.startedAt || 0).getTime() || 0;
    return leftTime - rightTime;
  });
}

function renderCampaignReport() {
  if (!refs.campaignReportBodyEl) return;
  const query = String(refs.campaignReportFilterEl?.value || "").trim().toLocaleLowerCase("es");
  const shiftSelect = document.getElementById("reportShiftFilter");
  const periodRows = getUnifiedReportRows().filter(row => isInReportPeriod(row.reportDate, dashboardState.reportPeriod));
  const shifts = new Map(periodRows
    .filter(row => row.shiftId)
    .map(row => [row.shiftId, row.shiftLabel || "Turno"]));
  if (dashboardState.reportShiftId && !shifts.has(dashboardState.reportShiftId)) dashboardState.reportShiftId = "";
  if (shiftSelect) {
    const options = '<option value="">Todos los turnos</option>' + [...shifts].map(([id, label]) =>
      '<option value="' + dashboardActions.escHtml(id) + '">' + dashboardActions.escHtml(label) + '</option>').join("");
    if (shiftSelect.innerHTML !== options) shiftSelect.innerHTML = options;
    shiftSelect.value = dashboardState.reportShiftId;
  }
  const fillSelect = (id, allLabel, values, current) => {
    const select = document.getElementById(id);
    if (!select) return;
    const options = '<option value="">' + allLabel + '</option>' + [...values].sort((a, b) => a.localeCompare(b, "es")).map(value =>
      '<option value="' + dashboardActions.escHtml(value) + '">' + dashboardActions.escHtml(value) + '</option>').join("");
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = current;
  };
  const lists = new Set(periodRows.map(row => String(row.list || "").trim()).filter(Boolean));
  if (dashboardState.reportListFilter && !lists.has(dashboardState.reportListFilter)) dashboardState.reportListFilter = "";
  fillSelect("reportListFilter", "Todas las listas", lists, dashboardState.reportListFilter);
  const workers = new Set(periodRows.map(row => reportWorkerKey(row)).filter(key => key !== "Sin equipo"));
  if (dashboardState.reportWorkerFilter && !workers.has(dashboardState.reportWorkerFilter)) dashboardState.reportWorkerFilter = "";
  fillSelect("reportWorkerFilter", "Todos los equipos", workers, dashboardState.reportWorkerFilter);
  const results = new Map();
  for (const row of periodRows) {
    const value = String(row.disposition || row.technicalResult || "").trim();
    if (value) results.set(value, dashboardActions.reportResultLabel(value));
  }
  if (dashboardState.reportResultFilter && !results.has(dashboardState.reportResultFilter)) dashboardState.reportResultFilter = "";
  const resultSelect = document.getElementById("reportResultFilter");
  if (resultSelect) {
    const options = '<option value="">Todos los resultados</option>' + [...results].map(([value, label]) =>
      '<option value="' + dashboardActions.escHtml(value) + '">' + dashboardActions.escHtml(label) + '</option>').join("");
    if (resultSelect.innerHTML !== options) resultSelect.innerHTML = options;
    resultSelect.value = dashboardState.reportResultFilter;
  }
  const rows = getVisibleReportRows();
  if (refs.campaignReportBtn) refs.campaignReportBtn.disabled = !rows.length;
  if (refs.campaignReportCountEl) {
    refs.campaignReportCountEl.textContent = `${rows.length} ${rows.length === 1 ? "registro" : "registros"}`;
  }
  if (refs.campaignReportEmptyEl) {
    refs.campaignReportEmptyEl.style.display = rows.length ? "none" : "block";
    refs.campaignReportEmptyEl.textContent = query
      ? "No hay llamadas que coincidan con tu búsqueda."
      : dashboardState.reportPeriod.from || dashboardState.reportShiftId || dashboardState.reportListFilter || dashboardState.reportWorkerFilter || dashboardState.reportResultFilter ? "No hay llamadas con estos filtros. Prueba otras fechas, turnos o listas." : "Todavía no hay llamadas registradas.";
  }
  const reportTable = document.getElementById("campaignReportTableWrap");
  if (reportTable) reportTable.hidden = !rows.length;
  refs.campaignReportBodyEl.innerHTML = [...rows].reverse().map((item) => `
    <tr class="campaign-report-row ${dashboardActions.reportResultClass(item.disposition || item.technicalResult)}">
      <td>${dashboardActions.escHtml(item.list || "—")}</td>
      <td><strong>${dashboardActions.escHtml(item.name || "—")}</strong></td>
      <td class="campaign-report-phone">${dashboardActions.escHtml(item.phone || "—")}</td>
      <td>${dashboardActions.escHtml(item.worker || "—")}</td>
      <td>${item.attemptNumber || "—"}</td>
      <td>${dashboardActions.escHtml(dashboardActions.formatReportDate(item.startedAt))}</td>
      <td>${dashboardActions.escHtml(dashboardActions.formatReportDate(item.answeredAt))}</td>
      <td>${dashboardActions.escHtml(dashboardActions.formatReportDate(item.endedAt))}</td>
      <td>${dashboardActions.escHtml(dashboardActions.formatCallDuration(item.waitingSeconds))}</td>
      <td>${dashboardActions.escHtml(dashboardActions.formatCallDuration(item.durationSeconds))}</td>
      <td>${dashboardActions.escHtml(dashboardActions.formatCallDuration(item.totalSeconds))}</td>
      <td><span class="campaign-report-result technical ${dashboardActions.reportResultClass(item.technicalResult)}">${dashboardActions.escHtml(dashboardActions.reportResultLabel(item.technicalResult))}</span></td>
      <td><span class="campaign-report-result commercial ${dashboardActions.reportResultClass(item.disposition)}">${dashboardActions.escHtml(dashboardActions.reportResultLabel(item.disposition))}</span></td>
      <td><button type="button" class="secondary" data-report-attempt="${dashboardActions.escHtml(item.attemptId)}">Volver a llamar</button></td>
    </tr>
  `).join("");
}
return { downloadCampaignReport, mapCampaignReportRow, reportWorkerKey, reportWorkerLabel, reportDateKey, getUnifiedReportRows, getVisibleReportRows, loadUnifiedReportRows, getCampaignReportRows, getAllCampaignReportRows, renderCampaignReport };
}
