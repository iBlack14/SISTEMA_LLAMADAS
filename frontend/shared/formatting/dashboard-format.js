

/**
 * createDashboardFormat: conserva los contratos y reglas existentes.
 * Dependencias: .
 * Se construye una vez por dashboard.
 */
export function createDashboardFormat(dashboardState, dashboardActions) {
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function makeId() {
  return (typeof crypto.randomUUID === "function")
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function normalizePhone(input) {
  return String(input || "").replace(/[^\d+]/g, "").trim();
}

function normalizeImportedPhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  // Preserve malformed source values so they can be audited, but never dialed.
  if (/\p{L}/u.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return raw.startsWith("+") ? `+${digits}` : digits;
}

function normalizeValidPeruPhone(input) {
  const raw = String(input || "").trim();
  if (!raw || /\p{L}/u.test(raw)) return "";
  let digits = raw.replace(/\D/g, "");
  if ((raw.startsWith("+51") || (digits.length === 11 && digits.startsWith("51"))) && digits.startsWith("51")) {
    digits = digits.slice(2);
  }
  return /^\d{9}$/.test(digits) ? digits : "";
}

function whatsappActionIcon() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16.01 3C8.84 3 3 8.75 3 15.82c0 2.25.6 4.45 1.73 6.38L3 29l7.02-1.82a13.15 13.15 0 0 0 5.99 1.45H16c7.17 0 13-5.75 13-12.82S23.18 3 16.01 3Zm7.65 18.1c-.32.9-1.88 1.72-2.6 1.82-.67.1-1.52.15-2.45-.14-.57-.18-1.3-.42-2.24-.82-3.94-1.68-6.52-5.59-6.72-5.85-.19-.26-1.6-2.1-1.6-4.01 0-1.92 1.02-2.86 1.38-3.25.36-.39.79-.49 1.05-.49h.76c.24 0 .57-.09.89.67.32.77 1.1 2.68 1.2 2.87.1.19.16.42.03.68-.13.26-.2.42-.39.65-.2.23-.41.5-.59.67-.2.19-.4.4-.17.79.23.39 1.03 1.67 2.21 2.71 1.52 1.34 2.8 1.76 3.2 1.95.39.2.62.16.85-.1.23-.26.98-1.13 1.24-1.52.26-.39.53-.32.89-.19.36.13 2.3 1.07 2.69 1.26.39.19.66.29.75.45.1.16.1.94-.22 1.85Z"/></svg>`;
}

function mobileCallActionIcon() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M7.15 3.15 11.7 2c.88-.22 1.8.23 2.14 1.07l2.08 5.13c.3.74.08 1.6-.55 2.09l-2.66 2.12a19.05 19.05 0 0 0 6.88 6.88l2.12-2.66a1.82 1.82 0 0 1 2.09-.55l5.13 2.08c.84.34 1.29 1.26 1.07 2.14l-1.15 4.55a3.13 3.13 0 0 1-3.03 2.38C14.21 27.23 4.77 17.79 4.77 6.18a3.13 3.13 0 0 1 2.38-3.03Z" fill="currentColor"/></svg>`;
}

function formatSeconds(value) {
  const total = Math.max(0, Number(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function formatLimaReportDate(value, compact = false) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("es-PE", compact
    ? { timeZone: "America/Lima", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    : { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
  ).format(date).replace(",", "");
}

function formatReportDate(value) {
  return value ? `${formatLimaReportDate(value)} (Lima)` : "—";
}

function reportResultLabel(value) {
  const labels = {
    buzon_de_voz: "Buzón de voz",
    sin_servicio: "Sin servicio",
    numero_inexistente: "NO VOLVER A LLAMAR · Número inexistente o incorrecto",
    numero_llamado_anteriormente: "Número llamado anteriormente",
    no_disponible: "No disponible",
    contesto: "Conectada",
    sin_respuesta: "Sin respuesta",
    no_contactado: "No contactado",
    reintentar: "Reintentar",
    no_interesado: "Sin interés",
    interesado: "Interesado",
    agendado: "Agendado",
    requiere_asesor: "Requiere asesor",
    numero_incorrecto: "Número incorrecto"
  };
  return labels[value] || String(value || "—").replaceAll("_", " ");
}

function reportResultClass(value) {
  const normalized = String(value || "empty").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `result-${normalized}`;
}

function formatCallDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Number(totalSeconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    const remMinutes = minutes % 60;
    return [hours, remMinutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  }
  return [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
return { escHtml, makeId, normalizePhone, normalizeImportedPhone, normalizeValidPeruPhone, whatsappActionIcon, mobileCallActionIcon, formatSeconds, csvCell, formatLimaReportDate, formatReportDate, reportResultLabel, reportResultClass, formatCallDuration };
}
