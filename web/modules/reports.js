import { showPanelView } from "./panel-navigation.js";
import { apiFetch as fetch, currentUser } from "./auth.js";
import { readDashboardSession } from "./dashboard-session.js";
import { buildDetailedReport } from "./detailed-report.js";
import { isInReportPeriod, reportPeriodLabel } from "./report-period.js";
import { isAnsweredAttempt, isVoicemailAttempt, isInoperableAttempt, attemptResultLabel } from "./report-metrics.js";

(() => {
  const $ = id => document.getElementById(id);
  const reportPdfTableTheme = {
    header: [102, 0, 115],
    border: [219, 186, 222],
    text: [36, 16, 43],
    rows: [
      [255, 255, 255],
      [250, 247, 252]
    ]
  };

  const months = [
    "Enero", "Febrero", "Marzo", "Abril",
    "Mayo", "Junio", "Julio", "Agosto",
    "Septiembre", "Octubre", "Noviembre", "Diciembre"
  ];
  const formatDetailedDate = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return value;
    const [, year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      date.getFullYear() !== Number(year) ||
      date.getMonth() !== Number(month) - 1 ||
      date.getDate() !== Number(day)
    ) return value;
    const weekdays = ["DOM", "LUN", "MAR", "MIERC", "JUEV", "VIE", "SAB"];
    return `${weekdays[date.getDay()]} ${day}/${month}/${year}`;
  };

  let year = new Date().getFullYear();
  let selectedDate = "";
  let calendarRange = { from: "", to: "" };
  let viewedPeriod = null;
  let reports = [];
  let selectedReport = "";
  let selectionReportId = "";
  const selectedContactIds = new Set();
  let reportSearchTerm = "";
  let showingDetailedReport = false;
  let detailedPendingOnly = false;
  let selectedDetailedTeam = "";
  let visibleRubrosStart = 0;
  const rubrosPerPage = 3;

  const esc = value => String(value ?? "").replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char])
  );

function reportSession() {
  return readDashboardSession(localStorage, currentUser?.id);
}

function sessionCode() {
  return reportSession().code;
}

function dashboardToken() {
  return reportSession().token;
}
  function endpoint(path) {
  const base = window.location.origin;

  return new URL(
    `/api/session/${encodeURIComponent(sessionCode())}${path}`,
    base
  ).href;
}

  async function fetchReports(date = "") {
    const context = reportSession();
    if (!context.code || !context.token) {
      throw Error("Tu espacio de llamadas aún se está conectando. Espera unos segundos y pulsa Reintentar.");
    }

    const query = date
      ? `?date=${encodeURIComponent(date)}`
      : "";

    const response = await fetch(
      endpoint("/reports/daily" + query),
      {
        method: "GET",
        headers: {
          "X-Dashboard-Token": dashboardToken()
        }
      }
    );
    const data = await response.json();

    if (!response.ok) {
      throw Error(data.error || "Error consultando reportes");
    }

    return data.reports || [];
  }
  function showError(error) {
    $("dailyReportMount").innerHTML = `
      <p class="report-error">${esc(error.message || error)}</p>
      <button id="retryReports">Reintentar</button>
    `;

    $("retryReports").onclick = showCalendar;
  }

 async function showCalendar() {
   clearDayNavigation();
   viewedPeriod = null;

 try {
    reports = await fetchReports();

    selectedReport = "";

    renderCalendar();
  } catch (error) {
    showError(error);
  }
}
  function renderCalendar() {
    const dates = new Set(reports.map(r => r.date));

    const monthCards = months.map((name, month) => {
      const firstDay = new Date(year, month, 1).getDay();
      const daysCount = new Date(year, month + 1, 0).getDate();

      const blanks = Array.from(
        { length: firstDay },
        () => "<i></i>"
      ).join("");

      const days = Array.from(
        { length: daysCount },
        (_, index) => {
          const date =
            `${year}-${String(month + 1).padStart(2, "0")}-` +
            `${String(index + 1).padStart(2, "0")}`;

          return `
  <button
    type="button"
    data-date="${date}"
    aria-label="${date}: clic para seleccionar; doble clic o Enter para abrir el día"
    aria-pressed="false"
    class="${[
      dates.has(date) ? "has-report" : "",
      selectedDate === date ? "selected-date" : ""
    ].filter(Boolean).join(" ")}"
  >
    ${index + 1}
  </button>
`;
        }
      ).join("");

      return `
        <article class="report-month">
          <h3>${name}</h3>
          <div class="report-days">
            ${["D", "L", "M", "M", "J", "V", "S"]
              .map(d => `<b>${d}</b>`).join("")}
            ${blanks}
            ${days}
          </div>
        </article>
      `;
    }).join("");

    $("dailyReportMount").innerHTML = `
      <div class="report-heading">
        <h2>CALENDARIO ANUAL · REPORTES DE LLAMADAS</h2>
        <div>
          <button id="prevYear" class="secondary">‹</button>
          <strong>${year}</strong>
          <button id="nextYear" class="secondary">›</button>
        </div>
      </div>
      <p id="calendarRangeHint" role="status"></p>
      <div class="report-tools" style="margin-bottom:16px">
        <button id="reportRangeOpen" type="button" disabled>Ver reportes del rango</button>
        <button id="reportRangeClear" class="secondary" type="button">Limpiar selección</button>
      </div>
      <div class="months-grid">${monthCards}</div>
    `;

    $("prevYear").onclick = () => {
      year--;
      renderCalendar();
    };

    $("nextYear").onclick = () => {
      year++;
      renderCalendar();
    };

    $("dailyReportMount")
      .querySelectorAll("[data-date]")
      .forEach(button => {
        button.onclick = event => {
          if (event.detail > 1) return;
          const date = button.dataset.date;
          if (!calendarRange.from || calendarRange.to) {
            calendarRange = { from: date, to: "" };
          } else {
            calendarRange = {
              from: date < calendarRange.from ? date : calendarRange.from,
              to: date < calendarRange.from ? calendarRange.from : date
            };
          }
          paintCalendarRange();
        };
        button.ondblclick = () => showDay(button.dataset.date);
        button.onkeydown = event => {
          if (event.key === "Enter") {
            event.preventDefault();
            showDay(button.dataset.date);
          }
        };
      });
    $("reportRangeOpen").onclick = showRange;
    $("reportRangeClear").onclick = () => {
      calendarRange = { from: "", to: "" };
      paintCalendarRange();
    };
    paintCalendarRange();
  }

  function paintCalendarRange() {
    const { from, to } = calendarRange;
    $("dailyReportMount").querySelectorAll("[data-date]").forEach(button => {
      const date = button.dataset.date;
      const edge = date === from || date === to;
      const inside = Boolean(from && to && date >= from && date <= to);
      button.classList.toggle("range-start", date === from);
      button.classList.toggle("range-end", date === to);
      button.classList.toggle("selected-date", edge);
      button.classList.toggle("in-range", inside);
      button.setAttribute("aria-pressed", String(edge || inside));
    });
    $("calendarRangeHint").textContent = !from
      ? "Un clic: fecha de inicio; otro clic: fecha final. Doble clic: abrir el día."
      : !to ? `Desde ${reportPeriodLabel({from, to: from})}. Ahora elige la fecha final.`
        : `Rango seleccionado: ${reportPeriodLabel(calendarRange)}. Doble clic para abrir un día.`;
    $("reportRangeOpen").disabled = !from || !to;
    $("reportRangeClear").disabled = !from;
  }

  async function showRange() {
    if (!calendarRange.from || !calendarRange.to) return;
    const period = { ...calendarRange };
    $("reportRangeOpen").disabled = true;
    try {
      const allReports = await fetchReports();
      reports = allReports.filter(report => isInReportPeriod(report.date, period));
      viewedPeriod = period;
      selectedDate = "";
      selectedReport = reports[0]?.id || "";
      reportSearchTerm = "";
      visibleRubrosStart = 0;
      showingDetailedReport = false;
      detailedPendingOnly = false;
      renderDay();
    } catch (error) {
      showError(error);
    }
  }

  async function showDay(date) {
  viewedPeriod = null;
  calendarRange = { from: date, to: date };
  selectedDate = date;
  reportSearchTerm = "";
   visibleRubrosStart = 0;

  document.querySelectorAll(
    "#annualReport .report-days button"
  ).forEach(button => {
    button.classList.toggle(
      "selected-date",
      button.dataset.date === selectedDate
    );
  });

  try {
    reports = await fetchReports(date);
    selectedReport = reports[0]?.id || "";
    showingDetailedReport = false;
    detailedPendingOnly = false;
    renderDay();
  } catch (error) {
    showError(error);
  }
}

