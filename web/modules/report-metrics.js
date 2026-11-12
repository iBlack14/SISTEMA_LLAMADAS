// A connected cellular line may be an operator announcement, not a person.
const outcomeCodes = row => [row.technicalResult, row.disposition, row.result]
  .map(value => String(value || "").trim().toLowerCase());

export function isVoicemailAttempt(row = {}) {
  return outcomeCodes(row).some(value => ["buzon_de_voz", "buzón de voz", "buzon de voz", "voicemail"].includes(value));
}

export function isInoperableAttempt(row = {}) {
  return Boolean(row.inoperable) || outcomeCodes(row).some(value =>
    /invalid|inoperable|unreachable|not.in.service|disconnected|sin_servicio|numero_incorrecto|numero_inexistente/.test(value));
}

export function isAnsweredAttempt(row = {}) {
  const outcomes = outcomeCodes(row);
  if (isVoicemailAttempt(row) || outcomes.some(value =>
    ["sin_servicio", "no_disponible", "numero_incorrecto", "numero_inexistente", "inoperable"].includes(value))) return false;
  return Boolean(row.answeredAt || row.answered === true || outcomes.includes("contesto"));
}

export function attemptResultLabel(row = {}) {
  if (isVoicemailAttempt(row)) return "BUZÓN DE VOZ";
  if (isInoperableAttempt(row)) return "INOPERABLE";
  return isAnsweredAttempt(row) ? "CONTESTO" : "PENDIENTE";
}

export function classifyAttempt(row) {
  if (!row.endedAt) return "inProgress";
  if (isVoicemailAttempt(row)) return "unanswered";
  const result = String(row.technicalResult || row.disposition || "").toLowerCase();
  if (isInoperableAttempt(row)) return "inoperable";
  if (isAnsweredAttempt(row)) return "answered";
  if (["sin_respuesta", "no_contactado", "no_contesto", "buzon_de_voz", "no_disponible"].includes(result)) return "unanswered";
  return "unclassified";
}

export function summarizeAttempts(rows) {
  const counts = { total: 0, answered: 0, unanswered: 0, inoperable: 0, inProgress: 0, unclassified: 0 };
  for (const row of rows) {
    counts.total++;
    counts[classifyAttempt(row)]++;
  }
  return counts;
}
