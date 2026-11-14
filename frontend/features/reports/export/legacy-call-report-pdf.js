import { isAnsweredAttempt } from '../../../../shared/reports/report-metrics.js';

/**
 * createLegacyCallReportPdf: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.formatCallDuration, dashboardActions.formatLimaReportDate, dashboardActions.loadPdfLogoData.
 * Se construye una vez por dashboard.
 */
export function createLegacyCallReportPdf(dashboardState, dashboardActions) {
async function legacyBuildCallReportPdf(listName, sourceRows) {
  const JsPdf = window.jspdf?.jsPDF;
  if (!JsPdf) throw new Error("No se pudo cargar el generador PDF.");

  const rows = [...(sourceRows || [])].sort((left, right) => {
    const workerOrder = String(left.worker || "Sin equipo").localeCompare(String(right.worker || "Sin equipo"), "es", {
      sensitivity: "base",
      numeric: true
    });
    if (workerOrder !== 0) return workerOrder;
    const leftAnswered = isAnsweredAttempt(left);
    const rightAnswered = isAnsweredAttempt(right);
    if (leftAnswered !== rightAnswered) return leftAnswered ? -1 : 1;
    return (new Date(left.startedAt || 0).getTime() || 0) - (new Date(right.startedAt || 0).getTime() || 0);
  });
  const documentPdf = new JsPdf({ unit: "pt", format: "a4", orientation: "portrait" });
  const logoData = await dashboardActions.loadPdfLogoData();
  const pageWidth = documentPdf.internal.pageSize.getWidth();
  const pageHeight = documentPdf.internal.pageSize.getHeight();
  const margin = 34;
  const tableWidth = pageWidth - margin * 2;
  const columns = [
    { label: "N.", width: 20 },
    { label: "BASE", width: 61 },
    { label: "EMPRESA", width: 82 },
    { label: "TELEFONO", width: 57 },
    { label: "EQUIPO", width: 78 },
    { label: "HORA (LIMA)", width: 79 },
    { label: "INT.", width: 27 },
    { label: "CONTESTO", width: 52 },
    { label: "DURACION", width: 54 }
  ];
  const answeredRows = rows.filter(isAnsweredAttempt);
  const totalSeconds = rows.reduce((total, row) => total + Number(row.durationSeconds || 0), 0);
  const equipmentCounts = new Map();
  rows.forEach((row) => {
    const equipment = String(row.worker || "Sin equipo").trim() || "Sin equipo";
    equipmentCounts.set(equipment, (equipmentCounts.get(equipment) || 0) + 1);
  });

  let y = 0;
  let pageNumber = 0;
  const setTextColor = (hex) => documentPdf.setTextColor(hex);
  const clip = (value, max) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
  };
  const drawPageFrame = () => {
    pageNumber += 1;
    documentPdf.setFillColor("#fbf7fc");
    documentPdf.rect(0, 0, pageWidth, pageHeight, "F");
    documentPdf.setFillColor("#e800a8");
    documentPdf.rect(0, 0, pageWidth, 13, "F");
    if (logoData) documentPdf.addImage(logoData, "JPEG", margin, 22, 62, 42);
    documentPdf.setFont("helvetica", "bold");
    documentPdf.setFontSize(9);
    setTextColor("#6d087d");
    documentPdf.text("VC - GESTION DE LLAMADAS", logoData ? 104 : margin, 44);
    documentPdf.setFont("helvetica", "normal");
    documentPdf.setFontSize(7.5);
    setTextColor("#6b5b70");
    documentPdf.text(`Pagina ${pageNumber}`, pageWidth - margin, pageHeight - 18, { align: "right" });
    y = 78;
  };
  const ensureSpace = (height, continuationTitle = "DETALLE DEL REGISTRO") => {
    if (y + height <= pageHeight - 34) return false;
    documentPdf.addPage();
    drawPageFrame();
    documentPdf.setFont("helvetica", "bold");
    documentPdf.setFontSize(11);
    setTextColor("#59066b");
    documentPdf.text(continuationTitle, margin, y);
    y += 15;
    return true;
  };
  const drawTableHeader = () => {
    documentPdf.setFillColor("#650073");
    documentPdf.roundedRect(margin, y, tableWidth, 25, 3, 3, "F");
    documentPdf.setFont("helvetica", "bold");
    documentPdf.setFontSize(6.6);
    setTextColor("#ffffff");
    let x = margin;
    columns.forEach((column) => {
      documentPdf.text(column.label, x + 4, y + 16);
      x += column.width;
    });
    y += 25;
  };

  drawPageFrame();
  documentPdf.setFont("helvetica", "bold");
  documentPdf.setFontSize(21);
  setTextColor("#3d064d");
  documentPdf.text("REPORTE DE LLAMADAS", margin, y);
  y += 22;
  documentPdf.setFontSize(12);
  setTextColor("#c0008e");
  documentPdf.text(`Reporte: ${listName || "Sin nombre"}`, margin, y);
  documentPdf.setFont("helvetica", "normal");
  documentPdf.setFontSize(8);
  setTextColor("#6b5b70");
  documentPdf.text(`Generado: ${dashboardActions.formatLimaReportDate(new Date())} (Lima - Peru)`, pageWidth - margin, y, { align: "right" });
  y += 27;

  const summary = [
    ["LLAMADAS", rows.length],
    ["CONTESTADAS", answeredRows.length],
    ["NO CONTESTADAS", Math.max(0, rows.length - answeredRows.length)],
    ["DURACION TOTAL", dashboardActions.formatCallDuration(totalSeconds)]
  ];
  summary.forEach(([label, value], index) => {
    const x = margin + index * (tableWidth / 4);
    documentPdf.setFillColor("#f1e5f4");
    documentPdf.setDrawColor("#df38b1");
    documentPdf.roundedRect(x + 2, y, tableWidth / 4 - 8, 43, 5, 5, "FD");
    documentPdf.setFont("helvetica", "bold");
    documentPdf.setFontSize(7);
    setTextColor("#720565");
    documentPdf.text(label, x + 10, y + 14);
    documentPdf.setFontSize(14);
    setTextColor("#2e0738");
    documentPdf.text(String(value), x + 10, y + 33);
  });
  y += 62;

  documentPdf.setFont("helvetica", "bold");
  documentPdf.setFontSize(10);
  setTextColor("#59066b");
  documentPdf.text("CANTIDAD DE LLAMADAS POR EQUIPO", margin, y);
  y += 13;
  if (!equipmentCounts.size) {
    documentPdf.setFont("helvetica", "normal");
    documentPdf.setFontSize(8);
    setTextColor("#6b5b70");
    documentPdf.text("Todavia no hay llamadas registradas.", margin, y + 9);
    y += 25;
  } else {
    for (const [equipment, count] of equipmentCounts.entries()) {
      ensureSpace(22, "CANTIDAD DE LLAMADAS POR EQUIPO");
      documentPdf.setFillColor("#f5edf7");
      documentPdf.roundedRect(margin, y, tableWidth, 20, 3, 3, "F");
      documentPdf.setFont("helvetica", "bold");
      documentPdf.setFontSize(8);
      setTextColor("#2e0738");
      documentPdf.text(clip(equipment, 70), margin + 7, y + 13);
      setTextColor("#c0008e");
      documentPdf.text(`${count} llamada${count === 1 ? "" : "s"}`, margin + tableWidth - 7, y + 13, { align: "right" });
      y += 22;
    }
  }
  y += 17;
  documentPdf.setFont("helvetica", "bold");
  documentPdf.setFontSize(11);
  setTextColor("#59066b");
  documentPdf.text("DETALLE DEL REGISTRO", margin, y);
  y += 15;
  drawTableHeader();

  if (!rows.length) {
    documentPdf.setFont("helvetica", "normal");
    documentPdf.setFontSize(8.5);
    setTextColor("#6b5b70");
    documentPdf.text("No hay llamadas registradas para este reporte.", margin + 7, y + 18);
  } else {
    let previousWorker = "";
    rows.forEach((row, index) => {
      if (ensureSpace(28)) drawTableHeader();
      const currentWorker = String(row.worker || "Sin equipo");
      const currentList = String(row.list || "Sin lista");
      if (previousWorker && currentWorker !== previousWorker) {
        documentPdf.setDrawColor("#e800a8");
        documentPdf.setLineWidth(1.2);
        documentPdf.line(margin, y, margin + tableWidth, y);
      }
      previousWorker = currentWorker;
      if (index % 2) {
        documentPdf.setFillColor("#f6eef8");
        documentPdf.rect(margin, y, tableWidth, 24, "F");
      }
      const answered = isAnsweredAttempt(row);
      const values = [
        String(index + 1),
        clip(currentList, 13),
        clip(row.name || "Sin nombre", 18),
        clip(row.phone || "-", 12),
        clip(row.worker || "Sin equipo", 17),
        dashboardActions.formatLimaReportDate(row.startedAt, true),
        String(row.attemptNumber || 1),
        answered ? "SI" : "NO",
        dashboardActions.formatCallDuration(Number(row.durationSeconds || 0))
      ];
      let x = margin;
      documentPdf.setFontSize(6.8);
      values.forEach((value, valueIndex) => {
        documentPdf.setFont("helvetica", valueIndex === 0 || valueIndex === 7 ? "bold" : "normal");
        setTextColor(valueIndex === 7 ? (answered ? "#00845f" : "#cc075c") : "#24102b");
        documentPdf.text(value, x + 4, y + 15);
        x += columns[valueIndex].width;
      });
      documentPdf.setDrawColor("#e8cee9");
      documentPdf.setLineWidth(0.4);
      documentPdf.line(margin, y + 24, margin + tableWidth, y + 24);
      y += 24;
    });
  }

  return new Uint8Array(documentPdf.output("arraybuffer"));
}
return { legacyBuildCallReportPdf };
}
