import { apiFetch as fetch, currentUser } from "../auth/auth-session.js";
import { buildDetailedReport } from "./detailed-report.js?v=20261119-global-detail-fix1";
import { isAnsweredAttempt, isVoicemailAttempt, isInoperableAttempt, attemptResultLabel } from "../../../shared/reports/report-metrics.js";
import { loadBrowserLibrary } from "../../shared/utils/browser-libraries.js";
import { ALL_REPORTS_ID } from "./report-period.js?v=20261119-all-reports-default1";

// report-detail-view: comparte el estado del módulo de reportes sin crear conexiones.
export function createReportDetailView(reportState, reportActions) {
function renderDetails() {
    const selectedReport = reportState.reports.find(
      item => item.id === reportState.selectedReport
    );
    const allMode = reportState.selectedReport === ALL_REPORTS_ID || !selectedReport;

    if (!reportState.reports.length) return;

    const report = selectedReport || {
      id: ALL_REPORTS_ID,
      date: reportState.selectedDate || reportState.viewedPeriod?.from || reportState.reports[0]?.date || "",
      rubro: "TODOS LOS RUBROS",
      owner: "",
      numbers: reportState.reports.reduce((sum, item) => sum + Number(item.numbers || 0), 0),
      totalCalls: reportState.reports.reduce((sum, item) => sum + Number(item.totalCalls || 0), 0),
      answered: reportState.reports.reduce((sum, item) => sum + Number(item.answered || 0), 0),
      voicemail: reportState.reports.reduce((sum, item) => sum + Number(item.voicemail || 0), 0),
      inoperable: reportState.reports.reduce((sum, item) => sum + Number(item.inoperable ?? (item.rows || []).filter(isInoperableAttempt).length), 0),
      pending: reportState.reports.reduce((sum, item) => sum + Number(item.pending || 0), 0),
      rows: reportState.reports.flatMap(item => (item.rows || []).map(contact => ({
        ...contact,
        workerName: item.owner ? `${contact.workerName || "SIN EQUIPO"} · ${item.owner}` : contact.workerName
      }))),
      calls: reportState.reports.flatMap(item => (item.calls || []).map(call => ({
        ...call,
        workerName: item.owner ? `${call.workerName || "SIN EQUIPO"} · ${item.owner}` : call.workerName
      })))
    };

    if (reportState.selectionReportId !== report.id) {
      reportState.selectionReportId = report.id;
      reportState.selectedContactIds.clear();
    }
    const canSelect = contact => !contact.doNotCall && !contact.manualBlocked && !isInoperableAttempt(contact);
    const eligibleIds = new Set(report.rows.filter(canSelect).map(contact => String(contact.id)));
    for (const id of reportState.selectedContactIds) if (!eligibleIds.has(id)) reportState.selectedContactIds.delete(id);

    const normalizeSearchText = value => String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    const term = normalizeSearchText(reportState.reportSearchTerm).trim();
    const allTableRows = reportState.reports.flatMap(reportItem =>
        reportItem.rows.map(contact => ({ report: reportItem, contact }))
      );
    const metricPredicate = filter => {
      if (filter === "LLAMADAS TOTALES") return contact =>
        isAnsweredAttempt(contact) || isVoicemailAttempt(contact) || isInoperableAttempt(contact) || Boolean(contact.lastCallAt);
      if (filter === "CONTESTADAS") return isAnsweredAttempt;
      if (filter === "BUZONES") return isVoicemailAttempt;
      if (filter === "INOPERABLES") return isInoperableAttempt;
      if (filter === "PENDIENTES") return contact =>
        !isAnsweredAttempt(contact) && !isVoicemailAttempt(contact) && !isInoperableAttempt(contact);
      return null;
    };
    const activeMetricFilter = reportState.metricFilter || "";
    const activePredicate = metricPredicate(activeMetricFilter);
    const baseTableRows = (allMode || term
      ? allTableRows.filter(({ report: reportItem, contact }) =>
        normalizeSearchText(
          `${reportItem.rubro} ${contact.name} ${contact.phone} ${contact.id || ""} ` +
          `${reportItem.owner || ""} ${contact.list || ""} ${contact.workerName || ""} ${contact.workerId || ""} ` +
          `${contact.technicalResult || ""}`
        ).includes(term)
      )
      : report.rows.map(contact => ({ report, contact }))
    );
    const tableRows = activePredicate
      ? baseTableRows.filter(({ contact }) => activePredicate(contact))
      : baseTableRows;
    // El listado se muestra de 20 en 20; el PDF y la descarga total siguen usando todo.
    const rowsPerPage = reportState.tableRowsPerPage || 20;
    const pageKey = [
      reportState.selectedReport,
      reportState.reportSearchTerm,
      activeMetricFilter,
      reportState.selectedDetailedTeam,
      reportState.detailedPendingOnly
    ].join("|");
    if (reportState.tablePageKey !== pageKey) {
      reportState.tablePageKey = pageKey;
      reportState.tablePage = 0;
    }
    const totalPages = Math.max(1, Math.ceil(tableRows.length / rowsPerPage));
    reportState.tablePage = Math.min(Math.max(0, reportState.tablePage || 0), totalPages - 1);
    const pageRows = tableRows.slice(
      reportState.tablePage * rowsPerPage,
      (reportState.tablePage + 1) * rowsPerPage
    );

    const equipmentCount = new Set(allMode
      ? reportState.reports.flatMap(item => (item.rows || []).map(contact =>
        String(contact.workerId || contact.workerName || "").trim()
      ))
      : report.rows.map(contact => String(contact.workerId || contact.workerName || "").trim())
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
    const reportDateLabel = allMode && reportState.viewedPeriod
      ? `${formatReportDate(reportState.viewedPeriod.from)} — ${formatReportDate(reportState.viewedPeriod.to)}`
      : formatReportDate(reportState.selectedDate || report.date);
    const aggregateOwner = reportState.reportScope === "all"
      ? "Todos los usuarios"
      : reportState.reportScope.startsWith("user:")
        ? reportState.reportUsers.find(user => `user:${user.id}` === reportState.reportScope)?.username || "Usuario"
        : currentUser?.username || "Mis reportes";
    const contextOwner = allMode ? aggregateOwner : report.owner || aggregateOwner;
    const metrics = [
      ["LLAMADAS TOTALES", report.totalCalls, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16.5v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.12 3.8 2 2 0 0 1 3.1 1.6h3a2 2 0 0 1 2 1.72c.12.9.34 1.78.65 2.62a2 2 0 0 1-.45 2.11L7 9.35a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.11-.45c.84.31 1.72.53 2.62.65A2 2 0 0 1 21 16.5Z"/></svg>'],
      ["CONTESTADAS", report.answered, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="9"/></svg>'],
      ["BUZONES", report.voicemail ?? report.rows.filter(isVoicemailAttempt).length, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 13h4l2 3h6l2-3h4"/></svg>'],
      ["INOPERABLES", report.inoperable ?? report.rows.filter(isInoperableAttempt).length, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/></svg>'],
      ["PENDIENTES", report.pending, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'],
      ["EQUIPOS USADOS", equipmentCount || "—", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 5h6m-5 14h4"/></svg>'],
      ["NÚMEROS USADOS", report.numbers, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 6 21M18 3l-2 18M3 9h18M2 15h18"/></svg>']
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

    const makeDetailedRows = () => buildDetailedReport(report, reportState.selectedDetailedTeam, reportState.detailedPendingOnly);

    const renderDetailedReport = () => {
      const detailed = makeDetailedRows();
      // El detalle también se muestra de 20 en 20.
      const detailedPageKey = [
        report.id,
        reportState.selectedDetailedTeam,
        reportState.detailedPendingOnly
      ].join("|");
      if (reportState.detailedPageKey !== detailedPageKey) {
        reportState.detailedPageKey = detailedPageKey;
        reportState.detailedPage = 0;
      }
      const detailedPerPage = reportState.tableRowsPerPage || 20;
      const detailedTotalPages = Math.max(1, Math.ceil(detailed.rows.length / detailedPerPage));
      reportState.detailedPage = Math.min(
        Math.max(0, reportState.detailedPage || 0),
        detailedTotalPages - 1
      );
      const detailedPageRows = detailed.rows.slice(
        reportState.detailedPage * detailedPerPage,
        (reportState.detailedPage + 1) * detailedPerPage
      );
      const teamNames = Array.from(new Set([
        ...(report.rows || []).map(contact => contact.workerName),
        ...(report.calls || []).map(call => call.workerName)
      ].map(name => String(name || "").trim()).filter(Boolean)))
        .sort((left, right) => left.localeCompare(right, "es", {
          numeric: true
        }));
      const globalDetail = !reportState.selectedDetailedTeam;
      const teamIndex = Math.max(0, teamNames.indexOf(reportState.selectedDetailedTeam));
      const teamLabel = globalDetail ? "TODOS LOS EQUIPOS" : /^EQUIPO\s+\d+$/i.test(reportState.selectedDetailedTeam)
        ? reportState.selectedDetailedTeam.toUpperCase()
        : reportState.selectedDetailedTeam === "SIN EQUIPO"
          ? reportState.selectedDetailedTeam
          : `EQUIPO ${teamIndex + 1}`;
      const modelName = globalDetail ? "Resumen global" : report.teamModels?.[reportState.selectedDetailedTeam] ||
        (/^EQUIPO\s+\d+$/i.test(reportState.selectedDetailedTeam)
          ? "MODELO NO REGISTRADO"
          : reportState.selectedDetailedTeam);
      const equipmentHeading = globalDetail ? "REPORTE DETALLADO GLOBAL" : reportState.selectedDetailedTeam === "SIN EQUIPO" ? "Equipo no registrado" :
        teamLabel === modelName ? teamLabel : `${teamLabel}: ${modelName}`;
      const teamCalls = (report.calls || []).filter(call =>
        globalDetail || String(call.workerName || "").trim() === reportState.selectedDetailedTeam
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
      const teamShift = report.teamShifts?.[reportState.selectedDetailedTeam] ||
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

      reportState.$("reportDetails").innerHTML = `
        <section class="report-content-panel report-detailed-panel"
          aria-label="Reporte detallado">
          <div class="report-detailed-summary">
            <div class="report-detailed-equipment">
              <h3>${reportState.esc(equipmentHeading)}</h3>
              <span>${reportState.esc(teamShift)} | ${reportState.esc(reportState.formatDetailedDate(report.date))} | ${
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
                ${detailedPageRows.map((row, index) => `
                  <tr>
                    ${globalDetail ? `
                      <td>${reportState.esc(row.team)}</td>
                      <td>${row.designated}</td>
                    ` : index === 0 ? `
                      <td rowspan="${detailedPageRows.length}">
                        ${reportState.esc(row.team)}
                      </td>
                      <td rowspan="${detailedPageRows.length}">
                        ${row.designated}
                      </td>
                    ` : ""}
                    <td class="report-detailed-hour-cell">${reportState.esc(row.hour)}</td>
                    <td>${row.calls}</td>
                    <td>${row.answered}</td>
                    <td>${row.noAnswer}</td>
                    <td>${row.voicemail}</td>
                    <td>${row.inoperable}</td>
                    <td>${row.pending}</td>
                  </tr>
                `).join("") || `
                  <tr><td colspan="9">${
                    reportState.detailedPendingOnly
                      ? "No hay contactos pendientes."
                      : "No hay llamadas registradas."
                  }</td></tr>
                `}
              </tbody>
            </table>
          </div>
          <nav class="report-pagination" aria-label="Paginación del detalle">
            <button id="detailedPrevPage" class="secondary" type="button" ${reportState.detailedPage === 0 ? "disabled" : ""}>← ANTERIOR</button>
            <span id="detailedPageInfo">Página ${reportState.detailedPage + 1} de ${detailedTotalPages} · ${detailed.rows.length} registros</span>
            <button id="detailedNextPage" class="secondary" type="button" ${reportState.detailedPage >= detailedTotalPages - 1 ? "disabled" : ""}>SIGUIENTE →</button>
          </nav>
          <div class="report-footer report-detailed-footer">
            <div class="report-actions">
              <button id="detailedBack" class="secondary" type="button">
                ← VOLVER AL REPORTE
              </button>
              <button id="detailedPdf" type="button">
                ⬇ DESCARGAR REPORTE
              </button>
              <button id="detailedPending" class="secondary" type="button"
                aria-pressed="${reportState.detailedPendingOnly}">
                ${reportState.detailedPendingOnly ? "VER TODO" : "PENDIENTE"}
              </button>
            </div>
            ${allMode ? "" : `
              <div class="report-continue report-detailed-campaign-actions">
                <button id="detailedStop" class="secondary" type="button">DETENER</button>
                <button id="detailedCallPending" type="button" ${!report.pending ? "disabled" : ""}>
                  LLAMAR PENDIENTES
                </button>
              </div>
            `}
          </div>
        </section>
      `;

      reportState.$("detailedPrevPage")?.addEventListener("click", () => {
        reportState.detailedPage = Math.max(0, reportState.detailedPage - 1);
        renderDetailedReport();
      });
      reportState.$("detailedNextPage")?.addEventListener("click", () => {
        reportState.detailedPage = Math.min(detailedTotalPages - 1, reportState.detailedPage + 1);
        renderDetailedReport();
      });

      reportState.$("detailedBack").onclick = () => {
        reportState.showingDetailedReport = false;
        reportState.detailedPendingOnly = false;
        reportActions.renderDay();
      };
      reportState.$("detailedPending").onclick = () => {
        reportState.detailedPendingOnly = !reportState.detailedPendingOnly;
        renderDetailedReport();
      };
      const detailedStopButton = reportState.$("detailedStop");
      if (detailedStopButton) detailedStopButton.onclick = async () => {
        if (!confirm("¿Detener la campaña y las llamadas activas?")) return;
        const button = detailedStopButton;
        button.disabled = true;
        try {
          const response = await fetch(reportActions.endpoint("/campaign/stop"), {
            method: "POST",
            headers: {
              "X-Dashboard-Token": reportActions.dashboardToken()
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
      const detailedCallPendingButton = reportState.$("detailedCallPending");
      if (detailedCallPendingButton) detailedCallPendingButton.onclick = () => {
        reportState.showingDetailedReport = false;
        reportState.detailedPendingOnly = false;
        reportActions.renderDay();
      };
      reportState.$("detailedPdf").onclick = async () => {
        const button = reportState.$("detailedPdf");
        button.disabled = true;
        try {
          const JsPDF = await loadBrowserLibrary("jspdf");
          const logoResponse = await fetch("/shared/assets/images/logo-vc-color.png");
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
            pdf.setTextColor(...reportState.reportPdfTableTheme.text);
            pdf.text("Lima - Peru", pageWidth - margin, 16, {
              align: "right"
            });
            pdf.setDrawColor(...reportState.reportPdfTableTheme.border);
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
            pdf.setTextColor(...reportState.reportPdfTableTheme.text);
            pdf.text(
              pdf.splitTextToSize(
                `${teamShift} | ${reportState.formatDetailedDate(report.date)} | ${detailed.metrics.calls} llamadas`,
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
            pdf.setDrawColor(...reportState.reportPdfTableTheme.header);
            pdf.setFillColor(...reportState.reportPdfTableTheme.header);
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
            pdf.setDrawColor(...reportState.reportPdfTableTheme.border);
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

            const mergedFill = reportState.reportPdfTableTheme.rows[pageStart % 2];
            let x = margin;
            for (let index = 0; index < 2; index++) {
              pdf.setFillColor(...mergedFill);
              pdf.rect(x, y, columnWidths[index], mergedHeight, "F");
              pdf.setFont("helvetica", "normal");
              pdf.setFontSize(7.5);
              pdf.setTextColor(...reportState.reportPdfTableTheme.text);
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
                ...reportState.reportPdfTableTheme.rows[index % reportState.reportPdfTableTheme.rows.length]
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
                pdf.setTextColor(...reportState.reportPdfTableTheme.text);
                pdf.text(
                  lines[columnIndex],
                  x + columnWidths[columnIndex] / 2,
                  y + 4.7,
                  { align: "center" }
                );
                x += columnWidths[columnIndex];
              }
              pdf.setDrawColor(...reportState.reportPdfTableTheme.border);
              pdf.line(
                margin + mergedColumnsWidth,
                y + rowHeight,
                margin + tableWidth,
                y + rowHeight
              );
              y += rowHeight;
            }
            pdf.setDrawColor(...reportState.reportPdfTableTheme.border);
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
          const suffix = reportState.detailedPendingOnly ? "-pendientes" : "";
          const rubroFileName = normalizeSearchText(report.rubro)
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          const teamFileName = normalizeSearchText(reportState.selectedDetailedTeam)
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

    if (reportState.showingDetailedReport) {
      renderDetailedReport();
      return;
    }

    reportState.$("reportDetails").innerHTML = `
      <section class="report-content-panel" aria-label="Detalle del reporte">
        <div class="report-context" aria-label="Contexto del reporte">
          <div><span>Rubro</span><strong title="${reportState.esc(report.rubro)}">${reportState.esc(report.rubro)}</strong></div>
          <div><span>Usuario</span><strong title="${reportState.esc(contextOwner)}">${reportState.esc(contextOwner)}</strong></div>
          <div><span>Fecha del reporte</span><strong>${reportState.esc(reportDateLabel)}</strong></div>
        </div>
        <section class="report-summary" aria-label="Resumen del reporte">
          <div class="report-metrics">
            ${metrics.map(([name, value, icon]) => {
              const isActive = activeMetricFilter === name || (!activeMetricFilter && name === "NÚMEROS USADOS");
              return `
              <button type="button" class="report-metric${isActive ? " is-active" : ""}" data-metric="${reportState.esc(name)}" aria-pressed="${isActive ? "true" : "false"}">
                <span class="report-metric-icon" aria-hidden="true">${icon}</span>
                <span class="report-metric-label">${reportState.esc(name)}</span>
                <strong class="report-metric-value">${reportState.esc(value)}</strong>
              </button>`;
            }).join("")}
          </div>
        </section>

          <section class="report-detail-card" aria-label="Llamadas del reporte">
          ${allMode ? `
            <div class="report-detail-heading report-consolidated-heading">
              <div>
                <h3>Vista Consolidada</h3>
                <p>Resumen de todos los rubros. Elige uno para ver su detalle y gestionar llamadas.</p>
              </div>
              <div class="report-consolidated-actions">
                <button id="reportDetailedTop" class="secondary" type="button"><span aria-hidden="true">▤</span> Detallado</button>
                <button id="reportTotalPdfTop" type="button"><span aria-hidden="true">↓</span> Descargar total</button>
              </div>
            </div>
          ` : ""}
          ${(term || activeMetricFilter) ? `
            <div class="report-detail-heading">
              <h3>${activeMetricFilter ? `${reportState.esc(activeMetricFilter)} (${tableRows.length})` : `RESULTADOS DE BÚSQUEDA (${tableRows.length})`}</h3>
              ${activeMetricFilter ? `<button id="clearMetricFilter" class="secondary" type="button">Ver todos</button>` : ""}
            </div>
          ` : ""}
          <div id="report-detail-table" class="report-table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="report-select-cell"><input id="reportSelectAll" type="checkbox" aria-label="Seleccionar todos los números disponibles visibles" /></th>
                  <th>N.º</th>
                  ${allMode ? "<th>USUARIO</th>" : ""}
                  <th>BASE (RUBRO)</th>
                  <th class="report-company-cell">EMPRESA</th>
                  <th>TELÉFONO</th>
                  <th>EQUIPO</th>
                  <th>HORA LIMA</th>
                  <th>INT.</th>
                  <th>DURACIÓN</th>
                  <th>RESULTADO</th>
                  <th class="report-row-action-cell">${allMode ? "VER" : "LLAMAR"}</th>
                </tr>
              </thead>
              <tbody>
                ${pageRows.map(({ report: rowReport, contact }, index) => `
                  <tr>
                    <td class="report-select-cell"><input type="checkbox" data-select-contact="${reportState.esc(String(contact.id))}"
                      aria-label="Seleccionar ${reportState.esc(contact.name)} ${reportState.esc(contact.phone)}"
                      ${!allMode && rowReport.id === report.id && canSelect(contact) ? "" : `disabled title="${allMode ? "Elige un rubro específico para seleccionar contactos" : "Número bloqueado, inoperable o de otro rubro"}"`}
                      ${rowReport.id === report.id && reportState.selectedContactIds.has(String(contact.id)) ? "checked" : ""} /></td>
                    <td>${reportState.tablePage * rowsPerPage + index + 1}</td>
                    ${allMode ? `<td>${reportState.esc(rowReport.owner || "—")}</td>` : ""}
                    <td>${reportState.esc(contact.list || rowReport.rubro)}</td>
                    <td class="report-company-cell">${reportState.esc(contact.name)}</td>
                    <td>${reportState.esc(contact.phone)}</td>
                    <td>${reportState.esc(contact.workerName || "—")}</td>
                    <td>${reportState.esc(limaDateTime(contact.lastCallAt))}</td>
                    <td>${reportState.esc(contact.attemptNumber || "—")}</td>
                    <td>${reportState.esc(formatDuration(contact.durationSeconds))}</td>
                    <td class="report-result ${statusClass(contact)}">
                      <span class="report-result-badge">${reportState.esc(status(contact))}</span>
                    </td>
                    <td class="report-row-action-cell">
                      ${allMode
                        ? `<button type="button" class="report-row-open" data-open-report="${reportState.esc(rowReport.id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>Ver rubro</button>`
                        : canSelect(contact)
                        ? `<button type="button" class="report-row-call" data-call-report-contact="${reportState.esc(String(contact.id))}" data-call-report-id="${reportState.esc(rowReport.id)}" aria-label="Llamar a ${reportState.esc(contact.name)} ${reportState.esc(contact.phone)}">☎ Llamar</button>`
                        : `<span class="report-no-call">${contact.doNotCall || ["numero_inexistente", "numero_incorrecto"].includes(contact.technicalResult) ? "NO VOLVER A LLAMAR" : contact.manualBlocked ? "BLOQUEADO" : "INOPERABLE"}</span>`}
                    </td>
                  </tr>
                `).join("") || `
                  <tr>
                    <td colspan="${allMode ? 12 : 11}">Sin resultados</td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>
          <nav class="report-pagination" aria-label="Paginación de llamadas">
            <button id="reportPrevPage" class="secondary" type="button" ${reportState.tablePage === 0 ? "disabled" : ""}>← ANTERIOR</button>
            <span id="reportPageInfo">${tableRows.length ? `Mostrando ${reportState.tablePage * rowsPerPage + 1}–${reportState.tablePage * rowsPerPage + pageRows.length} de ${tableRows.length}` : "0 registros"} · Página ${reportState.tablePage + 1} de ${totalPages}</span>
            <button id="reportNextPage" class="secondary" type="button" ${reportState.tablePage >= totalPages - 1 ? "disabled" : ""}>SIGUIENTE →</button>
          </nav>
          <div class="report-footer">
            <div class="report-actions">
              ${allMode ? "" : '<button id="reportPdf" type="button">⬇ DESCARGAR REPORTE</button>'}
              ${allMode ? "" : '<button id="reportTotalPdf" class="secondary" type="button">⬇ DESCARGA TOTAL</button>'}
            </div>
            <div class="report-continue">
              <span id="reportSelectionCount" role="status">0 seleccionados</span>
              ${allMode ? "" : '<button id="reportDetailed" class="secondary" type="button">DETALLADO</button>'}
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

    reportState.$("reportDetails").querySelectorAll(".report-metric[data-metric]").forEach(card => {
      card.addEventListener("click", () => {
        const metric = card.dataset.metric || "";
        if (metric === "EQUIPOS USADOS") {
          reportState.showingDetailedReport = true;
          reportState.detailedPage = 0;
          renderDetailedReport();
          return;
        }
        reportState.metricFilter = metric === "NÚMEROS USADOS" || reportState.metricFilter === metric ? "" : metric;
        reportState.tablePage = 0;
        renderDetails();
        reportState.$("report-detail-table")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });
    reportState.$("clearMetricFilter")?.addEventListener("click", () => {
      reportState.metricFilter = "";
      reportState.tablePage = 0;
      renderDetails();
    });
    reportState.$("reportPrevPage")?.addEventListener("click", () => {
      reportState.tablePage = Math.max(0, reportState.tablePage - 1);
      reportActions.renderDetails();
    });
    reportState.$("reportNextPage")?.addEventListener("click", () => {
      reportState.tablePage = Math.min(totalPages - 1, reportState.tablePage + 1);
      reportActions.renderDetails();
    });

    let selectionSubmitting = false;
    const checkboxes = () => [...reportState.$("reportDetails").querySelectorAll("[data-select-contact]:not(:disabled)")];
    const updateSelection = () => {
      const visible = checkboxes();
      const checked = visible.filter(input => reportState.selectedContactIds.has(input.dataset.selectContact)).length;
      reportState.$("reportSelectAll").disabled = !visible.length;
      reportState.$("reportSelectAll").checked = visible.length > 0 && checked === visible.length;
      reportState.$("reportSelectAll").indeterminate = checked > 0 && checked < visible.length;
      reportState.$("reportSelectionCount").textContent = `${reportState.selectedContactIds.size} seleccionados`;
      reportState.$("reportContinue").disabled = selectionSubmitting || !reportState.selectedContactIds.size;
      reportState.$("reportDetails").querySelectorAll("[data-call-report-contact]").forEach(button => { button.disabled = selectionSubmitting; });
      reportState.$("reportContinue").textContent = reportState.selectedContactIds.size ? `LLAMAR SELECCIONADOS (${reportState.selectedContactIds.size})` : "LLAMAR SELECCIONADOS";
    };
    reportState.$("reportSelectAll").onchange = event => {
      for (const input of checkboxes()) {
        input.checked = event.currentTarget.checked;
        if (input.checked) reportState.selectedContactIds.add(input.dataset.selectContact);
        else reportState.selectedContactIds.delete(input.dataset.selectContact);
      }
      updateSelection();
    };
    for (const input of checkboxes()) input.onchange = () => {
      if (input.checked) reportState.selectedContactIds.add(input.dataset.selectContact);
      else reportState.selectedContactIds.delete(input.dataset.selectContact);
      updateSelection();
    };
    updateSelection();

    const exportReportsToPdf = async (reportsForExport, clickedButton) => {
      clickedButton.disabled = true;
      try {
        const JsPDF = await loadBrowserLibrary("jspdf");
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
            pdf.setDrawColor(...reportState.reportPdfTableTheme.header);
            pdf.setFillColor(...reportState.reportPdfTableTheme.header);
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
              pdf.setDrawColor(...reportState.reportPdfTableTheme.border);
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
                ...reportState.reportPdfTableTheme.rows[
                  Math.max(groupRowNumber - 1, 0) %
                    reportState.reportPdfTableTheme.rows.length
                ]
              );
              pdf.rect(margin, y, tableWidth, rowHeight, "F");
              let x = margin;
              for (let index = 0; index < columns.length; index++) {
                const isResult = index === 8;
                pdf.setFont("helvetica", isResult ? "bold" : "normal");
                pdf.setFontSize(7.5);
                pdf.setTextColor(...reportState.reportPdfTableTheme.text);
                const resultColors = {
                  CONTESTO: [0, 118, 79],
                  "BUZÓN DE VOZ": [153, 94, 0],
                  INOPERABLE: [220, 38, 38],
                  PENDIENTE: [0, 129, 84]
                };
                pdf.setTextColor(
                  ...(isResult
                    ? resultColors[values[index]] || [46, 40, 50]
                    : reportState.reportPdfTableTheme.text)
                );
                pdf.text(lines[index], x + 1.5, y + 4.7);
                x += columns[index].width;
              }
              pdf.setDrawColor(...reportState.reportPdfTableTheme.border);
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

    reportState.$("reportPdf")?.addEventListener("click", () =>
      exportReportsToPdf([report], reportState.$("reportPdf")));
    const downloadTotalReports = button => exportReportsToPdf(reportState.reports, button);
    reportState.$("reportTotalPdf")?.addEventListener("click", event =>
      downloadTotalReports(event.currentTarget));
    reportState.$("reportTotalPdfTop")?.addEventListener("click", event =>
      downloadTotalReports(event.currentTarget));

    const startReportCalls = async (targetReportId, contactIds) => {
      if (!contactIds.length || selectionSubmitting) return;
      selectionSubmitting = true;
      updateSelection();
      const button = reportState.$("reportContinue");
      const feedback = reportState.$("reportSelectionFeedback");
      button.disabled = true;
      feedback.hidden = true;
      try {
        const response = await fetch(
          reportActions.endpoint(
            `/reports/${encodeURIComponent(targetReportId)}/continue`
          ),

          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Dashboard-Token": reportActions.dashboardToken() },
            body: JSON.stringify({ contactIds, manualRetry: true })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw Error(data.error || "No se pudo iniciar");
        }

        reportState.selectedContactIds.clear();
        reportState.$("reportBackBtn").click();
        const statusText = reportState.$("statusText");
        if (statusText) statusText.textContent = `${data.queued} contactos seleccionados agregados a la campaña.`;
      } catch (error) {
        feedback.textContent = error.message || "No se pudieron iniciar las llamadas seleccionadas.";
        feedback.hidden = false;
      } finally {
        selectionSubmitting = false;
        updateSelection();
      }
    };

    reportState.$("reportContinue").onclick = () => startReportCalls(report.id, [...reportState.selectedContactIds]);
    reportState.$("reportDetails").querySelectorAll("[data-open-report]").forEach(button => {
      button.onclick = () => {
        reportState.selectedReport = button.dataset.openReport;
        reportState.reportSearchTerm = "";
        reportState.showingDetailedReport = false;
        reportState.selectedContactIds.clear();
        reportActions.renderDay();
      };
    });
    reportState.$("reportDetails").querySelectorAll("[data-call-report-contact]").forEach(button => {
      button.onclick = () => startReportCalls(button.dataset.callReportId, [button.dataset.callReportContact]);
    });

    const showDetailedReport = () => {
      reportState.showingDetailedReport = true;
      reportState.detailedPendingOnly = false;
      reportState.selectedDetailedTeam = "";
      reportActions.renderDay();
    };
    reportState.$("reportDetailed")?.addEventListener("click", showDetailedReport);
    reportState.$("reportDetailedTop")?.addEventListener("click", showDetailedReport);
  }
return { renderDetails };
}
