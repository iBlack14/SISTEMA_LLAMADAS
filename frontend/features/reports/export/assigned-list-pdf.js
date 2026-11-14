import { isAnsweredAttempt } from '../../../../shared/reports/report-metrics.js';

/**
 * createAssignedListPdf: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.buildCallReportPdf, dashboardActions.currentShiftSnapshot, dashboardActions.formatCallDuration, dashboardActions.getCampaignReportRows.
 * Se construye una vez por dashboard.
 */
export function createAssignedListPdf(dashboardState, dashboardActions) {
async function downloadAssignedListReport(listName) {
  const rows = dashboardActions.getCampaignReportRows()
    .filter((item) => (item.list || "") === listName)
    .sort((left, right) => (new Date(left.startedAt || 0).getTime() || 0) - (new Date(right.startedAt || 0).getTime() || 0));
  const shift = dashboardActions.currentShiftSnapshot()?.current || dashboardActions.currentShiftSnapshot()?.detected || {};
  const pdf = await dashboardActions.buildCallReportPdf(listName, rows, shift);
  const blob = new Blob([pdf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `reporte_${String(listName || "lista").replace(/[^a-z0-9_-]+/gi, "_")}_${new Date().toISOString().slice(0, 10)}.pdf`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pdfSafeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function pdfClipText(value, maxLength) {
  const text = pdfSafeText(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function buildAssignedListPdf(listName, rows) {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 38;
  const pages = [];
  let commands = [];
  let y = 0;
  let pageNumber = 0;

  const text = (value, x, baseline, size = 9, bold = false, color = "0.12 0.03 0.18") => {
    commands.push(`${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x} ${baseline} Tm (${pdfSafeText(value)}) Tj ET`);
  };
  const rect = (x, bottom, width, height, fill, stroke = null) => {
    commands.push(`${fill} rg${stroke ? ` ${stroke} RG` : ""} ${x} ${bottom} ${width} ${height} re ${stroke ? "B" : "f"}`);
  };
  const line = (x1, y1, x2, y2, color = "0.88 0.76 0.90") => {
    commands.push(`${color} RG 0.5 w ${x1} ${y1} m ${x2} ${y2} l S`);
  };
  const startPage = () => {
    if (commands.length) pages.push(commands.join("\n"));
    commands = [];
    pageNumber += 1;
    rect(0, 0, pageWidth, pageHeight, "0.985 0.975 0.992");
    rect(0, pageHeight - 15, pageWidth, 15, "0.91 0.00 0.67");
    text("VIAVOX VC - GESTION DE LLAMADAS", margin, pageHeight - 42, 9, true, "0.43 0.03 0.55");
    text(`Pagina ${pageNumber}`, pageWidth - 82, 24, 8, false, "0.42 0.33 0.46");
    y = pageHeight - 70;
  };
  const tableHeader = () => {
    const headers = ["N.", "EMPRESA", "TELEFONO", "EQUIPO", "INT.", "CONTESTO", "DURACION"];
    const widths = [28, 132, 78, 103, 42, 67, 66];
    let x = margin;
    rect(margin, y - 22, 516, 25, "0.38 0.02 0.46");
    headers.forEach((header, index) => {
      text(header, x + 5, y - 14, 7.5, true, "1 1 1");
      x += widths[index];
    });
    y -= 25;
  };

  const answeredRows = rows.filter(isAnsweredAttempt);
  const totalSeconds = rows.reduce((total, row) => total + Number(row.durationSeconds || 0), 0);
  const equipmentCounts = new Map();
  rows.forEach((row) => {
    const equipment = String(row.worker || "Sin equipo").trim() || "Sin equipo";
    equipmentCounts.set(equipment, (equipmentCounts.get(equipment) || 0) + 1);
  });

  startPage();
  text("REPORTE DE LLAMADAS", margin, y, 22, true, "0.24 0.01 0.31");
  y -= 26;
  text(`Lista: ${listName || "Sin nombre"}`, margin, y, 13, true, "0.72 0.00 0.59");
  text(`Generado: ${new Date().toLocaleString("es-PE")}`, 345, y, 8, false, "0.42 0.33 0.46");
  y -= 44;

  const summary = [
    ["LLAMADAS", rows.length],
    ["CONTESTADAS", answeredRows.length],
    ["NO CONTESTADAS", Math.max(0, rows.length - answeredRows.length)],
    ["DURACION TOTAL", dashboardActions.formatCallDuration(totalSeconds)]
  ];
  summary.forEach(([label, value], index) => {
    const x = margin + index * 130;
    rect(x, y - 38, 119, 46, "0.95 0.91 0.97", "0.88 0.20 0.72");
    text(label, x + 8, y - 7, 7, true, "0.45 0.05 0.50");
    text(value, x + 8, y - 28, 15, true, "0.18 0.02 0.25");
  });
  y -= 68;

  text("CANTIDAD DE LLAMADAS POR EQUIPO", margin, y, 11, true, "0.35 0.02 0.43");
  y -= 20;
  if (!equipmentCounts.size) {
    text("Todavia no hay llamadas registradas.", margin, y, 9, false, "0.42 0.33 0.46");
    y -= 22;
  } else {
    [...equipmentCounts.entries()].forEach(([equipment, count], index) => {
      if (y < 135) startPage();
      rect(margin, y - 14, 516, 22, index % 2 ? "0.98 0.96 0.99" : "0.94 0.90 0.96");
      text(pdfClipText(equipment, 66), margin + 8, y - 7, 8.5, true);
      text(`${count} llamada${count === 1 ? "" : "s"}`, pageWidth - 119, y - 7, 8.5, true, "0.72 0.00 0.59");
      y -= 22;
    });
  }
  y -= 22;
  text("DETALLE DEL REGISTRO", margin, y, 11, true, "0.35 0.02 0.43");
  y -= 18;
  tableHeader();

  if (!rows.length) {
    text("No hay llamadas registradas para esta lista.", margin + 8, y - 18, 9, false, "0.42 0.33 0.46");
  } else {
    rows.forEach((row, index) => {
      if (y < 66) {
        startPage();
        text(`REPORTE: ${pdfClipText(listName, 55)}`, margin, y, 12, true, "0.35 0.02 0.43");
        y -= 24;
        tableHeader();
      }
      const answered = isAnsweredAttempt(row);
      const values = [
        index + 1,
        pdfClipText(row.name || "Sin nombre", 25),
        pdfClipText(row.phone || "-", 14),
        pdfClipText(row.worker || "Sin equipo", 19),
        row.attemptNumber || 1,
        answered ? "SI" : "NO",
        dashboardActions.formatCallDuration(Number(row.durationSeconds || 0))
      ];
      const widths = [28, 132, 78, 103, 42, 67, 66];
      let x = margin;
      if (index % 2) rect(margin, y - 20, 516, 24, "0.975 0.955 0.982");
      values.forEach((value, valueIndex) => {
        const color = valueIndex === 5 ? (answered ? "0.00 0.48 0.35" : "0.78 0.05 0.36") : "0.12 0.03 0.18";
        text(value, x + 5, y - 13, 7.8, valueIndex === 0 || valueIndex === 5, color);
        x += widths[valueIndex];
      });
      line(margin, y - 20, margin + 516, y - 20);
      y -= 24;
    });
  }
  pages.push(commands.join("\n"));

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"
  ];
  const kids = [];
  pages.forEach((content, index) => {
    const pageObject = 5 + index * 2;
    const contentObject = pageObject + 1;
    kids.push(`${pageObject} 0 R`);
    objects[pageObject - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObject} 0 R >>`;
    objects[contentObject - 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  let documentText = "%PDF-1.4\n%PDFREPORT\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = documentText.length;
    documentText += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = documentText.length;
  documentText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    documentText += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  documentText += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(documentText);
}
return { downloadAssignedListReport, pdfSafeText, pdfClipText, buildAssignedListPdf };
}
