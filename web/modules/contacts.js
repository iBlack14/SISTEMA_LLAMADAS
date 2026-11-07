const CALLED_COUNTS_KEY = "voip vc.calledCounts";
const CONTACT_ROW_STATUS_KEY = "voip vc.contactRowStatus";
const CONTACT_CALL_DURATIONS_KEY = "voip vc.callDurations";
const NOTE_REMINDERS_DISMISSED_KEY = "voip vc.noteRemindersDismissed";

export let contacts = [];
export let calledCounts = {};
export let contactRowStatus = {};
export let callDurations = {};
export let dismissedReminderIds = {};
export let lists = ["Principal"];
export let activeList = "Principal";

const LISTS_KEY = "voip vc.lists";
let transport = null;
let ready = false;
let revision = 0;
let saveQueue = Promise.resolve();
let saveError = null;
let scheduled = false;
let loading = null;
let connectionKey = "";
let preferences = {};

function snapshot() {
  return structuredClone({contacts,lists,activeList,calledCounts,contactRowStatus,callDurations,dismissedReminderIds,preferences});
}

function apply(book) {
  contacts = book.contacts || [];
  lists = book.lists || ["Principal"];
  activeList = book.activeList || lists[0];
  calledCounts = book.calledCounts || {};
  contactRowStatus = book.contactRowStatus || {};
  callDurations = book.callDurations || {};
  dismissedReminderIds = book.dismissedReminderIds || {};
  preferences = book.preferences || {};
}

function persist() {
  if (!ready || !transport || scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const book = snapshot();
    const key = connectionKey;
    const request = transport;
    saveQueue = saveQueue.then(async () => {
      if (saveError || connectionKey !== key) return;
      try {
        const result = await request("PUT",{book,revision});
        if (connectionKey !== key) return;
        revision = result.revision;
        window.dispatchEvent(new Event("contact-book:saved"));
      } catch (error) {
        saveError = error;
        window.dispatchEvent(new CustomEvent("contact-book:error",{detail:error.message}));
      }
    });
  });
}

export function connectDatabase(key, request) {
  if (loading && connectionKey === key) return loading;
  if (connectionKey && connectionKey !== key) {
    apply({});
    saveQueue = Promise.resolve();
  }
  connectionKey = key;
  transport = request;
  ready = false;
  const legacy = localStorage.getItem("voip vc.contacts") ? snapshot() : null;
  loading = (async () => {
    const result = await request("GET");
    if (connectionKey !== key) return;
    revision = result.revision;
    if (result.book) {
      apply(result.book);
      if (legacy?.contacts.length) {
        contacts = [...contacts,...legacy.contacts];
        lists = [...new Set([...lists,...legacy.lists])];
        const saved = await request("PUT",{book:snapshot(),revision});
        if (connectionKey !== key) return;
        revision = saved.revision;
        const refreshed = await request("GET");
        if (connectionKey !== key) return;
        apply(refreshed.book);
      }
    } else {
      const saved = await request("PUT",{book:snapshot(),revision});
      if (connectionKey !== key) return;
      revision = saved.revision;
    }
    ready = true;
    saveError = null;
    for (const key of ["voip vc.contacts",LISTS_KEY,CALLED_COUNTS_KEY,CONTACT_ROW_STATUS_KEY,CONTACT_CALL_DURATIONS_KEY,NOTE_REMINDERS_DISMISSED_KEY]) localStorage.removeItem(key);
    window.dispatchEvent(new Event("contact-book:loaded"));
  })().catch(error => {
    saveError = error;
    window.dispatchEvent(new CustomEvent("contact-book:error",{detail:error.message}));
    throw error;
  });
  return loading;
}

export function getPreference(key, fallback = null) {
  return structuredClone(preferences[key] ?? fallback);
}

export function setPreference(key, value) {
  if (JSON.stringify(preferences[key]) === JSON.stringify(value)) return;
  preferences[key] = value;
  persist();
}

export async function flushDatabase() {
  if (!loading) throw new Error("Espera a que la base se conecte con MySQL.");
  await loading;
  await Promise.resolve();
  await saveQueue;
  if (saveError) throw saveError;
}


