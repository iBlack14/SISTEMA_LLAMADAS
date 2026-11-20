import { ALL_REPORTS_ID, isInReportPeriod, reportPeriodLabel } from "./report-period.js?v=20261119-all-reports-default1";

// report-day: comparte el estado del módulo de reportes sin crear conexiones.
export function createReportDay(reportState, reportActions) {
function renderDay() {
  const activeReport = reportState.reports.find(item => item.id === reportState.selectedReport);
  const userFilterOptions = reportState.isAdmin ? `
    <option value="all" ${reportState.reportScope === "all" ? "selected" : ""}>Todos los usuarios</option>
    <option value="mine" ${reportState.reportScope === "mine" ? "selected" : ""}>Mis reportes</option>
    ${(reportState.reportUsers || []).map(user => {
      const value = `user:${user.id}`;
      return `<option value="${reportState.esc(value)}" ${reportState.reportScope === value ? "selected" : ""}>${reportState.esc(user.username)}</option>`;
    }).join("")}
  ` : "";
  const detailedTeams = reportState.showingDetailedReport && activeReport
    ? Array.from(new Set([
        ...(activeReport.rows || []).map(contact => contact.workerName),
        ...(activeReport.calls || []).map(call => call.workerName)
      ].map(name => String(name || "").trim()).filter(Boolean)))
        .sort((left, right) => left.localeCompare(right, "es", {
          numeric: true
        }))
    : [];
  if (reportState.showingDetailedReport && activeReport?.rows?.some(contact =>
    !String(contact.workerName || "").trim() && !contact.lastCallAt
  )) {
    detailedTeams.push("SIN EQUIPO");
  }
  if (reportState.showingDetailedReport) {
    if (!detailedTeams.length) detailedTeams.push("SIN EQUIPO");
    if (!detailedTeams.includes(reportState.selectedDetailedTeam)) {
      reportState.selectedDetailedTeam = detailedTeams[0];
    }
  }

  reportState.$("dailyReportMount").innerHTML = `
    <div class="report-day-toolbar">
      <div class="report-toolbar-top">
       <div class="report-day-title">
        <h2>REPORTE DE LLAMADAS</h2>
        <p id="reportPeriodSummary">${reportState.esc(reportPeriodLabel(reportState.viewedPeriod || {from: reportState.selectedDate, to: reportState.selectedDate}))}</p>
       </div>
       <div class="report-filter-controls">
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
      <div class="report-tools ${reportState.showingDetailedReport ? "report-tools-teams" : ""}">
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
          : `<label class="report-search-input">
              <span aria-hidden="true">🔎</span>
              <input
                id="reportSearch"
                type="search"
                placeholder="Buscar rubro, empresa, teléfono o equipo / ID"
                value="${reportState.esc(reportState.reportSearchTerm)}"
              />
            </label>
            <div class="report-rubros" aria-label="Rubros del reporte">
              ${reportState.reports
                .slice(reportState.visibleRubrosStart, reportState.visibleRubrosStart + reportState.rubrosPerPage)
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
        <p>No existen campañas registradas para ${reportState.viewedPeriod && reportState.viewedPeriod.from !== reportState.viewedPeriod.to ? "este rango de fechas" : "esta fecha"}.</p>
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
          reportState.selectedDetailedTeam = button.dataset.team;
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
        ← CALENDARIO
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
