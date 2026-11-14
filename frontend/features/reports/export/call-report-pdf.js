

/**
 * createCallReportPdf: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.formatCallDuration, dashboardActions.formatLimaReportDate, dashboardActions.loadPdfLogoData, dashboardActions.reportResult, dashboardActions.reportWorkerKey, dashboardActions.reportWorkerLabel.
 * Se construye una vez por dashboard.
 */
export function createCallReportPdf(dashboardState, dashboardActions) {
async function buildCallReportPdf(listName, sourceRows, shift = {}) {
  const JsPdf = window.jspdf?.jsPDF;
  if (!JsPdf) throw new Error("No se pudo cargar el generador PDF.");
  const rows = [...(sourceRows || [])].sort((left, right) => {
    const worker = dashboardActions.reportWorkerKey(left).localeCompare(dashboardActions.reportWorkerKey(right), "es", { numeric: true });
    if (worker) return worker;
    const leftAnswered = dashboardActions.reportResult(left) === "CONTESTO";
    const rightAnswered = dashboardActions.reportResult(right) === "CONTESTO";
    if (leftAnswered !== rightAnswered) return leftAnswered ? -1 : 1;
    return (Date.parse(left.startedAt || 0) || 0) - (Date.parse(right.startedAt || 0) || 0);
  });
  const groups = new Map();
  rows.forEach((row) => {
    const workerKey = dashboardActions.reportWorkerKey(row);
    if (!groups.has(workerKey)) groups.set(workerKey, []);
    groups.get(workerKey).push(row);
  });
  if (!groups.size) groups.set("Sin equipo", []);

  const totalCalls = rows.length;
  const answeredCalls = rows.filter((row) => dashboardActions.reportResult(row) === "CONTESTO").length;
  const unansweredCalls = totalCalls - answeredCalls;
  const equipmentLabels = new Map(
    [...groups.keys()].map((workerKey, index) => [workerKey, `EQUIPO ${index + 1}`])
  );

  const pdf = new JsPdf({ unit: "pt", format: "a4", orientation: "landscape" });
  const logo = await dashboardActions.loadPdfLogoData();
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const margin = 30;
  const columns = [
    ["N.", 24], ["BASE", 74], ["EMPRESA", 128], ["TELEFONO", 72],
    ["EQUIPO", 65], ["HORA LIMA", 105], ["INT.", 32], ["DURACION", 57], ["RESULTADO", 105]
  ];
  const tableWidth = columns.reduce((sum, column) => sum + column[1], 0);
  const reportRight = margin + tableWidth;
  let page = 0;
  const clip = (value, max) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  };
  const header = (workerKey, workerName, count, continuation = false) => {
    page += 1;
    pdf.setFillColor("#fbf7fc"); pdf.rect(0, 0, width, height, "F");
    pdf.setFillColor("#e800a8"); pdf.rect(0, 0, width, 12, "F");
    if (logo) pdf.addImage(logo, "JPEG", margin, 20, 56, 38);
    pdf.setFont("helvetica", "bold"); pdf.setTextColor("#4b075a"); pdf.setFontSize(18);
    pdf.text("REPORTE DE LLAMADAS", logo ? 98 : margin, 39);
    pdf.setFontSize(11); pdf.setTextColor("#c0008e");
    const equipmentLabel = equipmentLabels.get(workerKey) || "EQUIPO 1";
    pdf.text(`${equipmentLabel}: ${workerName.toUpperCase()}${continuation ? " (CONTINUACION)" : ""}`, margin, 78);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor("#3a2440");
    pdf.text(`${shift.label || listName || "TURNO"} | ${shift.date || dashboardActions.formatLimaReportDate(new Date()).slice(0, 10)} | ${count} llamada${count === 1 ? "" : "s"}`, margin, 94);
    pdf.text("Lima - Peru", reportRight, 39, { align: "right" });
    pdf.text(`Pagina ${page}`, reportRight, height - 14, { align: "right" });
    if (page === 1) {
      const cards = [
        ["LLAMADAS TOTALES", totalCalls, "#650073"],
        ["CONTESTADAS", answeredCalls, "#00764f"],
        ["NO CONTESTADAS", unansweredCalls, "#a40055"]
      ];
      const cardWidth = 128;
      const startX = reportRight - cards.length * cardWidth - (cards.length - 1) * 8;
      cards.forEach(([label, value, color], index) => {
        const x = startX + index * (cardWidth + 8);
        pdf.setFillColor("#ffffff");
        pdf.setDrawColor(color);
        pdf.roundedRect(x, 60, cardWidth, 38, 4, 4, "FD");
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(6.5); pdf.setTextColor(color);
        pdf.text(label, x + 8, 73);
        pdf.setFontSize(13);
        pdf.text(String(value), x + 8, 91);
      });
    }
    // Mantiene una separacion visual clara entre el encabezado/resumen y la tabla
    // en la primera pagina, las paginas por equipo y las continuaciones.
    return 128;
  };
  const tableHeader = (y) => {
    pdf.setFillColor("#650073"); pdf.roundedRect(margin, y, tableWidth, 25, 3, 3, "F");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(7); pdf.setTextColor("#ffffff");
    let x = margin;
    columns.forEach(([label, columnWidth]) => { pdf.text(label, x + 4, y + 16); x += columnWidth; });
    return y + 25;
  };

  let firstPage = true;
  for (const [workerKey, workerRows] of groups.entries()) {
    const workerName = workerRows.length ? dashboardActions.reportWorkerLabel(workerRows[0]) : "Sin equipo";
    if (!firstPage) pdf.addPage();
    firstPage = false;
    let y = tableHeader(header(workerKey, workerName, workerRows.length));
    if (!workerRows.length) {
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor("#49384d");
      pdf.text("No hay llamadas registradas para este equipo.", margin + 6, y + 20);
      continue;
    }
    for (let index = 0; index < workerRows.length; index += 1) {
      const row = workerRows[index];
      if (y + 26 > height - 30) {
        pdf.addPage();
        y = tableHeader(header(workerKey, workerName, workerRows.length, true));
      }
      pdf.setFillColor(index % 2 === 0 ? "#ffffff" : "#fbf7fc");
      pdf.rect(margin, y, tableWidth, 25, "F");
      const result = dashboardActions.reportResult(row);
      const equipmentLabel = equipmentLabels.get(workerKey) || "EQUIPO 1";
      const values = [
        String(index + 1), clip(row.list || "Sin lista", 16), clip(row.name || "Sin nombre", 28),
        clip(row.phone || "-", 12), equipmentLabel, dashboardActions.formatLimaReportDate(row.startedAt, true), String(row.attemptNumber || 1),
        dashboardActions.formatCallDuration(Number(row.durationSeconds || 0)), result
      ];
      let x = margin;
      pdf.setFontSize(7.2);
      values.forEach((value, valueIndex) => {
        const resultIndex = values.length - 1;
        const timeIndex = 5;
        if (valueIndex === timeIndex) {
          const dateTime = String(value || "").trim();
          const separator = dateTime.lastIndexOf(" ");
          const datePart = separator > 0 ? dateTime.slice(0, separator) : "";
          const timePart = separator > 0 ? dateTime.slice(separator + 1) : dateTime;
          pdf.setFont("helvetica", "normal");
          pdf.setTextColor("#24102b");
          if (datePart) pdf.text(datePart, x + 4, y + 16);
          const timeX = x + 4 + (datePart ? pdf.getTextWidth(`${datePart} `) : 0);
          pdf.setFont("helvetica", "bold");
          pdf.setTextColor("#d00095");
          pdf.text(timePart, timeX, y + 16);
          x += columns[valueIndex][1];
          return;
        }
        pdf.setFont(
          "helvetica",
          valueIndex === 0 || valueIndex === resultIndex ? "bold" : "normal"
        );
        pdf.setTextColor(
          valueIndex === resultIndex
            ? (result === "CONTESTO" ? "#00764f" : "#a40055")
            : "#24102b"
        );
        pdf.text(value, x + 4, y + 16);
        x += columns[valueIndex][1];
      });
      pdf.setDrawColor("#dcb9df"); pdf.line(margin, y + 25, margin + tableWidth, y + 25);
      y += 25;
    }
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}
return { buildCallReportPdf };
}
