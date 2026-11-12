import { phoneKey } from "./contact-book.js";

// Derive per-list views without rewriting the archived campaign or its history.
export function splitReportByList(record) {
  const groups = new Map();
  const byId = new Map();
  const byPhone = new Map();
  const getGroup = name => {
    if (!groups.has(name)) groups.set(name, { ...record, rubro: name, contacts: [], history: [] });
    return groups.get(name);
  };
  for (const contact of record.contacts || []) {
    const name = String(contact.list || record.rubro || "Principal").trim() || "Principal";
    getGroup(name).contacts.push(contact);
    if (contact.id != null) byId.set(String(contact.id), name);
    const phone = phoneKey(contact.phone);
    if (phone) {
      if (!byPhone.has(phone)) byPhone.set(phone, new Set());
      byPhone.get(phone).add(name);
    }
  }
  if (groups.size <= 1) {
    const name = groups.keys().next().value || record.rubro || "Principal";
    return [{ ...record, rubro: name }];
  }
  for (const attempt of record.history || []) {
    let name = byId.get(String(attempt.contactId || ""));
    if (!name && groups.has(String(attempt.list || "").trim())) name = String(attempt.list).trim();
    if (!name) {
      const candidates = byPhone.get(phoneKey(attempt.phone));
      if (candidates?.size === 1) name = candidates.values().next().value;
    }
    getGroup(name || "Sin lista identificada").history.push(attempt);
  }
  return [...groups.entries()].map(([name, group]) => ({
    ...group,
    id: record.id + "." + Buffer.from(name, "utf8").toString("base64url")
  }));
}