function shiftReportDate(value, offset) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + offset
  ));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function renderDay() {
  const activeReport = reports.find(item => item.id === selectedReport);
  const detailedTeams = showingDetailedReport && activeReport
    ? Array.from(new Set([
        ...(activeReport.rows || []).map(contact => contact.workerName),
        ...(activeReport.calls || []).map(call => call.workerName)
      ].map(name => String(name || "").trim()).filter(Boolean)))
        .sort((left, right) => left.localeCompare(right, "es", {
          numeric: true
        }))
    : [];
  if (showingDetailedReport && activeReport?.rows?.some(contact =>
    !String(contact.workerName || "").trim() && !contact.lastCallAt
  )) {
    detailedTeams.push("SIN EQUIPO");
  }
  if (showingDetailedReport) {
    if (!detailedTeams.length) detailedTeams.push("SIN EQUIPO");
    if (!detailedTeams.includes(selectedDetailedTeam)) {
      selectedDetailedTeam = detailedTeams[0];
    }
  }

  $("dailyReportMount").innerHTML = `
    <div class="report-day-toolbar">
      <div class="report-day-title">
        <h2>REPORTE DE LLAMADAS</h2>
        <p id="reportPeriodSummary">${esc(reportPeriodLabel(viewedPeriod || {from: selectedDate, to: selectedDate}))}</p>
        ${viewedPeriod && reports.length ? `
          <label for="reportRangeRecord">Fecha y rubro</label>
          <select id="reportRangeRecord">
            ${reports.map(report => `<option value="${esc(report.id)}" ${report.id === selectedReport ? "selected" : ""}>${esc(formatDetailedDate(report.date))} · ${esc(report.rubro)}</option>`).join("")}
          </select>` : ""}
      </div>
      <div class="report-tools ${showingDetailedReport ? "report-tools-teams" : ""}">
        ${showingDetailedReport
          ? `<div class="report-rubros" aria-label="Equipos del reporte">
              ${detailedTeams.map((team, index) => `
                <button
                  type="button"
                  data-team="${esc(team)}"
                  class="${team === selectedDetailedTeam ? "chosen" : ""}"
                  aria-pressed="${team === selectedDetailedTeam}"
                >
                  <span class="report-rubro-number">${index + 1}</span>
                  <span>${esc(team)}</span>
                </button>
              `).join("")}
            </div>`
          : `<label class="report-search-input">
              <span aria-hidden="true">🔎</span>
              <input
                id="reportSearch"
                type="search"
                placeholder="Buscar rubro, empresa o teléfono"
                value="${esc(reportSearchTerm)}"
              />
            </label>
            <div class="report-rubros" aria-label="Rubros del reporte">
              ${reports
                .slice(visibleRubrosStart, visibleRubrosStart + rubrosPerPage)
                .map((report, index) => `
                <button
                  type="button"
                  data-rubro="${esc(report.id)}"
                  class="${report.id === selectedReport ? "chosen" : ""}"
                  aria-pressed="${report.id === selectedReport}"
                >
                  <span class="report-rubro-number">${visibleRubrosStart + index + 1}</span>
                  <span>${esc(report.rubro)}${viewedPeriod ? ` · ${esc(formatDetailedDate(report.date))}` : ""}</span>
                </button>
              `).join("")}
            </div>`}
      </div>
    </div>

      ${reports.length ? `
        <div id="reportDetails"></div>
      ` : `
        <p>No existen campañas registradas para ${viewedPeriod ? "este rango de fechas" : "esta fecha"}.</p>
      `}
      <nav class="report-date-navigation" aria-label="Navegar por fecha" ${viewedPeriod ? "hidden" : ""}>
        <button id="reportPreviousDay" class="secondary" type="button"
          ${shiftReportDate(selectedDate, -1) ? "" : "disabled"}>
          ← ANTERIOR
        </button>
        <button id="reportNextDay" class="secondary" type="button"
          ${shiftReportDate(selectedDate, 1) ? "" : "disabled"}>
          SIGUIENTE →
        </button>
      </nav>
    `;

    renderDayNavigation();

    $("reportPreviousDay").onclick = () => {
      const previousDate = shiftReportDate(selectedDate, -1);
      if (previousDate) showDay(previousDate);
    };
    $("reportNextDay").onclick = () => {
      const nextDate = shiftReportDate(selectedDate, 1);
      if (nextDate) showDay(nextDate);
    };

    $("backCalendar").onclick = showCalendar;
    if ($("reportRangeRecord")) $("reportRangeRecord").onchange = event => {
      selectedReport = event.currentTarget.value;
      renderDay();
    };
    if (!showingDetailedReport) {
      $("reportSearch").oninput = event => {
        reportSearchTerm = event.currentTarget.value;
        renderDetails();
      };
    }

    $("dailyReportMount")
      .querySelectorAll("[data-rubro]")
      .forEach(button => {
        button.onclick = () => {
          selectedReport = button.dataset.rubro;
          showingDetailedReport = false;
          detailedPendingOnly = false;
          const selectedIndex = reports.findIndex(
            report => report.id === selectedReport
          );
          if (selectedIndex >= 0) {
            visibleRubrosStart = Math.max(
              0,
              Math.min(
                selectedIndex - 1,
                reports.length - rubrosPerPage
              )
            );
          }
          renderDay();
        };
      });

    $("dailyReportMount")
      .querySelectorAll("[data-team]")
      .forEach(button => {
        button.onclick = () => {
          selectedDetailedTeam = button.dataset.team;
          renderDay();
        };
      });

    if (reports.length) renderDetails();
  }

  function clearDayNavigation() {
    document.querySelectorAll(
      ".report-nav #backCalendar"
    ).forEach(button => button.remove());
  }

  function renderDayNavigation() {
    clearDayNavigation();

    const backToCalls = $("reportBackBtn");
    if (!backToCalls) return;

    backToCalls.insertAdjacentHTML("afterend", `
      <button id="backCalendar" class="secondary" type="button">
        ← CALENDARIO
      </button>
    `);
  }

  function renderDetails() {
    const report = reports.find(
      item => item.id === selectedReport
    );

    if (!report) return;

    if (selectionReportId !== report.id) {
      selectionReportId = report.id;
      selectedContactIds.clear();
    }
    const canSelect = contact => !contact.doNotCall && !contact.manualBlocked && !isInoperableAttempt(contact);
    const eligibleIds = new Set(report.rows.filter(canSelect).map(contact => String(contact.id)));
    for (const id of selectedContactIds) if (!eligibleIds.has(id)) selectedContactIds.delete(id);

    const normalizeSearchText = value => String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    const term = normalizeSearchText(reportSearchTerm).trim();
    const tableRows = (term
      ? reports.flatMap(reportItem =>
        reportItem.rows.map(contact => ({ report: reportItem, contact }))
      ).filter(({ report: reportItem, contact }) =>
        normalizeSearchText(
          `${reportItem.rubro} ${contact.name} ${contact.phone} ` +
          `${contact.list || ""} ${contact.workerName || ""} ` +
          `${contact.technicalResult || ""}`
        ).includes(term)
      )
      : report.rows.map(contact => ({ report, contact }))
    );
    const rows = report.rows.filter(contact =>
      normalizeSearchText(
        `${report.rubro} ${contact.name} ${contact.phone} ` +
        `${contact.list || ""} ${contact.workerName || ""} ` +
        `${contact.technicalResult || ""}`
      ).includes(term)
    );

    const equipmentCount = new Set(
      report.rows
        .map(contact => String(contact.workerName || "").trim())
        .filter(Boolean)
    ).size;
    const formatReportDate = value => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
      if (!match) return value;
      const monthNames = [
        "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
        "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
      ];
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(year, month - 1, day);
      if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
      ) return value;
      const weekdays = ["DOM", "LUN", "MAR", "MIERC", "JUEV", "VIE", "SAB"];
      return `${weekdays[date.getDay()]} ${match[3]}/` +
        `${monthNames[month - 1]}/${match[1]}`;
    };
    const metrics = [
      ["RUBRO", report.rubro],
      ["FECHA", formatReportDate(report.date)],
      ["EQUIPOS USADOS", equipmentCount || "—"],
      ["NÚMEROS USADOS", report.numbers],
      ["LLAMADAS TOTALES", report.totalCalls],
      ["CONTESTADAS", report.answered],
      ["BUZONES", report.voicemail ?? report.rows.filter(isVoicemailAttempt).length],
      ["INOPERABLES", report.rows.filter(isInoperableAttempt).length],
      ["PENDIENTES", report.pending]
    ];

    const status = attemptResultLabel;
    const statusClass = contact =>
      isVoicemailAttempt(contact) ? "is-voicemail" :
      isAnsweredAttempt(contact) ? "is-answered" :
      isInoperableAttempt(contact) ? "is-inoperable" : "is-pending";
    const limaDateTime = value => {
      if (!value) return "—";
      const timestamp = new Date(value);
      if (Number.isNaN(timestamp.getTime())) return "—";
      return new Intl.DateTimeFormat("es-PE", {
        timeZone: "America/Lima",
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }).format(timestamp);
    };
    const formatDuration = value => {
      const seconds = Math.max(0, Number(value) || 0);
      return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
        `${String(seconds % 60).padStart(2, "0")}`;
    };

    const makeDetailedRows = () => buildDetailedReport(report, selectedDetailedTeam, detailedPendingOnly);

    const renderDetailedReport = () => {
      const detailed = makeDetailedRows();
      const teamNames = Array.from(new Set([
        ...(report.rows || []).map(contact => contact.workerName),
        ...(report.calls || []).map(call => call.workerName)
      ].map(name => String(name || "").trim()).filter(Boolean)))
        .sort((left, right) => left.localeCompare(right, "es", {
          numeric: true
        }));
      const teamIndex = Math.max(0, teamNames.indexOf(selectedDetailedTeam));
      const teamLabel = /^EQUIPO\s+\d+$/i.test(selectedDetailedTeam)
        ? selectedDetailedTeam.toUpperCase()
        : selectedDetailedTeam === "SIN EQUIPO"
          ? selectedDetailedTeam
          : `EQUIPO ${teamIndex + 1}`;
      const modelName = report.teamModels?.[selectedDetailedTeam] ||
        (/^EQUIPO\s+\d+$/i.test(selectedDetailedTeam)
          ? "MODELO NO REGISTRADO"
          : selectedDetailedTeam);
      const equipmentHeading = selectedDetailedTeam === "SIN EQUIPO" ? "Equipo no registrado" :
        teamLabel === modelName ? teamLabel : `${teamLabel}: ${modelName}`;
      const teamCalls = (report.calls || []).filter(call =>
        String(call.workerName || "").trim() === selectedDetailedTeam
      );
      const teamShiftTypes = new Set(teamCalls.map(call => {
        if (!call.startedAt) return "";
        const callDate = new Date(call.startedAt);
        if (Number.isNaN(callDate.getTime())) return "";
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Lima",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        }).formatToParts(callDate);
        const hour = Number(parts.find(part => part.type === "hour")?.value);
        const minute = Number(parts.find(part => part.type === "minute")?.value);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "";
        const minutes = hour * 60 + minute;
        if (minutes >= 7 * 60 && minutes < 13 * 60 + 30) return "TURNO MAÑANA";
        if (minutes >= 13 * 60 + 30 && minutes < 20 * 60 + 30) return "TURNO TARDE";
        return "FUERA DE TURNO";
      }).filter(Boolean));
      const teamShift = report.teamShifts?.[selectedDetailedTeam] ||
        (teamShiftTypes.size === 1
          ? [...teamShiftTypes][0]
          : teamShiftTypes.size > 1
            ? "TURNOS MIXTOS"
            : "TURNO SIN REGISTRO");
      const teamSummary = [
        ["LLAMADAS TOTALES", detailed.metrics.calls, "total"],
        ["CONTESTADAS", detailed.metrics.answered, "answered"],
        ["NO CONTESTADAS", detailed.metrics.noAnswer, "no-answer"],
        ["BUZONES", detailed.metrics.voicemail, "voicemail"],
        ["INOPERABLE", detailed.metrics.inoperable, "inoperable"],
        ["PENDIENTE", detailed.metrics.pending, "pending"]
      ];
      const detailedColumns = [
        "EQUIPO",
        "TOTAL DESIGNADO",
        "HORA",
        "LLAMADAS TOTALES",
        "CONTESTADAS",
        "NO CONTESTADAS",
        "BUZONES",
        "INOPERABLE",
        "PENDIENTE"
      ];

      $("reportDetails").innerHTML = `
        <section class="report-content-panel report-detailed-panel"
          aria-label="Reporte detallado">
          <div class="report-detailed-summary">
            <div class="report-detailed-equipment">
              <h3>${esc(equipmentHeading)}</h3>
              <span>${esc(teamShift)} | ${esc(formatDetailedDate(report.date))} | ${
                detailed.metrics.calls
              } llamadas</span>
            </div>
            <div class="report-detailed-metrics">
              ${teamSummary.map(([label, value, tone]) => `
                <article class="report-detailed-metric ${tone}">
                  <span>${label}</span>
                  <strong>${value}</strong>
                </article>
              `).join("")}
            </div>
          </div>
          <div class="report-detailed-table-wrap">
            <table class="report-detailed-table">
              <thead>
                <tr>${detailedColumns.map(column =>
                  `<th class="${column === "HORA" ? "report-detailed-hour-cell" : ""}">${column}</th>`
                ).join("")}</tr>
              </thead>
              <tbody>
                ${detailed.rows.map((row, index) => `
                  <tr>
                    ${index === 0 ? `
                      <td rowspan="${detailed.rows.length}">
                        ${esc(row.team)}
                      </td>
                      <td rowspan="${detailed.rows.length}">
                        ${row.designated}
                      </td>
                    ` : ""}
                    <td class="report-detailed-hour-cell">${esc(row.hour)}</td>
                    <td>${row.calls}</td>
                    <td>${row.answered}</td>
                    <td>${row.noAnswer}</td>
                    <td>${row.voicemail}</td>
                    <td>${row.inoperable}</td>
                    <td>${row.pending}</td>
                  </tr>
                `).join("") || `
                  <tr><td colspan="9">${
                    detailedPendingOnly
                      ? "No hay contactos pendientes."
                      : "No hay llamadas registradas."
                  }</td></tr>
                `}
              </tbody>
            </table>
          </div>
          <div class="report-footer report-detailed-footer">
            <div class="report-actions">
              <button id="detailedBack" class="secondary" type="button">
                ← VOLVER AL REPORTE
              </button>
              <button id="detailedPdf" type="button">
                ⬇ DESCARGAR REPORTE
              </button>
              <button id="detailedPending" class="secondary" type="button"
                aria-pressed="${detailedPendingOnly}">
                ${detailedPendingOnly ? "VER TODO" : "PENDIENTE"}
              </button>
            </div>
            <div class="report-continue report-detailed-campaign-actions">
              <button id="detailedStop" class="secondary" type="button"
                >
                DETENER
              </button>
              <button id="detailedCallPending" type="button"
                ${!report.pending ? "disabled" : ""}>
                LLAMAR PENDIENTES
              </button>
            </div>
          </div>
        </section>
      `;

      $("detailedBack").onclick = () => {
        showingDetailedReport = false;
        detailedPendingOnly = false;
        renderDay();
      };
      $("detailedPending").onclick = () => {
        detailedPendingOnly = !detailedPendingOnly;
        renderDetailedReport();
      };
      $("detailedStop").onclick = async () => {
        if (!confirm("¿Detener la campaña y las llamadas activas?")) return;
        const button = $("detailedStop");
        button.disabled = true;
        try {
          const response = await fetch(endpoint("/campaign/stop"), {
            method: "POST",
            headers: {
              "X-Dashboard-Token": dashboardToken()
            }
          });
          const data = await response.json();
          if (!response.ok) {
            throw Error(data.error || "No se pudo detener la campaña.");
          }
          alert("Campaña detenida. El historial se conservó.");
        } catch (error) {
          alert(error.message || "No se pudo detener la campaña.");
        } finally {
          button.disabled = false;
        }
      };
      $("detailedCallPending").onclick = () => {
        showingDetailedReport = false;
        detailedPendingOnly = false;
        renderDay();
      };
      $("detailedPdf").onclick = async () => {
        const JsPDF = window.jspdf?.jsPDF;
        if (!JsPDF) {
          alert("Librería PDF no disponible");
          return;
        }
        const button = $("detailedPdf");
        button.disabled = true;
        try {
          const logoResponse = await fetch("/logo-vc-color.png");
          if (!logoResponse.ok) {
            throw Error("No se pudo cargar el logotipo del reporte.");
          }
          const logoBlob = await logoResponse.blob();
          const logoData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(
              Error("No se pudo preparar el logotipo del reporte.")
            );
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(logoBlob);
          });

          const pdf = new JsPDF("landscape", "mm", "a4");
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = pdf.internal.pageSize.getHeight();
          const margin = 10;
          const columnWidths = [36, 26, 29, 34, 28, 32, 28, 30, 34];
          const rowHeightFor = lines => Math.max(
            8,
            ...lines.map(linesInCell => linesInCell.length * 3.6 + 3)
          );
          const drawHeader = y => {
            pdf.setFillColor(232, 0, 169);
            pdf.rect(0, 0, pageWidth, 3, "F");
            pdf.addImage(logoData, "PNG", margin, 7, 32, 19);
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(17);
            pdf.setTextColor(84, 20, 105);
            pdf.text("REPORTE DE LLAMADAS", margin + 38, 17);
            pdf.setFontSize(9);
            pdf.setFont("helvetica", "normal");
            pdf.setTextColor(...reportPdfTableTheme.text);
            pdf.text("Lima - Peru", pageWidth - margin, 16, {
              align: "right"
            });
            pdf.setDrawColor(...reportPdfTableTheme.border);
            pdf.line(margin, 28, pageWidth - margin, 28);

            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(11);
            pdf.setTextColor(192, 0, 132);
            pdf.text(
              pdf.splitTextToSize(
                equipmentHeading,
                84
              ),
              margin + 2,
              37
            );
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(7.5);
            pdf.setTextColor(...reportPdfTableTheme.text);
            pdf.text(
              pdf.splitTextToSize(
                `${teamShift} | ${formatDetailedDate(report.date)} | ${detailed.metrics.calls} llamadas`,
                84
              ),
              margin + 2,
              44
            );
            const cardGap = 2;
            const cardStartX = margin + 90;
            const cardWidth = (
              pageWidth - margin - cardStartX - cardGap * (teamSummary.length - 1)
            ) / teamSummary.length;
            const cardTop = 32;
            const cardHeight = 22;
            teamSummary.forEach(([label, value, tone], index) => {
              const colors = {
                total: [117, 0, 138],
                answered: [2, 132, 199],
                "no-answer": [176, 0, 96],
                voicemail: [153, 94, 0],
                inoperable: [117, 0, 138],
                pending: [0, 129, 84]
              };
              const color = colors[tone];
              const x = cardStartX + index * (cardWidth + cardGap);
              pdf.setDrawColor(...color);
              pdf.setLineWidth(0.35);
              pdf.setFillColor(255, 255, 255);
              pdf.roundedRect(x, cardTop, cardWidth, cardHeight, 2, 2, "FD");
              pdf.setFont("helvetica", "bold");
              pdf.setFontSize(5.5);
              pdf.setTextColor(...color);
              pdf.text(
                pdf.splitTextToSize(label, cardWidth - 4),
                x + 2,
                cardTop + 6
              );
              pdf.setFontSize(11);
              pdf.text(String(value), x + 2, cardTop + 17);
            });
            const tableWidth = columnWidths.reduce(
              (total, width) => total + width,
              0
            );
            pdf.setDrawColor(...reportPdfTableTheme.header);
            pdf.setFillColor(...reportPdfTableTheme.header);
            pdf.roundedRect(
              margin,
              y,
              tableWidth,
              10,
              2,
              2,
              "FD"
            );
            let x = margin;
            for (let index = 0; index < detailedColumns.length; index++) {
              pdf.setFont("helvetica", "bold");
              pdf.setFontSize(6.7);
              pdf.setTextColor(255, 255, 255);
              pdf.text(
                pdf.splitTextToSize(
                  detailedColumns[index],
                  columnWidths[index] - 3
                ),
                x + 1.5,
                y + 4
              );
              x += columnWidths[index];
            }
            return { y: y + 10, tableTop: y, tableWidth };
          };

          let { y, tableTop, tableWidth } = drawHeader(62);
          const drawTableFrame = bottom => {
            pdf.setDrawColor(...reportPdfTableTheme.border);
            pdf.roundedRect(
              margin,
              tableTop,
              tableWidth,
              Math.max(10, bottom - tableTop),
              2,
              2,
              "S"
            );
          };
          const exportRows = detailed.rows.length
            ? detailed.rows.map(row => [
                row.team,
                String(row.designated),
                row.hour,
                String(row.calls),
                String(row.answered),
                String(row.noAnswer),
                String(row.voicemail),
                String(row.inoperable),
                String(row.pending)
              ])
            : [["", "", "", "", "", "", "", "", "Sin registros"]];
          const rowHeights = exportRows.map(values => {
            const lines = values.map((value, index) =>
              pdf.splitTextToSize(value, columnWidths[index] - 3)
            );
            return rowHeightFor(lines);
          });
          let rowIndex = 0;
          while (rowIndex < exportRows.length) {
            if (y + rowHeights[rowIndex] > pageHeight - 12) {
              drawTableFrame(y);
              pdf.addPage();
              ({ y, tableTop, tableWidth } = drawHeader(62));
            }
            const pageStart = rowIndex;
            let mergedHeight = 0;
            while (
              rowIndex < exportRows.length &&
              (rowIndex === pageStart ||
                y + mergedHeight + rowHeights[rowIndex] <= pageHeight - 12)
            ) {
              mergedHeight += rowHeights[rowIndex];
              rowIndex++;
            }

            const mergedFill = reportPdfTableTheme.rows[pageStart % 2];
            let x = margin;
            for (let index = 0; index < 2; index++) {
              pdf.setFillColor(...mergedFill);
              pdf.rect(x, y, columnWidths[index], mergedHeight, "F");
              pdf.setFont("helvetica", "normal");
              pdf.setFontSize(7.5);
              pdf.setTextColor(...reportPdfTableTheme.text);
              const label = exportRows[pageStart][index];
              const textY = y + mergedHeight / 2 + 1.3;
              pdf.text(
                pdf.splitTextToSize(label, columnWidths[index] - 3),
                index === 1 ? x + columnWidths[index] / 2 : x + 1.5,
                textY,
                index === 1 ? { align: "center" } : undefined
              );
              x += columnWidths[index];
            }
            const mergedColumnsWidth = columnWidths[0] + columnWidths[1];

            for (let index = pageStart; index < rowIndex; index++) {
              const values = exportRows[index];
              const lines = values.map((value, columnIndex) =>
                pdf.splitTextToSize(value, columnWidths[columnIndex] - 3)
              );
              const rowHeight = rowHeights[index];
              x = margin + mergedColumnsWidth;
              pdf.setFillColor(
                ...reportPdfTableTheme.rows[index % reportPdfTableTheme.rows.length]
              );
              pdf.rect(
                x,
                y,
                tableWidth - mergedColumnsWidth,
                rowHeight,
                "F"
              );
              for (let columnIndex = 2; columnIndex < values.length; columnIndex++) {
                pdf.setFont("helvetica", "normal");
                pdf.setFontSize(7.5);
                pdf.setTextColor(...reportPdfTableTheme.text);
                pdf.text(
                  lines[columnIndex],
                  x + columnWidths[columnIndex] / 2,
                  y + 4.7,
                  { align: "center" }
                );
                x += columnWidths[columnIndex];
              }
              pdf.setDrawColor(...reportPdfTableTheme.border);
              pdf.line(
                margin + mergedColumnsWidth,
                y + rowHeight,
                margin + tableWidth,
                y + rowHeight
              );
              y += rowHeight;
            }
            pdf.setDrawColor(...reportPdfTableTheme.border);
            pdf.line(
              margin + columnWidths[0],
              y - mergedHeight,
              margin + columnWidths[0],
              y
            );
            pdf.line(
              margin + mergedColumnsWidth,
              y - mergedHeight,
              margin + mergedColumnsWidth,
              y
            );
          }
          drawTableFrame(y);
          const pageCount = pdf.internal.getNumberOfPages();
          for (let page = 1; page <= pageCount; page++) {
            pdf.setPage(page);
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(7);
            pdf.setTextColor(110, 100, 115);
            pdf.text(
              `Pagina ${page} de ${pageCount}`,
              pageWidth - margin,
              pageHeight - 4,
              { align: "right" }
            );
          }
          const suffix = detailedPendingOnly ? "-pendientes" : "";
          const rubroFileName = normalizeSearchText(report.rubro)
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          const teamFileName = normalizeSearchText(selectedDetailedTeam)
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          pdf.save(
            `reporte-detallado-${rubroFileName}-${teamFileName}-${report.date}${suffix}.pdf`
          );
        } catch (error) {
          alert(error.message || "No se pudo generar el reporte detallado.");
        } finally {
          button.disabled = false;
        }
      };
    };

    if (showingDetailedReport) {
      renderDetailedReport();
      return;
    }

    $("reportDetails").innerHTML = `
      <section class="report-content-panel" aria-label="Detalle del reporte">
        <section class="report-summary" aria-label="Resumen del reporte">
          <div class="report-metrics">
            ${metrics.map(([name, value]) => `
              <div class="report-metric">
                <span class="report-metric-label">${esc(name)}:</span>
                <strong class="report-metric-value">${esc(value)}</strong>
              </div>
            `).join("")}
          </div>
        </section>

        <section class="report-detail-card" aria-label="Llamadas del reporte">
          ${term ? `
            <div class="report-detail-heading">
              <h3>RESULTADOS DE BÚSQUEDA (${tableRows.length})</h3>
            </div>
          ` : ""}
          <div id="report-detail-table" class="report-table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="report-select-cell"><input id="reportSelectAll" type="checkbox" aria-label="Seleccionar todos los números disponibles visibles" /></th>
                  <th>N.</th>
                  <th>BASE</th>
                  <th>EMPRESA</th>
                  <th>TELEFONO</th>
                  <th>EQUIPO</th>
                  <th>HORA LIMA</th>
                  <th>INT.</th>
                  <th>DURACION</th>
                  <th>RESULTADO</th>
                  <th class="report-row-action-cell">LLAMAR</th>
                </tr>
              </thead>
              <tbody>
                ${tableRows.map(({ report: rowReport, contact }, index) => `
                  <tr>
                    <td class="report-select-cell"><input type="checkbox" data-select-contact="${esc(String(contact.id))}"
                      aria-label="Seleccionar ${esc(contact.name)} ${esc(contact.phone)}"
                      ${rowReport.id === report.id && canSelect(contact) ? "" : 'disabled title="Número bloqueado, inoperable o de otro rubro"'}
                      ${rowReport.id === report.id && selectedContactIds.has(String(contact.id)) ? "checked" : ""} /></td>
                    <td>${index + 1}</td>
                    <td>${esc(contact.list || rowReport.rubro)}</td>
                    <td>${esc(contact.name)}</td>
                    <td>${esc(contact.phone)}</td>
                    <td>${esc(contact.workerName || "—")}</td>
                    <td>${esc(limaDateTime(contact.lastCallAt))}</td>
                    <td>${esc(contact.attemptNumber || "—")}</td>
                    <td>${esc(formatDuration(contact.durationSeconds))}</td>
                    <td class="report-result ${statusClass(contact)}">
                      ${esc(status(contact))}
                    </td>
                    <td class="report-row-action-cell">
                      ${canSelect(contact)
                        ? `<button type="button" class="report-row-call" data-call-report-contact="${esc(String(contact.id))}" data-call-report-id="${esc(rowReport.id)}" aria-label="Llamar a ${esc(contact.name)} ${esc(contact.phone)}">☎ Llamar</button>`
                        : `<span class="report-no-call">${contact.doNotCall || ["numero_inexistente", "numero_incorrecto"].includes(contact.technicalResult) ? "NO VOLVER A LLAMAR" : contact.manualBlocked ? "BLOQUEADO" : "INOPERABLE"}</span>`}
                    </td>
                  </tr>
                `).join("") || `
                  <tr>
                    <td colspan="11">Sin resultados</td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>
          <div class="report-footer">
            <div class="report-actions">
              <button id="reportPdf" type="button">⬇ DESCARGAR REPORTE</button>
              <button id="reportTotalPdf" class="secondary" type="button">
                ⬇ DESCARGA TOTAL
              </button>
            </div>
            <div class="report-continue">
              <span id="reportSelectionCount" role="status">0 seleccionados</span>
              <button id="reportDetailed" class="secondary" type="button">
                DETALLADO
              </button>
              <button
                id="reportContinue" type="button" disabled
              >
                LLAMAR SELECCIONADOS
              </button>
            </div>
          </div>
          <p id="reportSelectionFeedback" role="status" hidden></p>
        </section>
      </section>
    `;

    let selectionSubmitting = false;
    const checkboxes = () => [...$("reportDetails").querySelectorAll("[data-select-contact]:not(:disabled)")];
    const updateSelection = () => {
      const visible = checkboxes();
      const checked = visible.filter(input => selectedContactIds.has(input.dataset.selectContact)).length;
      $("reportSelectAll").disabled = !visible.length;
      $("reportSelectAll").checked = visible.length > 0 && checked === visible.length;
      $("reportSelectAll").indeterminate = checked > 0 && checked < visible.length;
      $("reportSelectionCount").textContent = `${selectedContactIds.size} seleccionados`;
      $("reportContinue").disabled = selectionSubmitting || !selectedContactIds.size;
      $("reportDetails").querySelectorAll("[data-call-report-contact]").forEach(button => { button.disabled = selectionSubmitting; });
      $("reportContinue").textContent = selectedContactIds.size ? `LLAMAR SELECCIONADOS (${selectedContactIds.size})` : "LLAMAR SELECCIONADOS";
    };
    $("reportSelectAll").onchange = event => {
      for (const input of checkboxes()) {
        input.checked = event.currentTarget.checked;
        if (input.checked) selectedContactIds.add(input.dataset.selectContact);
        else selectedContactIds.delete(input.dataset.selectContact);
      }
      updateSelection();
    };
    for (const input of checkboxes()) input.onchange = () => {
      if (input.checked) selectedContactIds.add(input.dataset.selectContact);
      else selectedContactIds.delete(input.dataset.selectContact);
      updateSelection();
    };
    updateSelection();

    const exportReportsToPdf = async (reportsForExport, clickedButton) => {
      const JsPDF = window.jspdf?.jsPDF;

      if (!JsPDF) {
        alert("Librería PDF no disponible");
        return;
      }

      clickedButton.disabled = true;
      try {
        const calledReports = reportsForExport.filter(reportItem =>
          Number(reportItem.totalCalls || 0) > 0 ||
          (Array.isArray(reportItem.calls) && reportItem.calls.length > 0) ||
          (Array.isArray(reportItem.rows) &&
            reportItem.rows.some(contact => contact.lastCallAt))
        );
        const reportsToExport = Array.from(
          calledReports.reduce((reportsByRubro, reportItem) => {
            const rubroKey = normalizeSearchText(reportItem.rubro);
            let combined = reportsByRubro.get(rubroKey);
            if (!combined) {
              combined = {
                ...reportItem,
                numbers: 0,
                totalCalls: 0,
                answered: 0,
                voicemail: 0,
                pending: 0,
                rows: []
              };
              reportsByRubro.set(rubroKey, combined);
            }
            combined.numbers += Number(reportItem.numbers || 0);
            combined.totalCalls += Number(reportItem.totalCalls || 0);
            combined.answered += Number(reportItem.answered || 0);
            combined.voicemail += Number(reportItem.voicemail ?? (reportItem.rows || []).filter(isVoicemailAttempt).length);
            combined.pending += Number(reportItem.pending || 0);
            combined.rows.push(...(reportItem.rows || []));
            return reportsByRubro;
          }, new Map()).values()
        );
        if (!reportsToExport.length) {
          alert("No hay rubros con llamadas registradas para esta fecha.");
          return;
        }

        const logoResponse = await fetch("/logo-vc-color.png");
        if (!logoResponse.ok) {
          throw Error("No se pudo cargar el logotipo del reporte.");
        }
        const logoBlob = await logoResponse.blob();
        const logoData = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(
            Error("No se pudo preparar el logotipo del reporte.")
          );
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(logoBlob);
        });

        for (const report of reportsToExport) {
          const term = "";
          const pdf = new JsPDF("landscape", "mm", "a4");
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = pdf.internal.pageSize.getHeight();
          const margin = 10;
          const columns = [
            { title: "N.", width: 9 },
            { title: "BASE", width: 31 },
            { title: "EMPRESA", width: 53 },
            { title: "TELEFONO", width: 43 },
            { title: "EQUIPO", width: 31 },
            { title: "HORA LIMA", width: 35 },
            { title: "INT.", width: 13 },
            { title: "DURACION", width: 24 },
            { title: "RESULTADO", width: pageWidth - margin * 2 - 239 }
          ];
          const tableWidth = columns.reduce(
            (width, column) => width + column.width,
            0
          );
          const callRecords = report.rows.map(contact => ({
            ...contact,
            list: contact.list || report.rubro,
            startedAt: contact.lastCallAt,
            answeredAt: contact.answered ? contact.lastCallAt : null
          }));
          const filteredCalls = callRecords.filter(call =>
            normalizeSearchText(
            `${report.rubro} ${call.name || ""} ${call.phone || ""} ${call.list || ""} ` +
            `${call.workerName || ""} ${call.technicalResult || ""} ` +
            `${call.disposition || ""}`
            ).includes(term)
          );
          const resultForCall = attemptResultLabel;
          const groups = new Map([[
            report.id,
            { name: report.rubro, equipmentLabel: "", calls: filteredCalls }
          ]]);

          const totalCalls = Number(
            report.totalCalls ||
            filteredCalls.filter(call => call.startedAt).length
          );
          const resultCounts = filteredCalls.reduce((counts, call) => {
            const result = resultForCall(call);
            if (result === "CONTESTO") counts.answered++;
            if (result === "PENDIENTE") counts.pending++;
            return counts;
          }, { answered: 0, pending: 0 });
          const equipmentCount = new Set(
            report.rows.map(contact => String(contact.workerName || "").trim())
              .filter(Boolean)
          ).size;
          const rowHeightFor = lines => Math.max(
            8,
            ...lines.map(value => value.length * 3.6 + 3)
          );
          const drawHeader = (pageInTeam, showSummary) => {
            const cardTop = 37;
            pdf.setFillColor(232, 0, 169);
            pdf.rect(0, 0, pageWidth, 3, "F");
            pdf.addImage(logoData, "PNG", margin, 7, 26, 14);
            pdf.setTextColor(84, 20, 105);
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(14);
            pdf.text("REPORTE DE LLAMADAS", 42, 13);
            pdf.setFontSize(8);
            pdf.text(report.rubro.toUpperCase(), 42, 19);
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(7.5);
            pdf.text("LIMA - PERU", pageWidth - margin, 10, { align: "right" });
            pdf.text(`FECHA: ${formatReportDate(report.date)}`, pageWidth - margin, 16, {
              align: "right"
            });
            pdf.setDrawColor(218, 198, 226);
            pdf.line(margin, 29, pageWidth - margin, 29);

            pdf.setDrawColor(112, 9, 127);
            pdf.setFillColor(255, 255, 255);
            pdf.roundedRect(margin, cardTop, tableWidth, 12, 2, 2, "FD");
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(9);
            pdf.setTextColor(84, 20, 105);
            pdf.text(
              `REPORTE DE LLAMADAS${pageInTeam > 1 ? " (CONTINUACION)" : ""}`,
              margin + 3,
              cardTop + 7.5
            );
            pdf.setFillColor(232, 0, 169);
            pdf.roundedRect(pageWidth - margin - 42, cardTop + 2, 39, 8, 4, 4, "F");
            pdf.setFontSize(7);
            pdf.setTextColor(255, 255, 255);
            pdf.text(report.rubro.toUpperCase(), pageWidth - margin - 22.5, cardTop + 7.2, {
              align: "center",
              maxWidth: 34
            });

            let y = cardTop + 18;
            if (showSummary) {
              const metrics = [
                ["RUBRO:", report.rubro],
                ["FECHA:", formatReportDate(report.date)],
                ["EQUIPOS USADOS:", equipmentCount || "—"],
                ["NÚMEROS USADOS:", report.numbers],
                ["LLAMADAS TOTALES:", totalCalls],
                ["CONTESTADAS:", report.answered ?? resultCounts.answered],
                ["BUZONES:", report.voicemail ?? report.rows.filter(isVoicemailAttempt).length],
                ["INOPERABLES:", report.rows.filter(isInoperableAttempt).length],
                ["PENDIENTES:", report.pending ?? resultCounts.pending]
              ];
              pdf.setFontSize(7.5);
              for (const [label, value] of metrics) {
                pdf.setFont("helvetica", "bold");
                pdf.setTextColor(84, 20, 105);
                pdf.text(label, margin + 3, y);
                pdf.setFont("helvetica", "normal");
                pdf.setTextColor(118, 114, 123);
                pdf.text(String(value), margin + 36, y);
                y += 5;
              }
            }

            y += 2;
            pdf.setDrawColor(218, 0, 169);
            pdf.line(margin + 2, y, pageWidth - margin - 2, y);
            y += 8;

            const tableTop = y;
            pdf.setDrawColor(...reportPdfTableTheme.header);
            pdf.setFillColor(...reportPdfTableTheme.header);
            pdf.roundedRect(
              margin,
              y,
              tableWidth,
              9,
              2,
              2,
              "FD"
            );
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(7);
            pdf.setTextColor(255, 255, 255);
            let x = margin;
            for (const column of columns) {
              pdf.text(column.title, x + 1.5, y + 6);
              x += column.width;
            }
            return { y: y + 9, tableTop };
          };
          const drawRows = (group, showSummary) => {
            let pageInTeam = 1;
            let { y, tableTop } = drawHeader(pageInTeam, showSummary);
            let groupRowNumber = 0;
            const records = group.calls.length ? group.calls : [null];
            const drawCardFrame = bottom => {
              pdf.setDrawColor(...reportPdfTableTheme.border);
              pdf.roundedRect(
                margin,
                tableTop,
                tableWidth,
                Math.max(9, bottom - tableTop),
                2,
                2,
                "S"
              );
            };

            for (const call of records) {
              const dateTime = call
                ? call.startedAt
                  ? limaDateTime(call.startedAt).replace(", ", "\n")
                  : "—"
                : "";
              const values = call
                ? [
                    String(++groupRowNumber),
                    String(call.list || report.rubro),
                    String(call.name || ""),
                    String(call.phone || ""),
                    String(call.workerName || "—"),
                    dateTime,
                    String(call.attemptNumber || "—"),
                    formatDuration(call.durationSeconds),
                    resultForCall(call)
                  ]
                : ["", "", "Sin llamadas registradas", "", "", "", "", "", ""];
              const lines = values.map((value, index) =>
                value.split("\n").flatMap(line =>
                  pdf.splitTextToSize(
                    line,
                    columns[index].width - 3
                  )
                )
              );
              const rowHeight = rowHeightFor(lines);

              if (y + rowHeight > pageHeight - 12) {
                drawCardFrame(y);
                pdf.addPage();
                pageInTeam++;
                ({ y, tableTop } = drawHeader(pageInTeam, false));
              }

              pdf.setFillColor(
                ...reportPdfTableTheme.rows[
                  Math.max(groupRowNumber - 1, 0) %
                    reportPdfTableTheme.rows.length
                ]
              );
              pdf.rect(margin, y, tableWidth, rowHeight, "F");
              let x = margin;
              for (let index = 0; index < columns.length; index++) {
                const isResult = index === 8;
                pdf.setFont("helvetica", isResult ? "bold" : "normal");
                pdf.setFontSize(7.5);
                pdf.setTextColor(...reportPdfTableTheme.text);
                const resultColors = {
                  CONTESTO: [0, 118, 79],
                  "BUZÓN DE VOZ": [153, 94, 0],
                  INOPERABLE: [220, 38, 38],
                  PENDIENTE: [0, 129, 84]
                };
                pdf.setTextColor(
                  ...(isResult
                    ? resultColors[values[index]] || [46, 40, 50]
                    : reportPdfTableTheme.text)
                );
                pdf.text(lines[index], x + 1.5, y + 4.7);
                x += columns[index].width;
              }
              pdf.setDrawColor(...reportPdfTableTheme.border);
              pdf.line(
                margin,
                y + rowHeight,
                margin + tableWidth,
                y + rowHeight
              );
              y += rowHeight;
            }
            drawCardFrame(y);
          };

          let groupIndex = 0;
          for (const group of groups.values()) {
            if (groupIndex > 0) pdf.addPage();
            drawRows(group, groupIndex === 0);
            groupIndex++;
          }

          const pageCount = pdf.internal.getNumberOfPages();
          for (let page = 1; page <= pageCount; page++) {
            pdf.setPage(page);
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(7);
            pdf.setTextColor(110, 100, 115);
            pdf.text(
              `Lima - Peru  |  Pagina ${page}`,
              pageWidth - margin,
              pageHeight - 4,
              { align: "right" }
            );
          }

          const rubroFileName = normalizeSearchText(report.rubro)
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          pdf.save(`reporte-${rubroFileName}-${report.date}.pdf`);
        }
        alert(
          reportsToExport.length === 1
            ? `Se descargó el reporte de ${reportsToExport[0].rubro}.`
            : `Se generaron ${reportsToExport.length} archivos PDF, uno por cada rubro con llamadas.`
        );
      } catch (error) {
        alert(error.message || "No se pudo generar el reporte PDF.");
      } finally {
        clickedButton.disabled = false;
      }
    };

    $("reportPdf").onclick = () =>
      exportReportsToPdf([report], $("reportPdf"));
    $("reportTotalPdf").onclick = () =>
      exportReportsToPdf(reports, $("reportTotalPdf"));

    const startReportCalls = async (targetReportId, contactIds) => {
      if (!contactIds.length || selectionSubmitting) return;
      selectionSubmitting = true;
      updateSelection();
      const button = $("reportContinue");
      const feedback = $("reportSelectionFeedback");
      button.disabled = true;
      feedback.hidden = true;
      try {
        const response = await fetch(
          endpoint(
            `/reports/${encodeURIComponent(targetReportId)}/continue`
          ),
        
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Dashboard-Token": dashboardToken() },
            body: JSON.stringify({ contactIds, manualRetry: true })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw Error(data.error || "No se pudo iniciar");
        }

        selectedContactIds.clear();
        $("reportBackBtn").click();
        const statusText = $("statusText");
        if (statusText) statusText.textContent = `${data.queued} contactos seleccionados agregados a la campaña.`;
      } catch (error) {
        feedback.textContent = error.message || "No se pudieron iniciar las llamadas seleccionadas.";
        feedback.hidden = false;
      } finally {
        selectionSubmitting = false;
        updateSelection();
      }
    };

    $("reportContinue").onclick = () => startReportCalls(report.id, [...selectedContactIds]);
    $("reportDetails").querySelectorAll("[data-call-report-contact]").forEach(button => {
      button.onclick = () => startReportCalls(button.dataset.callReportId, [button.dataset.callReportContact]);
    });

    $("reportDetailed").onclick = () => {
      showingDetailedReport = true;
      detailedPendingOnly = false;
      selectedDetailedTeam = "";
      renderDay();
    };
  }

  const bindReportNav = () => {
    $("reportNavBtn")?.addEventListener("click", () => {
      showPanelView("reports");
      showCalendar();
    });

    $("reportBackBtn")?.addEventListener("click", () => {
      showPanelView("calls");
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindReportNav);
  } else {
    bindReportNav();
  }
})();