function readable(value, fallback = "sin nombre") {
  return String(value || fallback).replace(/[|\r\n]/g, " ").trim() || fallback;
}

function progress(campaign, contact) {
  const contacts = Array.isArray(campaign?.contacts) ? campaign.contacts : [];
  const position = contacts.findIndex((item) => item.id === contact?.id) + 1;
  const counts = { pending: 0, retry_pending: 0, dialing: 0, ringing: 0, in_call: 0, awaiting_callback: 0, completed: 0, failed: 0 };
  for (const item of contacts) if (counts[item.status] !== undefined) counts[item.status] += 1;
  const finished = counts.completed + counts.awaiting_callback + counts.failed;
  return `Avance: ${position || "?"} de ${contacts.length} | Finalizados: ${finished} | Pendientes: ${counts.pending + counts.retry_pending} | En curso: ${counts.dialing + counts.ringing + counts.in_call} | Reintentos: ${counts.retry_pending} | Fallidos: ${counts.failed}`;
}

const STATE_LABELS = Object.freeze({
  dialing: "Marcando",
  ringing: "Timbrando",
  in_call: "En llamada",
  ended: "Finalizada",
  failed: "Fallida",
  idle: "Disponible",
  available: "Disponible",
  accepted: "Orden recibida por Android",
  rejected: "Orden rechazada por Android"
});
const lastWaitingKeys = new WeakMap();

export function logOperationalCall({ campaign, worker, contact, state, event = "LLAMADA", sessionCode = "", detail = "" }) {
  const label = event === "ASIGNACION" && state === "dialing"
    ? "Asignado; esperando confirmación del equipo"
    : (STATE_LABELS[String(state || "")] || readable(state, "ESTADO_DESCONOCIDO").toUpperCase());
  const level = ["failed", "rejected"].includes(state) ? console.warn : console.info;
  const details = [
    `[${event}]`,
    `Sesión: ${readable(String(sessionCode).slice(-2), "--")}`,
    `Equipo: ${readable(worker?.name || worker?.deviceName || worker?.id, "sin equipo conectado")}`,
    `Estado: ${label}`,
    `Contacto: ${readable(contact?.name || contact?.id, "sin contacto")}`,
    progress(campaign, contact)
  ];
  if (contact?.attempts) details.push(`Intento: ${contact.attempts}`);
  if (contact?.result || contact?.technicalResult) details.push(`Resultado: ${readable(contact.technicalResult || contact.result)}`);
  if (detail) details.push(`Detalle: ${readable(detail)}`);
  level(details.join(" | "));
}

export function logCampaignWaiting({ campaign, workers = [], sessionCode = "" }) {
  const contacts = Array.isArray(campaign?.contacts) ? campaign.contacts : [];
  const counts = { pending: 0, retry_pending: 0, dialing: 0, ringing: 0, in_call: 0, awaiting_callback: 0, completed: 0, failed: 0 };
  for (const item of contacts) if (counts[item.status] !== undefined) counts[item.status] += 1;
  const finished = counts.completed + counts.awaiting_callback + counts.failed;
  const reason = workers.length ? "sin_contactos_disponibles" : "sin_equipo_conectado";
  const key = `${campaign?.status}:${reason}:${contacts.length}:${finished}:${counts.pending}:${counts.retry_pending}`;
  if (campaign && lastWaitingKeys.get(campaign) === key) return;
  if (campaign) lastWaitingKeys.set(campaign, key);
  console.warn(`[CAMPAÑA] Sesión: ${readable(String(sessionCode).slice(-2), "--")} | Estado: Esperando | Motivo: ${reason === "sin_equipo_conectado" ? "No hay equipo conectado" : "Sin contactos disponibles"} | Finalizados: ${finished} de ${contacts.length} | Pendientes: ${counts.pending} | Reintentos: ${counts.retry_pending} | En curso: ${counts.dialing + counts.ringing + counts.in_call} | Equipos conectados: ${workers.length}`);
}
