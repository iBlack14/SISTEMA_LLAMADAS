import { nanoid } from "nanoid";

export const phoneKey = phone => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("51") ? digits.slice(2) : digits;
};

export function normalizeBook(input = {}) {
  if (!Array.isArray(input.contacts) || input.contacts.length > 100000) throw new Error("Base de contactos inválida.");
  const lists = [...new Set(["Principal", ...(input.lists || []).map(x => String(x).trim()).filter(Boolean)])];
  const seen = new Set();
  const ids = new Set();
  const contacts = input.contacts.flatMap(item => {
    const phone = phoneKey(item.phone);
    const list = String(item.list || "Principal").trim();
    const key = JSON.stringify([list, phone]);
    if (!/^\d{6,15}$/.test(phone) || seen.has(key)) return [];
    seen.add(key);
    if (!lists.includes(list)) lists.push(list);
    let id = String(item.id || nanoid());
    if (ids.has(id)) id = nanoid();
    ids.add(id);
    return [{ id, phone, list, name:String(item.name || "Contacto"), note:String(item.note || "") }];
  });
  const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {contacts, lists, activeList:lists.includes(input.activeList) ? input.activeList : lists[0],
    calledCounts:object(input.calledCounts), contactRowStatus:object(input.contactRowStatus),
    callDurations:object(input.callDurations), dismissedReminderIds:object(input.dismissedReminderIds),
    preferences:object(input.preferences)};
}

export function annualPhoneBlocks(attempts, now = new Date()) {
  const blocks = new Map();
  const current = new Date(now).getTime();
  for (const row of attempts) {
    const started = new Date(row.startedAt);
    if (!row.startedAt || !Number.isFinite(started.getTime()) || started.getTime() > current) continue;
    const phone = phoneKey(row.phone);
    const permanent = ["numero_inexistente", "numero_incorrecto"].includes(row.technicalResult);
    const existing = blocks.get(phone);
    if (existing?.permanent) continue;
    if (permanent) {
      blocks.set(phone,{lastCalledAt:started.toISOString(),nextAllowedAt:null,permanent:true,reason:"NO VOLVER A LLAMAR: número inexistente o incorrecto"});
      continue;
    }
    const until = new Date(started);
    const month = started.getUTCMonth();
    until.setUTCFullYear(started.getUTCFullYear() + 1);
    // Feb 29 expires on Feb 28 in the following non-leap year.
    if (until.getUTCMonth() !== month) until.setUTCDate(0);
    if (until.getTime() <= current) continue;
    const previous = blocks.get(phone);
    if (!previous || started.getTime() > Date.parse(previous.lastCalledAt)) {
      blocks.set(phone,{lastCalledAt:started.toISOString(),nextAllowedAt:until.toISOString()});
    }
  }
  return blocks;
}

export function withProgress(book, attempts, globalAttempts = attempts, now = new Date()) {
  const byPhone = new Map();
  for (const row of attempts) {
    const phone = phoneKey(row.phone);
    const state = byPhone.get(phone) || {count:0, duration:0, result:""};
    state.count++;
    state.duration += Number(row.durationSeconds || 0);
    state.result = row.technicalResult || state.result;
    byPhone.set(phone, state);
  }
  const result = structuredClone(book);
  const blocks = annualPhoneBlocks(globalAttempts, now);
  for (const contact of result.contacts) {
    const block = blocks.get(phoneKey(contact.phone));
    contact.doNotCall = Boolean(block?.permanent);
    contact.callBlockedUntil = block?.nextAllowedAt || null;
    contact.callBlockReason = block?.reason || (block ? "Número llamado anteriormente" : "");
    const state = byPhone.get(phoneKey(contact.phone));
    if (!state) continue;
    result.calledCounts[contact.id] = state.count;
    result.callDurations[contact.id] = state.duration;
    result.contactRowStatus[contact.id] = state.result;
    contact.attempts = state.count;
    contact.campaignStatus = block ? "completed" : "pending";
  }
  return result;
}

export function excludeCalledPending(campaign, attempts, now = new Date()) {
  const called = annualPhoneBlocks(attempts, now);
  const manualContacts = new Set((campaign.manualReportRetry?.contactIds || []).map(String));
  const assigned = new Set(Object.values(campaign.assignments || {}).map(row => row.contactId));
  for (const contact of campaign.contacts || []) {
    if (assigned.has(contact.id) || !["pending","retry_pending","held"].includes(contact.status)) continue;
    const block = called.get(phoneKey(contact.phone));
    // Only server-authorized report selections may retry within the annual window.
    // Permanent invalid-number blocks are never bypassed.
    if (block && !block.permanent && manualContacts.has(String(contact.id))) continue;
    if (block) {
      contact.status = "failed";
      contact.result = block.permanent ? "numero_inexistente" : "numero_llamado_anteriormente";
      contact.doNotCall = Boolean(block.permanent);
      contact.callBlockedUntil = block.nextAllowedAt;
      contact.callBlockReason = block.reason || "Número llamado anteriormente";
    }
  }
}

export function excludeBlockedPending(campaign, blockedNumbers = []) {
  const blocked = new Set(blockedNumbers.map(entry => phoneKey(entry.phone || entry.number)).filter(Boolean));
  const assigned = new Set(Object.values(campaign.assignments || {}).map(row => row.contactId));
  for (const contact of campaign.contacts || []) {
    if (assigned.has(contact.id) || !["pending", "retry_pending", "held"].includes(contact.status)) continue;
    if (!blocked.has(phoneKey(contact.phone))) continue;
    contact.status = "failed";
    contact.result = "numero_bloqueado";
    contact.callBlockReason = "Número en la lista de bloqueos";
  }
}

export function uncalledContacts(contacts, attempts, now = new Date()) {
  const seen = new Set(annualPhoneBlocks(attempts, now).keys());
  return contacts.filter(contact => {
    const phone = phoneKey(contact.phone);
    if (seen.has(phone)) return false;
    seen.add(phone);
    return true;
  });
}
