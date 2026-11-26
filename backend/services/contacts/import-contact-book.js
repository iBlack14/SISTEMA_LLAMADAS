import { createHash } from "node:crypto";
import { phoneKey } from "../campaigns/contact-book.js";
import { isExcludedCampaignContact } from "./contact-exclusions.js";

const normalizeListName = value => String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");

function phoneSet(contacts) {
  return [...new Set((contacts || []).map(contact => phoneKey(contact.phone)).filter(phone => /^\d{6,15}$/.test(phone)))].sort();
}

function samePhoneSet(left, right) {
  return left.length > 0 && left.length === right.length && left.every((phone, index) => phone === right[index]);
}

function fingerprint(phones) {
  return createHash("sha256").update(phones.join(",")).digest("hex");
}

export function collectUsedBaseFingerprints(sessions, excludeCode = "") {
  const used = {};
  for (const [code, session] of sessions || []) {
    if (code === excludeCode) continue;
    const book = session?.contactBook;
    for (const [hash, info] of Object.entries(book?.preferences?.importedBaseFingerprints || {})) {
      if (hash) used[hash] = info;
    }
    for (const list of book?.lists || []) {
      const phones = phoneSet((book.contacts || []).filter(contact => (contact.list || "Principal") === list));
      if (phones.length) used[fingerprint(phones)] ||= { list, username: session?.username || "otro usuario" };
    }
  }
  return used;
}

/** Merge imported list batches while rejecting an already-used base and filtering dial exclusions once. */
export function mergeImportedContactBatches(bookInput, batches, { annualBlocks = new Map(), globallyBlocked = [], usedBases = {} } = {}) {
  const book = {
    contacts: [...(bookInput?.contacts || [])],
    lists: [...new Set(["Principal", ...(bookInput?.lists || [])])],
    activeList: bookInput?.activeList || "Principal",
    calledCounts: bookInput?.calledCounts || {},
    contactRowStatus: bookInput?.contactRowStatus || {},
    callDurations: bookInput?.callDurations || {},
    dismissedReminderIds: bookInput?.dismissedReminderIds || {},
    preferences: { ...(bookInput?.preferences || {}) }
  };
  const fingerprints = { ...(book.preferences.importedBaseFingerprints || {}) };
  const existingByList = new Map();
  for (const list of book.lists) {
    existingByList.set(normalizeListName(list), book.contacts.filter(contact => (contact.list || "Principal") === list));
  }

  const incomingFingerprints = new Set();
  const prepared = (batches || []).map(batch => {
    const list = String(batch?.list || "").trim().replace(/\s+/g, " ");
    if (!list || !Array.isArray(batch?.contacts) || !batch.contacts.length) throw new Error("Cada base requiere un nombre y contactos.");
    const contacts = batch.contacts.map(contact => ({
      ...contact,
      rawPhone: String(contact?.phone || ""),
      phone: phoneKey(contact?.phone),
      name: String(contact?.name || contact?.company || "Contacto").trim() || "Contacto",
      company: String(contact?.company || contact?.name || "").trim()
    })).filter(contact => /^\d{6,15}$/.test(contact.phone));
    if (!contacts.length) throw new Error(`La base "${list}" no contiene teléfonos válidos.`);
    const matchingName = existingByList.get(normalizeListName(list));
    if (matchingName?.length) {
      const error = new Error(`La base "${list}" ya está en uso. Usa otro nombre.`);
      error.status = 409;
      throw error;
    }
    const incomingPhones = phoneSet(contacts);
    const hash = fingerprint(incomingPhones);
    const priorBase = fingerprints[hash] || usedBases[hash];
    if (priorBase || incomingFingerprints.has(hash)) {
      const owner = priorBase?.list ? ` como "${priorBase.list}"${priorBase.username ? ` por ${priorBase.username}` : ""}` : "";
      const error = new Error(`Esta base ya está en uso${owner}. Usa otro archivo.`);
      error.status = 409;
      throw error;
    }
    incomingFingerprints.add(hash);
    for (const [existingName, existingContacts] of existingByList) {
      if (samePhoneSet(incomingPhones, phoneSet(existingContacts))) {
        const error = new Error(`Esta base ya está en uso como "${existingName}". Usa otro archivo.`);
        error.status = 409;
        throw error;
      }
    }
    return { list, contacts };
  });

  const importedPhones = new Set();
  for (const batch of prepared) {
    const targetName = normalizeListName(batch.list);
    const priorBatch = prepared.find(item => item !== batch && normalizeListName(item.list) === targetName);
    if (priorBatch) {
      const error = new Error(`La base "${batch.list}" está repetida en esta importación. Usa otro nombre.`);
      error.status = 409;
      throw error;
    }
    const blockedPhones = new Set(globallyBlocked.map(item => phoneKey(item.phone || item.number)).filter(Boolean));
    const existingPhones = new Set(book.contacts.filter(contact => (contact.list || "Principal") === batch.list).map(contact => phoneKey(contact.phone)));
    let added = 0;
    let skippedCalled = 0;
    let skippedBlocked = 0;
    let skippedDuplicate = 0;
    let skippedExcluded = 0;
    for (const contact of batch.contacts) {
      const phone = contact.phone;
      if (isExcludedCampaignContact(contact, batch.list)) { skippedExcluded++; continue; }
      if (annualBlocks.has(phone)) { skippedCalled++; continue; }
      if (blockedPhones.has(phone)) { skippedBlocked++; continue; }
      if (existingPhones.has(phone) || importedPhones.has(`${targetName}:${phone}`)) { skippedDuplicate++; continue; }
      book.contacts.push({
        id: contact.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
        name: contact.name,
        phone,
        list: batch.list,
        note: String(contact.note || ""),
        ...(contact.company ? { company: String(contact.company) } : {}),
        createdAt: new Date().toISOString()
      });
      existingPhones.add(phone);
      importedPhones.add(`${targetName}:${phone}`);
      added++;
    }
    if (!book.lists.includes(batch.list)) book.lists.push(batch.list);
    if (added) fingerprints[fingerprint(phoneSet(batch.contacts))] = { list: batch.list, importedAt: new Date().toISOString() };
    batch.result = { list: batch.list, added, skippedCalled, skippedBlocked, skippedDuplicate, skippedExcluded };
  }
  book.preferences.importedBaseFingerprints = fingerprints;
  if (prepared[0]?.list) book.activeList = prepared[0].list;
  return { book, batches: prepared.map(({ result }) => result || { list: "", added: 0, skippedCalled: 0, skippedBlocked: 0, skippedDuplicate: 0, skippedExcluded: 0 }) };
}
