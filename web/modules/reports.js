
(() => {
  const $ = id => document.getElementById(id);

  const months = [
    "Enero", "Febrero", "Marzo", "Abril",
    "Mayo", "Junio", "Julio", "Agosto",
    "Septiembre", "Octubre", "Noviembre", "Diciembre"
  ];

  const pageParams = new URLSearchParams(window.location.search);
  const demoMode = pageParams.get("demoReports") === "1";
  let dateToOpenOnLoad = demoMode ? pageParams.get("demoDate") || "" : "";
  let year = demoMode ? 2024 : new Date().getFullYear();
  let selectedDate = "";
  let reports = [];
  let selectedReport = "";

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

function sessionCode() {
  return String(
    localStorage.getItem("voip vc.dashboardSessionCode") ||
    ""
  ).trim().toUpperCase();
}

function dashboardToken() {
  const code = sessionCode();

  if (!code) return "";

  return String(
    localStorage.getItem(
      `voip vc.dashboardToken.${code}`
    ) || ""
  ).trim();
}
  function endpoint(path) {
  const base = String(
    window.VOIP_VC_API_BASE ||
    new URLSearchParams(window.location.search).get("apiBase") ||
    window.location.origin
  ).trim().replace(/\/+$/, "");

  return new URL(
    `/api/session/${encodeURIComponent(sessionCode())}${path}`,
    base
  ).href;
}

  async function fetchReports(date = "") {
    if (demoMode) {
      if (!Array.isArray(window.VOIP_VC_DEMO_REPORTS)) {
        throw Error("No se pudieron cargar los datos demo del calendario.");
      }

      return window.VOIP_VC_DEMO_REPORTS.filter(
        report => !date || report.date === date
      );
    }

    if (!sessionCode()) {
      throw Error("Inicia una sesión para consultar reportes.");
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
    $("annualReport").innerHTML = `
      <p class="report-error">${esc(error.message || error)}</p>
      <button id="retryReports">Reintentar</button>
    `;

    $("retryReports").onclick = showCalendar;
  }

 async function showCalendar() {
  try {
    reports = await fetchReports();

    selectedReport = "";

    renderCalendar();

    if (dateToOpenOnLoad) {
      const date = dateToOpenOnLoad;
      dateToOpenOnLoad = "";
      if (reports.some(report => report.date === date)) {
        await showDay(date);
      }
    }
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

    $("annualReport").innerHTML = `
      <div class="report-heading">
        <h2>CALENDARIO ANUAL · REPORTES</h2>
        <div>
          <button id="toggleDemoReports" class="secondary" type="button">
            ${demoMode ? "SALIR DE DEMO" : "PROBAR DEMO"}
          </button>
          <button id="prevYear" class="secondary">‹</button>
          <strong>${year}</strong>
          <button id="nextYear" class="secondary">›</button>
        </div>
      </div>
      ${demoMode ? '<p class="muted">MODO DEMO · datos ficticios 2024–2026</p>' : ""}
      <div class="months-grid">${monthCards}</div>
    `;

    $("toggleDemoReports").onclick = () => {
      const url = new URL(window.location.href);
      if (demoMode) {
        url.searchParams.delete("demoReports");
      } else {
        url.searchParams.set("demoReports", "1");
      }
      window.location.assign(url.href);
    };

    $("prevYear").onclick = () => {
      year--;
      renderCalendar();
    };

    $("nextYear").onclick = () => {
      year++;
      renderCalendar();
    };

    $("annualReport")
      .querySelectorAll("[data-date]")
      .forEach(button => {
        button.onclick = () => showDay(button.dataset.date);
      });
  }

  async function showDay(date) {
  selectedDate = date;

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
    renderDay();
  } catch (error) {
    showError(error);
  }
}
  function renderDay() {
    $("annualReport").innerHTML = `
      <div class="report-heading">
        <div>
          <button id="backCalendar" class="secondary">
            ← CALENDARIO
          </button>
          <button id="toggleDemoReports" class="secondary" type="button">
            ${demoMode ? "SALIR DE DEMO" : "VER DATOS DEMO"}
          </button>
          <h2>REPORTE DEL ${esc(selectedDate)}</h2>
          ${demoMode ? '<p class="muted">MODO DEMO · datos ficticios</p>' : ""}
        </div>
      </div>

      <div class="report-search">
        <label>
          🔎 Buscar empresa o número
          <input
            id="reportSearch"
            placeholder="Empresa o teléfono"
          />
        </label>
        <span>
          El envío de información solo aparece si está
          registrado en el sistema.
        </span>
      </div>

      ${reports.length ? `
        <div class="report-rubros">
          ${reports.map((report, index) => `
            <button
              data-rubro="${esc(report.id)}"
              class="${report.id === selectedReport ? "chosen" : ""}"
            >
              ${index + 1}. ${esc(report.rubro)}
            </button>
          `).join("")}
        </div>
        <div id="reportDetails"></div>
      ` : `
        <p>No existen campañas registradas para esta fecha.</p>
      `}
    `;

    $("backCalendar").onclick = showCalendar;
    $("toggleDemoReports").onclick = () => {
      const url = new URL(window.location.href);
      if (demoMode) {
        url.searchParams.delete("demoReports");
      } else {
        url.searchParams.set("demoReports", "1");
      }
      url.searchParams.set("demoDate", selectedDate);
      window.location.assign(url.href);
    };

    $("reportSearch").oninput = renderDetails;

    $("annualReport")
      .querySelectorAll("[data-rubro]")
      .forEach(button => {
        button.onclick = () => {
          selectedReport = button.dataset.rubro;
          renderDay();
        };
      });

    if (reports.length) renderDetails();
  }

  function renderDetails() {
    const report = reports.find(
      item => item.id === selectedReport
    );

    if (!report) return;

    const term = (
      $("reportSearch")?.value || ""
    ).toLowerCase();

    const rows = report.rows.filter(contact =>
      `${contact.name} ${contact.phone}`
        .toLowerCase()
        .includes(term)
    );

    const metrics = [
      ["Fecha", report.date],
      ["Rubro", report.rubro],
      ["Números usados", report.numbers],
      ["Llamadas totales", report.totalCalls],
      ["Contestadas ≥35 s", report.answered],
      ["Pendientes", report.pending]
    ];

    const status = contact =>
      contact.answered ? "Contestada" :
      contact.inoperable ? "Inoperable" : "Pendiente";

    $("reportDetails").innerHTML = `
      <div class="report-metrics">
        ${metrics.map(([name, value]) => `
          <article>
            <span>${esc(name)}</span>
            <strong>${esc(value)}</strong>
          </article>
        `).join("")}
      </div>

      <div class="report-actions">
        <button id="reportPdf">⬇ DESCARGAR PDF</button>
        <button id="reportExcel" class="secondary">
          ⬇ DESCARGAR EXCEL
        </button>
        <button
          id="reportContinue"
          ${report.pending && !demoMode ? "" : "disabled"}
        >
          ${demoMode ? "☎ DEMO · llamadas desactivadas" : "☎ CONTINUAR LLAMADAS"}
        </button>
      </div>

      <div class="report-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Teléfono</th>
              <th>Estado</th>
              <th>Duración</th>
              <th>ENVIÓ INF.</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(contact => `
              <tr>
                <td>${esc(contact.name)}</td>
                <td>${esc(contact.phone)}</td>
                <td>${status(contact)}</td>
                <td>${esc(contact.durationSeconds)} s</td>
                <td>Sin registro</td>
              </tr>
            `).join("") || `
              <tr>
                <td colspan="5">Sin resultados</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    `;

    $("reportPdf").onclick = () => {
      const JsPDF = window.jspdf?.jsPDF;

      if (!JsPDF) {
        alert("Librería PDF no disponible");
        return;
      }

      const pdf = new JsPDF();
      pdf.setFontSize(15);
      pdf.text("Reporte diario - " + report.date, 12, 16);
      pdf.setFontSize(10);

      pdf.text(
        `Rubro: ${report.rubro} | Total: ${report.totalCalls}`,
        12, 25
      );

      let y = 35;

      for (const contact of rows) {
        if (y > 275) {
          pdf.addPage();
          y = 18;
        }

        pdf.text(
          `${String(contact.name).slice(0, 34)} | ` +
          `${contact.phone} | ${status(contact)}`,
          12, y
        );
        y += 7;
      }

      pdf.save(`reporte-${report.date}.pdf`);
    };

    $("reportExcel").onclick = () => {
      if (!window.XLSX) {
        alert("Librería Excel no disponible");
        return;
      }

      const data = rows.map(contact => ({
        Fecha: report.date,
        Rubro: report.rubro,
        Empresa: contact.name,
        Telefono: contact.phone,
        Estado: status(contact),
        Duracion_segundos: contact.durationSeconds,
        Envio_informacion: "Sin registro"
      }));

      const sheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();

      XLSX.utils.book_append_sheet(
        workbook, sheet, "Reporte"
      );

      XLSX.writeFile(
        workbook,
        `reporte-${report.date}.xlsx`
      );
    };

    $("reportContinue").onclick = async () => {
      if (!confirm(
        `¿Continuar las llamadas pendientes del rubro ${report.rubro}?`
      )) return;

      try {
        const response = await fetch(
          endpoint(
            `/reports/${encodeURIComponent(report.id)}/continue`
          ),
        
{
  method: "POST",
  headers: {
    "X-Dashboard-Token": dashboardToken()
  }
}
        );

        const data = await response.json();

        if (!response.ok) {
          throw Error(data.error || "No se pudo iniciar");
        }

        alert(
          `${data.queued} contactos pendientes agregados a la campaña.`
        );

        $("reportBackBtn").click();
      } catch (error) {
        alert(error.message);
      }
    };
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("reportNavBtn")?.addEventListener("click", () => {
      $("callsContent").hidden = true;
      $("annualReport").hidden = false;
      $("reportNavBtn").hidden = true;
      $("reportBackBtn").hidden = false;
      showCalendar();
    });

    $("reportBackBtn")?.addEventListener("click", () => {
      $("callsContent").hidden = false;
      $("annualReport").hidden = true;
      $("reportNavBtn").hidden = false;
      $("reportBackBtn").hidden = true;
    });
  });
})();