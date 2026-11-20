import { reportPeriodLabel } from "./report-period.js";

// report-calendar: comparte el estado del módulo de reportes sin crear conexiones.
export function createReportCalendar(reportState, reportActions) {
let marksRequest = 0;

async function showCalendar() {
   reportActions.clearDayNavigation();
   reportState.viewedPeriod = null;
   reportState.selectedReport = "";

   // El calendario se dibuja de inmediato; las marcas llegan después.
   renderCalendar();
   try {
     await loadCalendarDates();
   } catch (error) {
     reportActions.showError(error);
   }
}

async function loadCalendarDates(year = reportState.year) {
   const request = ++marksRequest;
   const dates = await reportActions.fetchCalendarDates(year);
   if (request !== marksRequest) return;
   reportState.calendarDates = dates;
   renderCalendar();
}

function renderCalendar() {
    // Las marcas llegan del endpoint ligero; mientras tanto se usa lo ya cargado.
    const marks = reportState.calendarDates;
    const yearReports = (reportState.reports || []).filter(r => {
      const reportYear = r.date ? parseInt(r.date.split('-')[0]) : 0;
      return reportYear === reportState.year;
    });
    const dates = new Set(marks
      ? Object.keys(marks).filter(date => marks[date] > 0)
      : yearReports.map(r => r.date).filter(Boolean));
    const year = reportState.year;
    const todayValue = dateToValue(new Date());
    const selected = reportState.calendarRange;

    const months = reportState.months.map((monthName, month) => {
      const firstDay = new Date(year, month, 1).getDay();
      const daysCount = new Date(year, month + 1, 0).getDate();
      const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
      const monthReports = marks
        ? Object.entries(marks).reduce((sum, [date, count]) => sum + (date.startsWith(monthPrefix) ? count : 0), 0)
        : yearReports.filter(r => r.date?.startsWith(monthPrefix)).length;

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
      date === todayValue ? "is-today" : "",
      selected.from === date ? "range-start" : "",
      selected.to === date ? "range-end" : ""
    ].filter(Boolean).join(" ")}"
  >
    ${index + 1}
  </button>
`;
        }
      ).join("");

      return `
        <article class="report-month" aria-label="${monthName} ${year}">
          <header class="report-month-head">
            <span class="report-month-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg></span>
            <h3>${monthName}</h3>
            <span class="report-month-count" title="${monthReports} reporte(s) en ${monthName}">${monthReports}</span>
          </header>
          <div class="report-days">
            ${["D", "L", "M", "M", "J", "V", "S"]
              .map(d => `<b>${d}</b>`).join("")}
            ${blanks}
            ${days}
          </div>
        </article>
      `;
    }).join("");

    reportState.$("dailyReportMount").innerHTML = `
      <div class="report-heading">
        <h2>CALENDARIO · REPORTES DE LLAMADAS</h2>
        <div class="calendar-nav">
          <button id="prevYear" class="secondary" type="button" aria-label="Año anterior">‹</button>
          <strong id="calendarYearLabel">${year}</strong>
          <button id="nextYear" class="secondary" type="button" aria-label="Año siguiente">›</button>
          <button id="calendarTodayBtn" class="secondary" type="button">Hoy</button>
        </div>
      </div>
      <p id="calendarRangeHint" role="status"></p>
      <div class="report-tools" style="margin-bottom:16px">
        <button id="reportRangeOpen" type="button" disabled>Ver reportes del rango</button>
        <button id="reportRangeClear" class="secondary" type="button">Limpiar selección</button>
      </div>
      <div class="months-grid" id="monthsGrid">
        ${months}
      </div>
      <div id="reportRangeFab" class="report-range-fab" hidden>
        <span id="reportRangeFabText"></span>
        <button id="reportRangeFabOpen" type="button">Ver reportes</button>
      </div>
    `;

    reportState.$("prevYear").onclick = () => shiftCalendarYear(-1);

    reportState.$("nextYear").onclick = () => shiftCalendarYear(1);

    reportState.$("calendarTodayBtn").onclick = () => {
      const today = new Date();
      reportState.year = today.getFullYear();
      reportState.hoverDate = "";
      reportState.calendarDates = null;
      renderCalendar();
      const target = reportState.$("dailyReportMount")
        .querySelector(`[data-date="${dateToValue(today)}"]`);
      target?.focus();
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      loadCalendarDates().catch(error => reportActions.showError(error));
    };

    reportState.$("monthsGrid").onmouseleave = () => {
      if (!reportState.hoverDate) return;
      reportState.hoverDate = "";
      paintCalendarRange();
    };

    reportState.$("dailyReportMount")
      .querySelectorAll("[data-date]")
      .forEach(button => {
        button.onclick = event => {
          if (event.detail > 1) return;
          reportState.hoverDate = "";
          const date = button.dataset.date;
          if (!reportState.calendarRange.from || reportState.calendarRange.to) {
            reportState.calendarRange = { from: date, to: "" };
          } else {
            reportState.calendarRange = {
              from: date < reportState.calendarRange.from ? date : reportState.calendarRange.from,
              to: date < reportState.calendarRange.from ? reportState.calendarRange.from : date
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
        button.onmouseenter = () => {
          const { from, to } = reportState.calendarRange;
          if (!from || to) return;
          const date = button.dataset.date;
          if (reportState.hoverDate === date) return;
          reportState.hoverDate = date;
          paintCalendarRange();
        };
      });
    const rangeOpenButton = reportState.$("reportRangeOpen");
    const rangeFabOpenButton = reportState.$("reportRangeFabOpen");
    const rangeClearButton = reportState.$("reportRangeClear");
    if (rangeOpenButton) rangeOpenButton.onclick = showRange;
    if (rangeFabOpenButton) rangeFabOpenButton.onclick = showRange;
    if (rangeClearButton) rangeClearButton.onclick = () => {
      reportState.calendarRange = { from: "", to: "" };
      reportState.hoverDate = "";
      paintCalendarRange();
    };
    paintCalendarRange();
  }

function shiftCalendarYear(offset) {
    reportState.year += offset;
    reportState.hoverDate = "";
    reportState.calendarDates = null;
    renderCalendar();
    loadCalendarDates().catch(error => reportActions.showError(error));
  }

function dateToValue(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

// Mientras no se confirma el día final, el día bajo el cursor previsualiza el rango.
function resolveRange() {
    const { from, to } = reportState.calendarRange;
    const hover = reportState.hoverDate || "";
    if (from && !to && hover) {
      return {
        from: hover < from ? hover : from,
        to: hover < from ? from : hover,
        preview: true
      };
    }
    return { from, to, preview: false };
  }

function paintCalendarRange() {
    const active = resolveRange();
    reportState.$("dailyReportMount").querySelectorAll("[data-date]").forEach(button => {
      const date = button.dataset.date;
      const isStart = date === active.from;
      const isEnd = Boolean(active.to) && date === active.to;
      const inside = Boolean(active.from && active.to && date > active.from && date < active.to);
      button.classList.toggle("range-start", isStart);
      button.classList.toggle("range-end", isEnd);
      button.classList.toggle("selected-date", isStart || isEnd);
      button.classList.toggle("in-range", inside);
      button.classList.toggle("is-preview", active.preview && (isStart || isEnd || inside));
      button.setAttribute("aria-pressed", String(isStart || isEnd || inside));
    });
    const { from, to } = reportState.calendarRange;
    reportState.$("calendarRangeHint").textContent = !from
      ? "Un clic: fecha de inicio; otro clic: fecha final. Doble clic: abrir el día."
      : !to ? (active.preview
          ? `Rango a confirmar: ${reportPeriodLabel(active)}. Clic para confirmar.`
          : `Desde ${reportPeriodLabel({from, to: from})}. Ahora elige la fecha final.`)
        : `Rango seleccionado: ${reportPeriodLabel(reportState.calendarRange)}. Doble clic para abrir un día.`;
    const rangeOpenButton = reportState.$("reportRangeOpen");
    const rangeClearButton = reportState.$("reportRangeClear");
    if (rangeOpenButton) rangeOpenButton.disabled = !from || !to;
    if (rangeClearButton) rangeClearButton.disabled = !from;

    const fab = reportState.$("reportRangeFab");
    if (fab) {
      const ready = Boolean(from && to);
      fab.hidden = !ready;
      if (ready) {
        const days = countRangeDays(from, to);
        reportState.$("reportRangeFabText").textContent =
          `${days} ${days === 1 ? "día" : "días"} seleccionados`;
        // Muestra la acción dentro del mes donde terminó la selección.
        const endDay = reportState.$("dailyReportMount")
          .querySelector(`[data-date="${to}"]`);
        const endMonth = endDay?.closest(".report-month");
        if (endMonth && fab.parentElement !== endMonth) endMonth.append(fab);
      }
    }
  }

function countRangeDays(from, to) {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    return Math.round((end - start) / 86400000) + 1;
  }

async function showRange() {
    if (!reportState.calendarRange.from || !reportState.calendarRange.to) return;
    const period = { ...reportState.calendarRange };
    if (period.from === period.to) {
      return showDay(period.from);
    }
    const rangeOpenButton = reportState.$("reportRangeOpen");
    if (rangeOpenButton) rangeOpenButton.disabled = true;
    try {
      const allReports = await reportActions.fetchReports("", period);
      reportState.reports = allReports;
      reportState.viewedPeriod = period;
      reportState.selectedDate = "";
      reportState.selectedReport = reportState.reports[0]?.id || "";
      reportState.reportSearchTerm = "";
      reportState.visibleRubrosStart = 0;
      reportState.showingDetailedReport = false;
      reportState.detailedPendingOnly = false;
      reportActions.renderDay();
    } catch (error) {
      reportActions.showError(error);
    }
  }

async function showDay(date) {
  reportState.viewedPeriod = null;
  reportState.calendarRange = { from: date, to: date };
  reportState.hoverDate = "";
  reportState.selectedDate = date;
  reportState.reportSearchTerm = "";
   reportState.visibleRubrosStart = 0;

  document.querySelectorAll(
    "#annualReport .report-days button"
  ).forEach(button => {
    button.classList.toggle(
      "selected-date",
      button.dataset.date === reportState.selectedDate
    );
  });

  try {
    reportState.reports = await reportActions.fetchReports(date);
    reportState.selectedReport = reportState.reports[0]?.id || "";
    reportState.showingDetailedReport = false;
    reportState.detailedPendingOnly = false;
    reportActions.renderDay();
  } catch (error) {
    reportActions.showError(error);
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
return { showCalendar, renderCalendar, paintCalendarRange, showRange, showDay, shiftReportDate };
}
