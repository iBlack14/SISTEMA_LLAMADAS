import { validateReportPeriod, reportPeriodLabel } from "./report-period.js?v=20261106-range";

(() => {
  const root = document.getElementById("calendarUi");
  const calls = document.getElementById("callsContent");
  const reports = document.getElementById("annualReport");
  const openButton = document.getElementById("reportNavBtn");
  const closeButton = document.getElementById("reportBackBtn");
  if (!root || !calls || !reports || !openButton || !closeButton) return;
  const today = () => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  let period = { from: today(), to: today() };
  let preset = "today";
  let calendarYear = Number(period.from.slice(0, 4));
  let rangeStart = "";
  let calendarCounts = new Map();
  const months = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const emitFilter = () => document.dispatchEvent(new CustomEvent("reports:filter", { detail: { ...period } }));
  root.innerHTML = `
    <div class="reports-title">
      <h2>Reportes</h2>
      <p>Elige un período para consultar las llamadas y descargar sus resultados.</p>
    </div>
    <div class="report-period-presets" aria-label="Períodos rápidos">
      <button type="button" class="secondary" data-period="today">Hoy</button>
      <button type="button" class="secondary" data-period="week">Últimos 7 días</button>
      <button type="button" class="secondary" data-period="month">Este mes</button>
      <button type="button" class="secondary" data-period="all">Todo el historial</button>
    </div>
    <form id="reportPeriodForm" class="report-period-form" novalidate>
      <div><label for="reportDateFrom">Desde</label><input id="reportDateFrom" name="from" type="date" aria-describedby="reportPeriodError" /></div>
      <div><label for="reportDateTo">Hasta</label><input id="reportDateTo" name="to" type="date" aria-describedby="reportPeriodError" /></div>
      <button type="submit" class="report-period-apply">Aplicar período</button>
    </form>
    <p id="reportPeriodError" class="report-period-error" role="alert"></p>
    <div class="report-period-summary"><span id="reportPeriodLabel" aria-live="polite"></span><small>Fechas y horas de Lima</small></div>
    <section class="report-calendar" aria-label="Calendario anual">
      <div class="report-heading">
        <h3>Calendario anual</h3>
        <div class="calendar-year-nav">
          <button id="calendarPrevYear" class="secondary" type="button" aria-label="Año anterior">‹</button>
          <strong id="calendarYearLabel"></strong>
          <button id="calendarNextYear" class="secondary" type="button" aria-label="Año siguiente">›</button>
        </div>
      </div>
      <p id="calendarRangeHint" class="muted" aria-live="polite">Selecciona el día inicial y después el día final.</p>
      <div id="calendarMonths" class="months-grid"></div>
    </section>
  `;
  const fromInput = root.querySelector("#reportDateFrom");
  const toInput = root.querySelector("#reportDateTo");
  const error = root.querySelector("#reportPeriodError");
  function renderCalendar(focusDate = "") {
    root.querySelector("#calendarYearLabel").textContent = calendarYear;
    root.querySelector("#calendarRangeHint").textContent = rangeStart
      ? "Inicio seleccionado. Ahora elige el día final; puede ser del mismo mes o de otro año."
      : "Selecciona el día inicial y después el día final. Para un solo día, selecciónalo dos veces.";
    const from = fromInput.value;
    const to = toInput.value;
    const valid = !validateReportPeriod(from, to);
    const format = date => new Intl.DateTimeFormat("es-PE", {dateStyle:"long",timeZone:"UTC"})
      .format(new Date(date + "T00:00:00Z"));
    root.querySelector("#calendarMonths").innerHTML = months.map((name, month) => {
      const first = new Date(calendarYear, month, 1).getDay();
      const count = new Date(calendarYear, month + 1, 0).getDate();
      const blanks = Array.from({length:first}, () => '<i aria-hidden="true"></i>').join("");
      const days = Array.from({length:count}, (_, index) => {
        const date = calendarYear + "-" + String(month + 1).padStart(2,"0") + "-" + String(index + 1).padStart(2,"0");
        const start = date === from;
        const end = date === to;
        const inRange = valid && from && to && date >= from && date <= to;
        const attempts = calendarCounts.get(date) || 0;
        const classes = "calendar-day" + (start || end ? " selected-date" : "") +
          (inRange ? " in-range" : "") + (start ? " range-start" : "") + (end ? " range-end" : "") +
          (attempts ? " has-report" : "");
        return '<button type="button" class="' + classes + '" data-date="' + date +
          '" aria-pressed="' + Boolean(start || end || inRange) + '" aria-label="' + format(date) +
          (start ? ", inicio" : "") + (end ? ", fin" : "") + ", " + attempts + ' intentos">' +
          (index + 1) + (attempts ? '<span class="calendar-record-dot" aria-hidden="true">•</span>' : "") + '</button>';
      }).join("");
      return '<article class="report-month"><h3>' + name + '</h3><div class="report-days">' +
        ["D","L","M","M","J","V","S"].map(day => "<b>" + day + "</b>").join("") +
        blanks + days + '</div></article>';
    }).join("");
    root.querySelectorAll("[data-date]").forEach(button => {
      button.onclick = () => {
        const date = button.dataset.date;
        error.textContent = "";
        if (!rangeStart) {
          rangeStart = date;
          fromInput.value = date;
          toInput.value = "";
          root.querySelector("#reportPeriodLabel").textContent = "Selecciona el día final para aplicar el rango.";
          renderCalendar(date);
        } else {
          period = {from: rangeStart < date ? rangeStart : date, to: rangeStart < date ? date : rangeStart};
          rangeStart = "";
          preset = "";
          sync();
          emitFilter();
          root.querySelector('[data-date="' + date + '"]')?.focus({preventScroll:true});
        }
      };
    });
    if (focusDate) root.querySelector('[data-date="' + focusDate + '"]')?.focus({preventScroll:true});
  }
  root.querySelector("#calendarPrevYear").onclick = () => { calendarYear--; renderCalendar(); };
  root.querySelector("#calendarNextYear").onclick = () => { calendarYear++; renderCalendar(); };
  document.addEventListener("reports:data", event => {
    calendarCounts = new Map();
    for (const row of event.detail?.rows || []) {
      if (row.reportDate) calendarCounts.set(row.reportDate, (calendarCounts.get(row.reportDate) || 0) + 1);
    }
    renderCalendar();
  });
  function sync() {
    fromInput.value = period.from;
    toInput.value = period.to;
    root.querySelector("#reportPeriodLabel").textContent = reportPeriodLabel(period);
    root.querySelectorAll("[data-period]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.period === preset)));
    error.textContent = "";
    fromInput.setAttribute("aria-invalid", "false");
    toInput.setAttribute("aria-invalid", "false");
    renderCalendar();
  }
  root.querySelector("#reportPeriodForm").onsubmit = event => {
    event.preventDefault();
    const draft = { from: fromInput.value, to: toInput.value };
    const message = validateReportPeriod(draft.from, draft.to);
    error.textContent = message;
    fromInput.setAttribute("aria-invalid", String(Boolean(message)));
    toInput.setAttribute("aria-invalid", String(Boolean(message)));
    if (message) return;
    period = draft;
    rangeStart = "";
    if (period.from) calendarYear = Number(period.from.slice(0, 4));
    preset = "";
    sync(); emitFilter();
  };
  root.querySelector("#reportPeriodForm").oninput = () => {
    rangeStart = "";
    root.querySelector("#reportPeriodLabel").textContent = "Cambios sin aplicar. Pulsa Aplicar período.";
    renderCalendar();
  };
  root.querySelectorAll("[data-period]").forEach(button => {
    button.onclick = () => {
      preset = button.dataset.period;
      const end = today();
      let start = end;
      if (preset === "week") {
        const date = new Date(end + "T00:00:00Z");
        date.setUTCDate(date.getUTCDate() - 6);
        start = date.toISOString().slice(0, 10);
      } else if (preset === "month") start = end.slice(0, 7) + "-01";
      period = preset === "all" ? { from: "", to: "" } : { from: start, to: end };
      rangeStart = "";
      if (period.from) calendarYear = Number(period.from.slice(0, 4));
      sync(); emitFilter();
    };
  });
  sync();
  openButton.setAttribute("aria-expanded", "false");
  openButton.setAttribute("aria-controls", "annualReport");
  openButton.onclick = () => {
    calls.hidden = true; reports.hidden = false;
    openButton.setAttribute("aria-expanded", "true");
    rangeStart = "";
    sync(); emitFilter();
    document.dispatchEvent(new CustomEvent("reports:open"));
    reports.scrollIntoView({ block: "start" });
  };
  closeButton.onclick = () => {
    reports.hidden = true; calls.hidden = false;
    openButton.setAttribute("aria-expanded", "false");
    openButton.focus();
  };
  if (window.location.hash === "#reports") openButton.click();
})();
