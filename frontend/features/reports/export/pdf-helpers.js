import { isAnsweredAttempt } from '../../../../shared/reports/report-metrics.js';

/**
 * createPdfHelpers: conserva los contratos y reglas existentes.
 * Dependencias: dashboardState.pdfLogoDataPromise.
 * Se construye una vez por dashboard.
 */
export function createPdfHelpers(dashboardState, dashboardActions) {
function loadPdfLogoData() {
  if (dashboardState.pdfLogoDataPromise) return dashboardState.pdfLogoDataPromise;
  dashboardState.pdfLogoDataPromise = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 220;
        canvas.height = 150;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const ratio = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const width = image.naturalWidth * ratio;
        const height = image.naturalHeight * ratio;
        context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      } catch (error) {
        console.warn("No se pudo preparar el logo para el PDF:", error);
        resolve("");
      }
    };
    image.onerror = () => resolve("");
    image.src = `/logo-vc-color.png?v=pdf-${Date.now()}`;
  });
  return dashboardState.pdfLogoDataPromise;
}

function limaClockParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value || 0));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(values.hour || 0), minute: Number(values.minute || 0) };
}

function reportTimeBand(startedAt, shiftType = "") {
  const { hour, minute } = limaClockParts(startedAt);
  const total = hour * 60 + minute;
  const morning = [450, 480, 540, 600, 660, 720, 780, 840];
  const afternoon = [810, 870, 930, 990, 1050, 1110, 1170, 1230];
  const boundaries = shiftType === "afternoon" ? afternoon : morning;
  const colors = ["#f9c9ea", "#e2d1f9", "#cfe0fb", "#ccefee", "#d9f1d2", "#fff1bf", "#f9dcc4"];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    if (total >= boundaries[index] && total < boundaries[index + 1]) return colors[index];
  }
  return "#ffffff";
}

function reportResult(row) {
  const answered = isAnsweredAttempt(row);
  if (row.technicalResult === "buzon_de_voz") return "BUZON DE VOZ";
  if (row.technicalResult === "sin_servicio") return "SIN SERVICIO";
  if (row.technicalResult === "no_disponible") return "NO DISPONIBLE";
  return answered ? "CONTESTO" : "NO CONTESTO";
}
return { loadPdfLogoData, limaClockParts, reportTimeBand, reportResult };
}
