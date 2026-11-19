/**
 * Estado de envío por contacto del panel de mensajes.
 *
 * El navegador no puede confirmar que WhatsApp entregó el mensaje: solo sabe
 * si logró abrir WhatsApp Web con el texto. Por eso se distinguen dos estados:
 *   - "sent":   se abrió WhatsApp Web / el cliente de correo con el mensaje.
 *   - "failed": se cerró el popup sin enviar o el navegador bloqueó la apertura.
 */

import { currentUser } from "../auth/auth-session.js";

export const MESSAGE_SEND_STATUS_EVENT = "message-send-status:changed";

const STORAGE_PREFIX = "voip vc.messageSendStatus";

function currentAccountId() {
  return String(
    window.VOIP_VC_AUTH_USER?.id || currentUser?.id || ""
  );
}

function storageKey() {
  return `${STORAGE_PREFIX}:${currentAccountId() || "anon"}`;
}

/** Clave estable: quita el código de país para que 51987654321 = 987654321. */
export function sendStatusKey(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("51") && digits.length >= 11) digits = digits.slice(-9);
  return digits;
}

function readStore() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(store));
  } catch {
    // Sin almacenamiento el estado solo dura la sesión actual.
  }
}

export function getSendStatus(phone) {
  const key = sendStatusKey(phone);
  if (!key) return null;
  const entry = readStore()[key];
  return entry && entry.status ? entry : null;
}

export function recordSendStatus(phone, status, channel = "whatsapp") {
  const key = sendStatusKey(phone);
  if (!key) return null;
  const entry = {
    status: status === "sent" ? "sent" : "failed",
    channel,
    at: new Date().toISOString()
  };
  const store = readStore();
  store[key] = entry;
  writeStore(store);
  try {
    window.dispatchEvent(new CustomEvent(MESSAGE_SEND_STATUS_EVENT, {
      detail: { phone: key, ...entry }
    }));
  } catch {
    // Navegadores muy antiguos sin CustomEvent: el próximo render lo lee del storage.
  }
  return entry;
}
