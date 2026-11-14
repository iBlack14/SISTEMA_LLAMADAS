import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../campaigns/contact-book.js";
import { collectCallAttempts } from "./call-history.js";

/**
 * createRestrictions: conserva los contratos y reglas existentes.
 * Dependencias: runtime.persistence, runtime.sessions.
 * Se construye una vez por proceso.
 */
export function createRestrictions(runtime, services) {
function allCallAttempts() {
  const rows = [...runtime.persistence.records.values()].map(entry => entry.row);
  for (const session of runtime.sessions.values()) rows.push(...collectCallAttempts(session));
  return rows;
}

function annualBlock(phone) {
  return annualPhoneBlocks(allCallAttempts()).get(phoneKey(phone));
}

function callRestrictions(session) {
  const blocks = annualPhoneBlocks(allCallAttempts());
  const contacts = [...(session.contactBook?.contacts || []),...(session.campaign?.contacts || [])];
  return Object.fromEntries(contacts.flatMap(contact => {
    const phone = phoneKey(contact.phone);
    return blocks.has(phone) ? [[phone,blocks.get(phone)]] : [];
  }));
}

function blockedCallMessage(block) {
  if (block.permanent) return "NO VOLVER A LLAMAR: número inexistente o incorrecto.";
  return "Número llamado anteriormente. Disponible desde " +
    new Date(block.nextAllowedAt).toLocaleDateString("es-PE",{timeZone:"America/Lima"}) + ".";
}
return { allCallAttempts, annualBlock, callRestrictions, blockedCallMessage };
}
