function readable(value, fallback = "sin nombre") {
  return String(value || fallback).replace(/[|\r\n]/g, " ").trim() || fallback;
}

function progress(campaign) {
  const contacts = Array.isArray(campaign?.contacts) ? campaign.contacts : [];
  const counts = { pending: 0, retry_pending: 0, dialing: 0, ringing: 0, in_call: 0, awaiting_callback: 0, completed: 0, failed: 0 };
  for (const item of contacts) if (counts[item.status] !== undefined) counts[item.status] += 1;
  const active = counts.dialing + counts.ringing + counts.in_call;
  const processed = contacts.filter((item) => item.attempts > 0
    || ["dialing", "ringing", "in_call", "awaiting_callback", "completed"].includes(item.status)).length;
  const details = [`Progreso: ${processed}/${contacts.length}`, `Pendientes: ${counts.pending + counts.retry_pending}`, `En curso: ${active}`, `Fallidos: ${counts.failed}`];
  if (counts.retry_pending) details.push(`Reintentos: ${counts.retry_pending}`);
  return details.join(" | ");
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
    ? "Orden enviada; esperando al equipo"
    : (event === "ORDEN" && state === "accepted"
      ? "Android recibió la orden"
      : (STATE_LABELS[String(state || "")] || readable(state, "ESTADO_DESCONOCIDO").toUpperCase()));
  const level = ["failed", "rejected"].includes(state) ? console.warn : console.info;
  const details = [
    `[${event}]`,
    readable(worker?.name || worker?.deviceName || worker?.id, "sin equipo conectado"),
    label,
    readable(contact?.name || contact?.id, "sin contacto"),
    progress(campaign)
  ];
  if (contact?.attempts > 1) details.push(`Intento: ${contact.attempts}`);
  if (contact?.result || contact?.technicalResult) details.push(`Resultado: ${readable(contact.technicalResult || contact.result)}`);
  if (detail) details.push(readable(detail));
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
  const processed = contacts.filter((item) => item.attempts > 0
    || ["dialing", "ringing", "in_call", "awaiting_callback", "completed", "failed"].includes(item.status)).length;
  console.warn(`[CAMPAÑA] ${reason === "sin_equipo_conectado" ? "Sin equipos conectados" : "Sin equipos disponibles"} | Progreso: ${processed}/${contacts.length} | Pendientes: ${counts.pending + counts.retry_pending} | En curso: ${counts.dialing + counts.ringing + counts.in_call}`);
}