export function loadContacts() {
  try { contacts = JSON.parse(localStorage.getItem("voip vc.contacts") || "[]"); }
  catch { contacts = []; }
  if (!Array.isArray(contacts)) contacts = [];
  
  // Ensure all contacts have a list property
  contacts.forEach(c => { if (!c.list) c.list = "Principal"; });
  
  loadLists();
  return contacts;
}

export function loadLists() {
  try { lists = JSON.parse(localStorage.getItem(LISTS_KEY) || "[\"Principal\"]"); }
  catch { lists = ["Principal"]; }
  if (!Array.isArray(lists)) lists = ["Principal"];
  lists = [...new Set(lists.map(name => String(name || "").trim()).filter(Boolean))];
  if (!lists.includes("Principal")) lists.unshift("Principal");
}

export function saveLists() {
  persist();
}

export function saveContacts() {
  persist();
}

// ... original load/save functions (calledCounts, etc.) ...
export function loadCalledCounts() {
  try { calledCounts = JSON.parse(localStorage.getItem(CALLED_COUNTS_KEY) || "{}"); }
  catch { calledCounts = {}; }
  return calledCounts;
}
export function saveCalledCounts() { persist(); }
export function loadContactRowStatus() {
  try { contactRowStatus = JSON.parse(localStorage.getItem(CONTACT_ROW_STATUS_KEY) || "{}"); }
  catch { contactRowStatus = {}; }
  return contactRowStatus;
}
export function saveContactRowStatus() { persist(); }
export function loadCallDurations() {
  try { callDurations = JSON.parse(localStorage.getItem(CONTACT_CALL_DURATIONS_KEY) || "{}"); }
  catch { callDurations = {}; }
  return callDurations;
}
export function saveCallDurations() { persist(); }
export function loadDismissedReminders() {
  try { dismissedReminderIds = JSON.parse(localStorage.getItem(NOTE_REMINDERS_DISMISSED_KEY) || "{}"); }
  catch { dismissedReminderIds = {}; }
  return dismissedReminderIds;
}
export function saveDismissedReminders() { persist(); }

export function updateContact(id, newData) {
  const idx = contacts.findIndex(c => c.id === id);
  if (idx !== -1) {
    contacts[idx] = { ...contacts[idx], ...newData };
    saveContacts();
    return true;
  }
  return false;
}

export function deleteContact(id) {
  contacts = contacts.filter(c => c.id !== id);
  saveContacts();
  delete calledCounts[id];
  saveCalledCounts();
  delete contactRowStatus[id];
  saveContactRowStatus();
  delete callDurations[id];
  saveCallDurations();
}

export function setActiveList(name) {
  activeList = name;
  persist();
}

export function addList(name) {
  if (!lists.includes(name)) {
    lists.push(name);
    saveLists();
  }
}

export function deleteList(name) {
  if (name === "Principal") return;
  const removedIds = contacts.filter(c => c.list === name).map(c => c.id);
  contacts = contacts.filter(c => c.list !== name);
  for (const id of removedIds) {
    delete calledCounts[id];
    delete contactRowStatus[id];
    delete callDurations[id];
    delete dismissedReminderIds[id];
  }
  lists = lists.filter(l => l !== name);
  saveLists();
  saveContacts();
  saveCalledCounts();
  saveContactRowStatus();
  saveCallDurations();
  saveDismissedReminders();
  if (activeList === name) activeList = "Principal";
}

export function addContact(contact, listName = "Principal") {
  return addContacts([contact], listName);
}

export function addContacts(contactList, listName = "Principal") {
  const existingPhones = new Set(contacts.filter(c => c.list === listName).map(c => String(c.phone || "").replace(/\D/g, "")));
  const processed = contactList
    .map(c => ({ ...c, list: listName }))
    .filter(c => {
      const phone = String(c.phone || "").replace(/\D/g, "");
      if (phone.length < 6 || phone.length > 15 || existingPhones.has(phone)) return false;
      existingPhones.add(phone);
      return true;
    });
  contacts = [...processed, ...contacts];
  saveContacts();
  return processed.length;
}

export function clearAllContacts() {
  contacts = [];
  calledCounts = {};
  contactRowStatus = {};
  callDurations = {};
  dismissedReminderIds = {};
  saveContacts();
  saveCalledCounts();
  saveContactRowStatus();
  saveCallDurations();
  saveDismissedReminders();
}
