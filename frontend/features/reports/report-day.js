import { isInReportPeriod, reportPeriodLabel } from "./report-period.js";

// report-day: comparte el estado del módulo de reportes sin crear conexiones.
export function createReportDay(reportState, reportActions) {
function renderDay() {
  const activeReport = reportState.reports.find(item => item.id === reportState.selectedReport);
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
      <div class="report-day-title">
        <h2>REPORTE DE LLAMADAS</h2>
        <p id="reportPeriodSummary">${reportState.esc(reportPeriodLabel(reportState.viewedPeriod || {from: reportState.selectedDate, to: reportState.selectedDate}))}</p>
        ${reportState.viewedPeriod && reportState.reports.length ? `
          <label for="reportRangeRecord">Fecha y rubro</label>
          <select id="reportRangeRecord">
            ${reportState.reports.map(report => `<option value="${reportState.esc(report.id)}" ${report.id === reportState.selectedReport ? "selected" : ""}>${reportState.esc(reportState.formatDetailedDate(report.date))} · ${reportState.esc(report.rubro)}</option>`).join("")}
          </select>` : ""}
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
                placeholder="Buscar rubro, empresa o teléfono"
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
                  class="${report.id === reportState.selectedReport ? "chosen" : ""}"
                  aria-pressed="${report.id === reportState.selectedReport}"
                >
                  <span class="report-rubro-number">${reportState.visibleRubrosStart + index + 1}</span>
                  <span>${reportState.esc(report.rubro)}${reportState.viewedPeriod ? ` · ${reportState.esc(reportState.formatDetailedDate(report.date))}` : ""}</span>
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
    if (reportState.$("reportRangeRecord")) reportState.$("reportRangeRecord").onchange = event => {
      reportState.selectedReport = event.currentTarget.value;
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
return { renderDay, clearDayNavigation, renderDayNavigation };
}
