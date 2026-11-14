export const MAX_MESSAGE_CONTACTS = 5000;

function normalizeContact(input, fallbackTimestamp = new Date().toISOString()) {
  if (!input || typeof input !== "object") return null;
  const phone = String(input.phone || "").replace(/\D/g, "");
  if (!/^\d{6,15}$/.test(phone)) return null;
  const name = String(input.name || "").trim().slice(0, 120) || phone;
  return {
    name,
    phone,
    createdAt: String(input.createdAt || fallbackTimestamp),
    updatedAt: String(input.updatedAt || fallbackTimestamp)
  };
}

export function normalizeMessageContacts(input) {
  if (!Array.isArray(input)) return [];
  const contacts = new Map();
  for (const item of input) {
    const contact = normalizeContact(item);
    if (contact) contacts.set(contact.phone, contact);
  }
  return [...contacts.values()].slice(-MAX_MESSAGE_CONTACTS);
}

export function upsertMessageContact(contacts, input, now = new Date()) {
  const timestamp = now.toISOString();
  const contact = normalizeContact({ name: input?.name, phone: input?.phone }, timestamp);
  if (!contact) return { error: "Ingresa un número válido para WhatsApp." };

  const current = normalizeMessageContacts(contacts);
  const previous = current.find((item) => item.phone === contact.phone);
  if (!previous && current.length >= MAX_MESSAGE_CONTACTS) {
    return { error: "La lista alcanzó el límite de 5000 contactos." };
  }

  const updated = {
    ...contact,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp
  };
  return {
    contact: updated,
    contacts: [...current.filter((item) => item.phone !== contact.phone), updated]
  };
}
