import { ALL_REPORTS_ID, isInReportPeriod, reportPeriodLabel } from "./report-period.js?v=20261119-all-reports-default1";

// report-day: comparte el estado del módulo de reportes sin crear conexiones.
export function createReportDay(reportState, reportActions) {
function renderDay() {
  const activeReport = reportState.reports.find(item => item.id === reportState.selectedReport);
  const consolidatedMode = reportState.selectedReport === ALL_REPORTS_ID;
  const detailedReports = consolidatedMode
    ? reportState.reports
    : activeReport ? [activeReport] : [];
  const reportTeamLabel = (name, owner = "") => {
    const team = String(name || "SIN EQUIPO").trim() || "SIN EQUIPO";
    return consolidatedMode && owner ? `${team} · ${owner}` : team;
  };
  const userFilterOptions = reportState.isAdmin ? `
    <option value="all" ${reportState.reportScope === "all" ? "selected" : ""}>Todos los usuarios</option>
    <option value="mine" ${reportState.reportScope === "mine" ? "selected" : ""}>Mis reportes</option>
    ${(reportState.reportUsers || []).map(user => {
      const value = `user:${user.id}`;
      return `<option value="${reportState.esc(value)}" ${reportState.reportScope === value ? "selected" : ""}>${reportState.esc(user.username)}</option>`;
    }).join("")}
  ` : "";
  const detailedTeams = reportState.showingDetailedReport && detailedReports.length
    ? Array.from(new Set(detailedReports.flatMap(report => [
        ...(report.rows || []).map(contact => reportTeamLabel(contact.workerName, report.owner)),
        ...(report.calls || []).map(call => reportTeamLabel(call.workerName, report.owner))
      ]).filter(Boolean)))
        .sort((left, right) => left.localeCompare(right, "es", {
          numeric: true
        }))
    : [];
  if (!consolidatedMode && reportState.showingDetailedReport && activeReport?.rows?.some(contact =>
    !String(contact.workerName || "").trim() && !contact.lastCallAt
  )) {
    detailedTeams.push("SIN EQUIPO");
  }
  if (reportState.showingDetailedReport) {
    if (!detailedTeams.length) detailedTeams.push("SIN EQUIPO");
    if (reportState.selectedDetailedTeam && !detailedTeams.includes(reportState.selectedDetailedTeam)) {
      reportState.selectedDetailedTeam = "";
    }
  }

  reportState.$("dailyReportMount").innerHTML = `
    <div class="report-day-toolbar">
      <div class="report-toolbar-top">
       <div class="report-day-title">
        <h2><span class="report-title-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16.5v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.12 3.8 2 2 0 0 1 3.1 1.6h3a2 2 0 0 1 2 1.72c.12.9.34 1.78.65 2.62a2 2 0 0 1-.45 2.11L7 9.35a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.11-.45c.84.31 1.72.53 2.62.65A2 2 0 0 1 21 16.5Z"/></svg></span>Reporte de llamadas</h2>
        <span class="report-day-subtitle">Registro y gestión de llamadas por rubro, usuario y equipo.</span>
       </div>
       <div class="report-filter-controls">
        ${!reportState.showingDetailedReport ? `
          <label class="report-search-input">
            <span aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg></span>
            <input
              id="reportSearch"
              type="search"
              placeholder="Buscar rubro, empresa, teléfono, equipo o ID"
              aria-label="Buscar en los reportes"
              value="${reportState.esc(reportState.reportSearchTerm)}"
            />
          </label>` : ""}
        ${reportState.isAdmin ? `
          <label class="report-filter-field" for="reportScope">
            <span>Usuario</span>
            <select id="reportScope" aria-label="Filtrar reportes por usuario">${userFilterOptions}</select>
          </label>` : ""}
        ${reportState.viewedPeriod && reportState.reports.length ? `
          <label class="report-filter-field" for="reportRangeRecord">
            <span>Fecha y rubro</span>
            <select id="reportRangeRecord">
              <option value="${ALL_REPORTS_ID}" ${reportState.selectedReport === ALL_REPORTS_ID ? "selected" : ""}>Todos los reportes (${reportState.reports.length})</option>
              ${reportState.reports.map(report => `<option value="${reportState.esc(report.id)}" ${report.id === reportState.selectedReport ? "selected" : ""}>${reportState.esc(reportState.formatDetailedDate(report.date))} · ${reportState.esc(report.rubro)}${report.owner ? ` · ${reportState.esc(report.owner)}` : ""}</option>`).join("")}
            </select>
          </label>` : ""}
       </div>
      </div>
      <div class="report-tools ${reportState.showingDetailedReport ? "report-tools-teams" : ""} ${consolidatedMode ? "report-tools-consolidated" : ""}">
        ${reportState.showingDetailedReport
          ? `<div class="report-rubros" aria-label="Equipos del reporte">
              ${detailedTeams.map((team, index) => `
                <button
                  type="button"
                  data-team="${reportState.esc(team)}"
                  class="${team === reportState.selectedDetailedTeam ? "chosen" : ""}"
                  aria-pressed="${team === reportState.selectedDetailedTeam}"
                >
                  <span class="report-rubro-number">${index + 1}</span>
                  <span>${reportState.esc(team)}</span>
                </button>
              `).join("")}
            </div>`
          : `<div class="report-rubros" aria-label="Rubros del reporte">
              ${reportState.reports
                .map((report, index) => `
                <button
                  type="button"
                  data-rubro="${reportState.esc(report.id)}"
                  class="${reportState.selectedReport !== ALL_REPORTS_ID && report.id === reportState.selectedReport ? "chosen" : ""}"
                  aria-pressed="${reportState.selectedReport !== ALL_REPORTS_ID && report.id === reportState.selectedReport}"
                >
                  <span class="report-rubro-number">${reportState.visibleRubrosStart + index + 1}</span>
                  <span>${reportState.esc(report.rubro)}${reportState.viewedPeriod ? ` · ${reportState.esc(reportState.formatDetailedDate(report.date))}` : ""}</span>
                  ${report.owner ? `<small class="report-rubro-owner">${reportState.esc(report.owner)}</small>` : ""}
                </button>
              `).join("")}
            </div>`}
      </div>
    </div>

      ${reportState.reports.length ? `
        <div id="reportDetails"></div>
      ` : `
        <p class="report-empty-state">No hay llamadas registradas para ${reportState.esc(reportPeriodLabel(reportState.viewedPeriod || {from: reportState.selectedDate, to: reportState.selectedDate}))}.</p>
      `}
      <nav class="report-date-navigation" aria-label="Navegar por fecha" ${reportState.viewedPeriod && reportState.viewedPeriod.from !== reportState.viewedPeriod.to ? "hidden" : ""}>
        <button id="reportPreviousDay" class="secondary" type="button"
          ${reportActions.shiftReportDate(reportState.selectedDate || reportState.viewedPeriod?.from, -1) ? "" : "disabled"}>
          ← ANTERIOR
        </button>
        <button id="reportNextDay" class="secondary" type="button"
          ${reportActions.shiftReportDate(reportState.selectedDate || reportState.viewedPeriod?.from, 1) ? "" : "disabled"}>
          SIGUIENTE →
        </button>
      </nav>
    `;

    renderDayNavigation();

    reportState.$("reportPreviousDay").onclick = () => {
      const currentDate = reportState.selectedDate || reportState.viewedPeriod?.from;
      const previousDate = reportActions.shiftReportDate(currentDate, -1);
      if (previousDate) reportActions.showDay(previousDate);
    };
    reportState.$("reportNextDay").onclick = () => {
      const currentDate = reportState.selectedDate || reportState.viewedPeriod?.from;
      const nextDate = reportActions.shiftReportDate(currentDate, 1);
      if (nextDate) reportActions.showDay(nextDate);
    };

    reportState.$("backCalendar").onclick = reportActions.showCalendar;
    const scopeSelect = reportState.$("reportScope");
    if (scopeSelect) scopeSelect.onchange = event => reportActions.setReportScope(event.target.value);
    if (reportState.$("reportRangeRecord")) reportState.$("reportRangeRecord").onchange = event => {
      reportState.selectedReport = event.currentTarget.value || ALL_REPORTS_ID;
      reportState.showingDetailedReport = false;
      reportState.detailedPendingOnly = false;
      reportState.selectedContactIds.clear();
      renderDay();
    };
    if (!reportState.showingDetailedReport) {
      reportState.$("reportSearch").oninput = event => {
        reportState.reportSearchTerm = event.currentTarget.value;
        reportActions.renderDetails();
      };
    }

    reportState.$("dailyReportMount")
      .querySelectorAll("[data-rubro]")
      .forEach(button => {
        button.onclick = () => {
          reportState.selectedReport = button.dataset.rubro;
          reportState.showingDetailedReport = false;
          reportState.detailedPendingOnly = false;
          const selectedIndex = reportState.reports.findIndex(
            report => report.id === reportState.selectedReport
          );
          if (selectedIndex >= 0) {
            reportState.visibleRubrosStart = Math.max(
              0,
              Math.min(
                selectedIndex - 1,
                reportState.reports.length - reportState.rubrosPerPage
              )
            );
          }
          renderDay();
        };
      });

    reportState.$("dailyReportMount")
      .querySelectorAll("[data-team]")
      .forEach(button => {
        button.onclick = () => {
          reportState.selectedDetailedTeam = reportState.selectedDetailedTeam === button.dataset.team
            ? ""
            : button.dataset.team;
          renderDay();
        };
      });

    if (reportState.reports.length) reportActions.renderDetails();
  }

function clearDayNavigation() {
    document.querySelectorAll(
      ".report-nav #backCalendar"
    ).forEach(button => button.remove());
  }

function renderDayNavigation() {
    clearDayNavigation();

    const backToCalls = reportState.$("reportBackBtn");
    if (!backToCalls) return;

    backToCalls.insertAdjacentHTML("afterend", `
      <button id="backCalendar" class="secondary" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
        Calendario
      </button>
    `);
  }
async function setReportScope(scope) {
  const nextScope = String(scope || "");
  reportState.reportScope = ["all", "mine"].includes(nextScope) || /^user:\d+$/.test(nextScope)
    ? nextScope
    : "all";
  reportState.selectedReport = "";
  reportState.showingDetailedReport = false;
  reportState.detailedPendingOnly = false;
  reportState.visibleRubrosStart = 0;
  try {
    if (reportState.viewedPeriod?.from && reportState.viewedPeriod?.to) {
      // Conservar el rango que se estaba viendo (o el día, si era de una sola fecha).
      reportState.calendarRange = { ...reportState.viewedPeriod };
      await reportActions.showRange();
    } else if (reportState.selectedDate) {
      await reportActions.showDay(reportState.selectedDate);
    } else {
      await reportActions.showCalendar();
    }
  } catch (error) {
    reportActions.showError(error);
  }
}

return { renderDay, clearDayNavigation, renderDayNavigation, setReportScope };
}
