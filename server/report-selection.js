import { phoneKey } from "./contact-book.js";
import { isAnsweredAttempt, isVoicemailAttempt, isInoperableAttempt } from "../web/modules/report-metrics.js";

export function selectPendingReportContacts(report, contactIds, { allowManualRetry = false } = {}) {
  if (!Array.isArray(contactIds) || !contactIds.length || contactIds.length > 100000 ||
      contactIds.some(id => typeof id !== "string" || !id.trim() || id.length > 191)) {
    return { status: 400, error: "Selecciona al menos un contacto disponible.", contacts: [] };
  }
  const requested = new Set(contactIds);
  const rows = new Map((report.rows || []).map(row => [String(row.id), row]));
  const contacts = new Map();
  for (const id of requested) {
    const row = rows.get(id);
    if (!row || row.doNotCall || row.manualBlocked || isInoperableAttempt(row) ||
        (!allowManualRetry && (row.pending !== true || isAnsweredAttempt(row) || isVoicemailAttempt(row)))) {
      return { status: 409, error: "La selección contiene contactos inexistentes, inoperables o no disponibles en este reporte.", contacts: [] };
    }
    const phone = phoneKey(row.phone);
    if (!/^\d{9}$/.test(phone)) {
      return { status: 400, error: "La selección contiene un teléfono inválido.", contacts: [] };
    }
    if (!contacts.has(phone)) contacts.set(phone, { ...row, phone });
  }
  return { contacts: [...contacts.values()] };
}
