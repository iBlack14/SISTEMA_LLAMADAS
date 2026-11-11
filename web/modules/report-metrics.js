// Shared with the administrator API and the unified call report exports.
export function isAnsweredAttempt(row) {
  return !["buzon_de_voz", "sin_servicio", "no_disponible", "numero_incorrecto", "inoperable"].includes(row.technicalResult)
    && Boolean(row.answeredAt || row.technicalResult === "contesto");
}

export function classifyAttempt(row) {
  if (!row.endedAt) return "inProgress";
  const result = String(row.technicalResult || row.disposition || "").toLowerCase();
  if (/invalid|inoperable|unreachable|not.in.service|disconnected|sin_servicio|numero_incorrecto/.test(result)) return "inoperable";
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
