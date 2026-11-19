

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
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.198-.347.223-.644.075-.297-.149-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.521-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.273.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.29.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.002-5.45 4.437-9.884 9.888-9.884 2.64.001 5.12 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.946L0 24l6.335-1.662a11.882 11.882 0 0 0 5.711 1.455h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.412Z"/></svg>`;
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
