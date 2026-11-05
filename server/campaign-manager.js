import { nanoid } from "nanoid";

const ACTIVE_STATES = new Set(["dialing", "ringing", "in_call"]);
const ALLOWED_RESULTS = new Set([
  "contesto",
  "interesado",
  "no_interesado",
  "requiere_asesor",
  "sin_respuesta",
  "no_contactado",
  "numero_incorrecto",
  "reintentar",
  "agendado"
]);

const DEFAULT_CAMPAIGN = () => ({
  _normalizedVersion: 2,
  status: "idle",
  listName: "",
  contacts: [],
  assignments: {},
  pausedWorkerIds: [],
  callbacks: [],
  history: [],
  maxAttempts: 2,
  activeContactId: null,
  activeWorkerId: null,
  activeWorkerSocketId: null,
  lastError: "",
  updatedAt: Date.now(),
  startedAt: null,
  pausedAt: null,
  completedAt: null
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeResult(value) {
  const result = String(value || "").trim();
  return ALLOWED_RESULTS.has(result) ? result : "sin_respuesta";
}

function normalizeAttempt(input = {}) {
  return {
    id: String(input.id || nanoid()).trim(),
    number: Number(input.number || 1),
    workerId: String(input.workerId || "").trim(),
    workerName: String(input.workerName || "").trim(),
    startedAt: input.startedAt || null,
    ringingAt: input.ringingAt || null,
    answeredAt: input.answeredAt || null,
    endedAt: input.endedAt || null,
    durationSeconds: Math.max(0, Number(input.durationSeconds || 0)),
    technicalResult: String(input.technicalResult || "").trim(),
    disposition: String(input.disposition || "").trim(),
    lastError: String(input.lastError || "").trim()
  };
}

function normalizeContact(input = {}) {
  let id = String(input.id || "").trim();
  const rawPhone = String(input.phone || "").trim();
  if (!rawPhone || /\p{L}/u.test(rawPhone)) return null;
  let phone = rawPhone.replace(/\D/g, "");
  if (phone.length === 11 && phone.startsWith("51")) phone = phone.slice(2);
  if (!/^\d{9}$/.test(phone)) return null;
  if (!id) id = nanoid();

  return {
    id,
    name: String(input.name || "").trim() || "Contacto",
    phone,
    note: String(input.note || "").trim(),
    list: String(input.list || "").trim(),
    targetWorkerId: String(input.targetWorkerId || "").trim(),
    status: String(input.status || "pending").trim(),
    result: String(input.result || "").trim(),
    technicalResult: String(input.technicalResult || "").trim(),
    attempts: Math.max(0, Number(input.attempts || 0)),
    attemptHistory: Array.isArray(input.attemptHistory) ? input.attemptHistory.map(normalizeAttempt) : [],
    currentAttemptId: String(input.currentAttemptId || "").trim(),
    lastAttemptAt: input.lastAttemptAt || null,
    answeredAt: input.answeredAt || null,
    completedAt: input.completedAt || null,
    durationSeconds: Math.max(0, Number(input.durationSeconds || 0)),
    assignedWorkerId: input.assignedWorkerId || null,
    assignedWorkerName: String(input.assignedWorkerName || "").trim(),
    assignedAdvisor: String(input.assignedAdvisor || "").trim(),
    callbackReason: String(input.callbackReason || "").trim(),
    transcriptSummary: String(input.transcriptSummary || "").trim()
  };
}

function syncLegacyActiveFields(campaign) {
  const first = Object.values(campaign.assignments || {})[0] || null;
  campaign.activeContactId = first?.contactId || null;
  campaign.activeWorkerId = first?.workerId || null;
  campaign.activeWorkerSocketId = first?.workerSocketId || null;
}

function activeAttempt(contact) {
  return contact.attemptHistory.find((attempt) => attempt.id === contact.currentAttemptId)
    || contact.attemptHistory.at(-1)
    || null;
}

export function getActiveAttemptId(session, workerId) {
  const contact = getContactByWorker(session, String(workerId || "").trim());
  return contact ? String(activeAttempt(contact)?.id || "") : "";
}

function releaseAssignment(campaign, workerId, contact) {
  if (workerId && campaign.assignments[workerId]) delete campaign.assignments[workerId];
  if (contact) {
    contact.assignedWorkerId = null;
    contact.assignedWorkerName = "";
    contact.currentAttemptId = "";
  }
  syncLegacyActiveFields(campaign);
}

function appendHistory(campaign, contact, attempt) {
  if (!attempt || campaign.history.some((item) => item.attemptId === attempt.id)) return;
  campaign.history.push({
    attemptId: attempt.id,
    contactId: contact.id,
    name: contact.name,
    phone: contact.phone,
    list: contact.list || campaign.listName || "",
    workerId: attempt.workerId,
    workerName: attempt.workerName,
    attemptNumber: attempt.number,
    startedAt: attempt.startedAt,
    answeredAt: attempt.answeredAt,
    endedAt: attempt.endedAt,
    durationSeconds: attempt.durationSeconds,
    technicalResult: attempt.technicalResult,
    disposition: attempt.disposition || contact.result || ""
  });
}

function finalizeAttempt(campaign, contact, attempt, disposition = "") {
  if (!attempt) return;
  const endedAt = attempt.endedAt || nowIso();
  attempt.endedAt = endedAt;
  if (attempt.answeredAt) {
    attempt.durationSeconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(attempt.answeredAt)) / 1000));
    attempt.technicalResult = attempt.technicalResult || "contesto";
  } else {
    attempt.durationSeconds = 0;
    attempt.technicalResult = attempt.technicalResult || (contact.attempts < campaign.maxAttempts ? "sin_respuesta" : "no_contactado");
  }
  if (disposition) attempt.disposition = disposition;
  contact.durationSeconds = attempt.durationSeconds;
  contact.technicalResult = attempt.technicalResult;
  appendHistory(campaign, contact, attempt);
  const historyEntry = campaign.history.find((item) => item.attemptId === attempt.id);
  if (historyEntry) {
    historyEntry.endedAt = attempt.endedAt;
    historyEntry.durationSeconds = attempt.durationSeconds;
    historyEntry.technicalResult = attempt.technicalResult;
    historyEntry.disposition = attempt.disposition || contact.result || "";
  }
}

export function ensureCampaign(session) {
  if (session.campaign?._normalizedVersion === 2) return session.campaign;
  const existing = session.campaign && typeof session.campaign === "object" ? session.campaign : {};
  const base = DEFAULT_CAMPAIGN();
  const contacts = Array.isArray(existing.contacts)
    ? existing.contacts.map(normalizeContact).filter(Boolean)
    : [];
  const assignments = existing.assignments && typeof existing.assignments === "object"
    ? { ...existing.assignments }
    : {};

  // Migrate the previous single-active-contact representation.
  if (!Object.keys(assignments).length && existing.activeContactId && existing.activeWorkerId) {
    const contact = contacts.find((item) => item.id === existing.activeContactId);
    if (contact && ACTIVE_STATES.has(contact.status)) {
      assignments[existing.activeWorkerId] = {
        workerId: existing.activeWorkerId,
        workerSocketId: existing.activeWorkerSocketId || null,
        contactId: contact.id,
        assignedAt: contact.lastAttemptAt || nowIso()
      };
    }
  }

  session.campaign = {
    ...base,
    ...existing,
    contacts,
    assignments,
    pausedWorkerIds: [...new Set(Array.isArray(existing.pausedWorkerIds) ? existing.pausedWorkerIds.map(String) : [])],
    callbacks: Array.isArray(existing.callbacks) ? existing.callbacks : [],
    history: Array.isArray(existing.history) ? existing.history : [],
    maxAttempts: Math.max(1, Number(existing.maxAttempts || 2))
  };
  syncLegacyActiveFields(session.campaign);
  return session.campaign;
}

export function syncCampaignContacts(session, contacts = [], options = {}) {
  const campaign = ensureCampaign(session);
  const seenIds = new Set();
  campaign.contacts = contacts.map((contact) => normalizeContact(contact)).filter((contact) => {
    if (!contact || seenIds.has(contact.id)) return false;
    seenIds.add(contact.id);
    return true;
  });
  campaign.assignments = {};
  campaign.pausedWorkerIds = [];
  campaign.history = [];
  campaign.listName = String(options.listName || "").trim();
  campaign.maxAttempts = Math.min(5, Math.max(1, Number(options.maxAttempts || 2)));
  campaign.completedAt = null;
  campaign.lastError = "";
  campaign.updatedAt = Date.now();
  syncLegacyActiveFields(campaign);
  return campaign;
}

export function getCampaignSnapshot(session) {
  const campaign = ensureCampaign(session);
  const counts = {
    pending: 0,
    retry_pending: 0,
    dialing: 0,
    ringing: 0,
    in_call: 0,
    awaiting_callback: 0,
    completed: 0,
    failed: 0
  };
  for (const contact of campaign.contacts) {
    if (counts[contact.status] !== undefined) counts[contact.status] += 1;
  }
  return {
    status: campaign.status,
    listName: campaign.listName,
    maxAttempts: campaign.maxAttempts,
    assignments: campaign.assignments,
    pausedWorkerIds: campaign.pausedWorkerIds,
    activeContactId: campaign.activeContactId,
    activeWorkerId: campaign.activeWorkerId,
    activeWorkerSocketId: campaign.activeWorkerSocketId,
    lastError: campaign.lastError,
    updatedAt: campaign.updatedAt,
    startedAt: campaign.startedAt,
    pausedAt: campaign.pausedAt,
    completedAt: campaign.completedAt,
    counts,
    contacts: campaign.contacts,
    callbacks: campaign.callbacks,
    history: campaign.history
  };
}

export function startCampaign(session, contacts = [], options = {}) {
  const campaign = contacts.length ? syncCampaignContacts(session, contacts, options) : ensureCampaign(session);
  campaign.status = "running";
  campaign.startedAt = nowIso();
  campaign.pausedAt = null;
  campaign.completedAt = null;
  campaign.lastError = "";
  campaign.updatedAt = Date.now();
  return campaign;
}

export function pauseCampaign(session) {
  const campaign = ensureCampaign(session);
  campaign.status = "paused";
  campaign.pausedAt = nowIso();
  campaign.updatedAt = Date.now();
  return campaign;
}

export function resumeCampaign(session) {
  const campaign = ensureCampaign(session);
  campaign.status = "running";
  campaign.pausedAt = null;
  campaign.updatedAt = Date.now();
  return campaign;
}

export function stopCampaign(session) {
  const campaign = ensureCampaign(session);
  campaign.status = "completed";
  campaign.completedAt = nowIso();
  campaign.updatedAt = Date.now();
  return campaign;
}

export function resetCampaignForShift(session) {
  session.campaign = DEFAULT_CAMPAIGN();
  return session.campaign;
}

export function resetCampaignOperation(session) {
  const campaign = ensureCampaign(session);
  for (const contact of campaign.contacts) {
    if (ACTIVE_STATES.has(contact.status) || contact.status === "held") {
      const attempt = activeAttempt(contact);
      if (attempt && !attempt.endedAt) {
        contact.attemptHistory = contact.attemptHistory.filter((item) => item.id !== attempt.id);
        contact.attempts = Math.max(0, contact.attempts - 1);
      }
      contact.status = contact.attempts ? "retry_pending" : "pending";
      contact.result = "";
      contact.technicalResult = "";
      contact.answeredAt = null;
      contact.durationSeconds = 0;
      contact.completedAt = null;
    }
    if (!["completed", "failed", "awaiting_callback"].includes(contact.status)) {
      contact.targetWorkerId = "";
      contact.assignedWorkerId = null;
      contact.assignedWorkerName = "";
      contact.currentAttemptId = "";
    }
  }
  campaign.assignments = {};
  campaign.pausedWorkerIds = [];
  campaign.status = campaign.contacts.some((contact) => !["completed", "failed", "awaiting_callback"].includes(contact.status))
    ? "paused"
    : campaign.status;
  campaign.activeContactId = null;
  campaign.activeWorkerId = null;
  campaign.activeWorkerSocketId = null;
  campaign.pausedAt = nowIso();
  campaign.updatedAt = Date.now();
  return campaign;
}

export function setWorkerPaused(session, workerId, paused) {
  const campaign = ensureCampaign(session);
  const ids = new Set(campaign.pausedWorkerIds);
  if (paused) ids.add(String(workerId));
  else ids.delete(String(workerId));
  campaign.pausedWorkerIds = [...ids];
  campaign.updatedAt = Date.now();
  return campaign;
}

export function isWorkerPaused(session, workerId) {
  return ensureCampaign(session).pausedWorkerIds.includes(String(workerId));
}

export function getContactById(session, contactId) {
  return ensureCampaign(session).contacts.find((contact) => contact.id === contactId) || null;
}

export function getActiveContacts(session) {
  const campaign = ensureCampaign(session);
  return Object.values(campaign.assignments)
    .map((assignment) => getContactById(session, assignment.contactId))
    .filter(Boolean);
}

export function getActiveContact(session) {
  return getActiveContacts(session)[0] || null;
}

export function getContactByWorker(session, workerId) {
  const campaign = ensureCampaign(session);
  const assignment = campaign.assignments[String(workerId)];
  return assignment ? getContactById(session, assignment.contactId) : null;
}

export function pickNextContact(session, workerId = "") {
  const campaign = ensureCampaign(session);
  const normalizedWorkerId = String(workerId || "").trim();
  const targetedMode = campaign.contacts.some((contact) => Boolean(contact.targetWorkerId));
  const eligible = (contact) => !normalizedWorkerId || !targetedMode || contact.targetWorkerId === normalizedWorkerId;
  // Complete the first round before retrying unanswered contacts.
  let next = campaign.contacts.find((contact) => eligible(contact) && contact.status === "pending")
    || campaign.contacts.find((contact) => eligible(contact) && contact.status === "retry_pending")
    || null;
  if (!next && normalizedWorkerId && targetedMode) {
    const unclaimed = campaign.contacts.find((contact) =>
      !contact.targetWorkerId && ["pending", "retry_pending"].includes(contact.status)
    );
    if (unclaimed) {
      const nextList = unclaimed.list;
      campaign.contacts.forEach((contact) => {
        if (!contact.targetWorkerId && contact.list === nextList) contact.targetWorkerId = normalizedWorkerId;
      });
      next = campaign.contacts.find((contact) => eligible(contact) && contact.status === "pending")
        || campaign.contacts.find((contact) => eligible(contact) && contact.status === "retry_pending")
        || null;
    }
  }
  return next;
}

export function assignNextContact(session, worker = {}) {
  const campaign = ensureCampaign(session);
  const workerId = String(worker.id || "").trim();
  if (!workerId || campaign.status !== "running" || isWorkerPaused(session, workerId)) return null;
  if (campaign.assignments[workerId]) return getContactByWorker(session, workerId);

  const next = pickNextContact(session, workerId);
  if (!next) {
    const workRemaining = campaign.contacts.some((contact) => ["pending", "retry_pending", "held"].includes(contact.status));
    if (!Object.keys(campaign.assignments).length && !workRemaining) {
      campaign.status = "completed";
      campaign.completedAt = nowIso();
    }
    campaign.updatedAt = Date.now();
    return null;
  }

  const startedAt = nowIso();
  const attempt = normalizeAttempt({
    number: next.attempts + 1,
    workerId,
    workerName: worker.name || workerId,
    startedAt
  });
  next.status = "dialing";
  next.result = "";
  next.technicalResult = "";
  next.attempts += 1;
  next.lastAttemptAt = startedAt;
  next.completedAt = null;
  next.answeredAt = null;
  next.durationSeconds = 0;
  next.assignedWorkerId = workerId;
  next.assignedWorkerName = worker.name || workerId;
  next.currentAttemptId = attempt.id;
  next.attemptHistory.push(attempt);
  campaign.assignments[workerId] = {
    workerId,
    workerName: worker.name || workerId,
    workerSocketId: worker.socketId || null,
    contactId: next.id,
    attemptId: attempt.id,
    assignedAt: startedAt
  };
  campaign.lastError = "";
  campaign.updatedAt = Date.now();
  syncLegacyActiveFields(campaign);
  return next;
}

export function assignSpecificContact(session, worker = {}, contactId = "") {
  const campaign = ensureCampaign(session);
  const workerId = String(worker.id || "").trim();
  const requestedId = String(contactId || "").trim();
  if (!workerId || !requestedId || campaign.assignments[workerId]) return null;
  const contact = campaign.contacts.find((item) => item.id === requestedId);
  if (!contact || (contact.targetWorkerId && contact.targetWorkerId !== workerId)) return null;
  const assignedElsewhere = Object.values(campaign.assignments).some((assignment) => assignment.contactId === requestedId);
  if (assignedElsewhere) return null;

  const startedAt = nowIso();
  const attempt = normalizeAttempt({
    number: contact.attempts + 1,
    workerId,
    workerName: worker.name || workerId,
    startedAt
  });
  contact.status = "dialing";
  contact.result = "";
  contact.technicalResult = "";
  contact.attempts += 1;
  contact.lastAttemptAt = startedAt;
  contact.completedAt = null;
  contact.answeredAt = null;
  contact.durationSeconds = 0;
  contact.assignedWorkerId = workerId;
  contact.assignedWorkerName = worker.name || workerId;
  contact.currentAttemptId = attempt.id;
  contact.attemptHistory.push(attempt);
  campaign.assignments[workerId] = {
    workerId,
    workerName: worker.name || workerId,
    workerSocketId: worker.socketId || null,
    contactId: contact.id,
    attemptId: attempt.id,
    assignedAt: startedAt
  };
  campaign.status = "running";
  campaign.completedAt = null;
  campaign.updatedAt = Date.now();
  syncLegacyActiveFields(campaign);
  return contact;
}

export function ensureCampaignContact(session, input = {}) {
  const campaign = ensureCampaign(session);
  const requestedId = String(input.id || "").trim();
  let contact = requestedId ? campaign.contacts.find((item) => item.id === requestedId) : null;
  if (contact) {
    if (input.targetWorkerId) contact.targetWorkerId = String(input.targetWorkerId).trim();
    return contact;
  }
  contact = normalizeContact(input);
  if (!contact) return null;
  campaign.contacts.push(contact);
  campaign.updatedAt = Date.now();
  return contact;
}

export function holdActiveContact(session, workerId) {
  const campaign = ensureCampaign(session);
  const normalizedWorkerId = String(workerId || "").trim();
  const contact = getContactByWorker(session, normalizedWorkerId);
  if (!contact) return null;
  const attempt = activeAttempt(contact);
  if (attempt && !attempt.endedAt) {
    contact.attemptHistory = contact.attemptHistory.filter((item) => item.id !== attempt.id);
    contact.attempts = Math.max(0, contact.attempts - 1);
  }
  contact.status = "held";
  contact.result = "";
  contact.technicalResult = "";
  contact.answeredAt = null;
  contact.durationSeconds = 0;
  contact.heldAt = nowIso();
  releaseAssignment(campaign, normalizedWorkerId, contact);
  campaign.updatedAt = Date.now();
  return contact;
}

export function resumeHeldContact(session, workerId) {
  const campaign = ensureCampaign(session);
  const contact = campaign.contacts.find((item) => item.targetWorkerId === String(workerId) && item.status === "held");
  if (contact) contact.status = "pending";
  campaign.updatedAt = Date.now();
  return contact || null;
}

export function switchWorkerList(session, workerId, currentList, nextList) {
  const campaign = ensureCampaign(session);
  const normalizedWorkerId = String(workerId || "").trim();
  const fromList = String(currentList || "").trim();
  const toList = String(nextList || "").trim();
  if (!normalizedWorkerId || !fromList || !toList || fromList === toList) {
    return { ok: false, error: "La asignacion de listas no es valida" };
  }

  const unfinished = (contact) => !["completed", "failed", "awaiting_callback"].includes(String(contact.status || ""));
  const targetContacts = campaign.contacts.filter((contact) => contact.list === toList && unfinished(contact));
  if (!targetContacts.length) return { ok: false, error: "La siguiente lista no tiene contactos pendientes" };
  if (targetContacts.some((contact) => contact.targetWorkerId && contact.targetWorkerId !== normalizedWorkerId)) {
    return { ok: false, error: "La siguiente lista ya esta ocupada por otro equipo" };
  }

  const active = getContactByWorker(session, normalizedWorkerId);
  if (active) holdActiveContact(session, normalizedWorkerId);
  for (const contact of campaign.contacts) {
    if (!unfinished(contact)) continue;
    if (contact.targetWorkerId === normalizedWorkerId) {
      contact.targetWorkerId = "";
      if (contact.status === "held") contact.status = contact.attempts ? "retry_pending" : "pending";
      contact.assignedWorkerId = null;
      contact.assignedWorkerName = "";
      contact.currentAttemptId = "";
    }
  }
  for (const contact of targetContacts) contact.targetWorkerId = normalizedWorkerId;
  campaign.completedAt = null;
  campaign.updatedAt = Date.now();
  syncLegacyActiveFields(campaign);
  return { ok: true, activeContact: active || null, currentList: fromList, nextList: toList };
}

export function updateActiveCallState(session, state, worker = {}, extras = {}) {
  const campaign = ensureCampaign(session);
  const workerId = String(worker.id || "").trim();
  const assignment = workerId ? campaign.assignments[workerId] : null;
  if (extras.contactId && assignment && assignment.contactId !== String(extras.contactId)) return null;
  const contact = workerId ? getContactByWorker(session, workerId) : getActiveContact(session);
  if (!contact) return null;
  const attempt = activeAttempt(contact);
  const normalizedState = String(state || "").trim();
  const reportedAttemptId = String(extras.callId || extras.attemptId || "").trim();
  if (reportedAttemptId && attempt?.id && reportedAttemptId !== attempt.id) return null;

  if (normalizedState === "dialing" || normalizedState === "ringing" || normalizedState === "in_call") {
    contact.status = normalizedState;
    if (attempt && normalizedState === "ringing" && !attempt.ringingAt) attempt.ringingAt = nowIso();
    if (attempt && normalizedState === "in_call" && !attempt.answeredAt) {
      attempt.answeredAt = nowIso();
      contact.answeredAt = attempt.answeredAt;
    }
    campaign.updatedAt = Date.now();
    return contact;
  }

  // Android can emit a transient `idle` while Telecom is still establishing
  // or carrying the managed call. Only explicit terminal states may release
  // the worker and advance its queue.
  if ((normalizedState === "ended" || normalizedState === "failed") && ACTIVE_STATES.has(contact.status)) {
    const endedAt = nowIso();
    if (attempt) {
      attempt.endedAt = endedAt;
      attempt.lastError = String(extras.lastError || "").trim();
      if (attempt.answeredAt) {
        attempt.durationSeconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(attempt.answeredAt)) / 1000));
        attempt.technicalResult = "contesto";
        contact.status = "completed";
        contact.result = contact.result || "contesto";
        contact.technicalResult = "contesto";
      } else if (contact.attempts < campaign.maxAttempts) {
        attempt.technicalResult = "sin_respuesta";
        contact.status = "retry_pending";
        contact.result = "reintentar";
        contact.technicalResult = "sin_respuesta";
      } else {
        attempt.technicalResult = "no_contactado";
        contact.status = "failed";
        contact.result = "no_contactado";
        contact.technicalResult = "no_contactado";
      }
      contact.durationSeconds = attempt.durationSeconds;
      contact.completedAt = contact.status === "retry_pending" ? null : endedAt;
      appendHistory(campaign, contact, attempt);
    }
    releaseAssignment(campaign, workerId || contact.assignedWorkerId, contact);
    campaign.updatedAt = Date.now();
  }
  return contact;
}

export function markContactResult(session, contactId, result, extras = {}) {
  const campaign = ensureCampaign(session);
  const contact = getContactById(session, contactId);
  if (!contact) return null;
  const normalizedResult = normalizeResult(result);
  const attempt = activeAttempt(contact);
  if (normalizedResult === "sin_respuesta" && attempt) {
    attempt.answeredAt = null;
    attempt.technicalResult = "";
    contact.answeredAt = null;
  }
  contact.result = normalizedResult;
  contact.assignedAdvisor = String(extras.assignedAdvisor || contact.assignedAdvisor || "").trim();
  contact.callbackReason = String(extras.callbackReason || contact.callbackReason || "").trim();
  contact.transcriptSummary = String(extras.transcriptSummary || contact.transcriptSummary || "").trim();

  if (normalizedResult === "reintentar") {
    contact.status = contact.attempts ? "retry_pending" : "pending";
    contact.completedAt = null;
  } else if (normalizedResult === "requiere_asesor") {
    contact.status = "awaiting_callback";
    contact.completedAt = nowIso();
    registerCallback(session, {
      contactId: contact.id,
      name: contact.name,
      phone: contact.phone,
      note: contact.note,
      reason: contact.callbackReason || "Solicitó asesor",
      advisor: contact.assignedAdvisor || ""
    });
  } else if (["sin_respuesta", "no_contactado"].includes(normalizedResult)) {
    contact.status = normalizedResult === "sin_respuesta" && contact.attempts < campaign.maxAttempts ? "retry_pending" : "failed";
    contact.completedAt = contact.status === "failed" ? nowIso() : null;
  } else {
    contact.status = "completed";
    contact.completedAt = nowIso();
  }

  if (attempt) {
    finalizeAttempt(campaign, contact, attempt, normalizedResult);
  }
  if (!ACTIVE_STATES.has(contact.status)) releaseAssignment(campaign, contact.assignedWorkerId, contact);
  campaign.updatedAt = Date.now();
  return contact;
}

export function skipActiveContact(session, workerId = "") {
  const campaign = ensureCampaign(session);
  const contact = workerId ? getContactByWorker(session, workerId) : getActiveContact(session);
  if (!contact) return null;
  contact.result = "reintentar";
  contact.status = "retry_pending";
  const attempt = activeAttempt(contact);
  finalizeAttempt(campaign, contact, attempt, "reintentar");
  contact.completedAt = null;
  releaseAssignment(campaign, contact.assignedWorkerId || workerId, contact);
  campaign.updatedAt = Date.now();
  return contact;
}

export function registerCallback(session, callback) {
  const campaign = ensureCampaign(session);
  const contactId = String(callback.contactId || "").trim();
  if (!contactId) return null;
  const existing = campaign.callbacks.find((item) => item.contactId === contactId);
  if (existing) {
    Object.assign(existing, callback, { contactId, updatedAt: nowIso() });
    campaign.updatedAt = Date.now();
    return existing;
  }
  const entry = {
    contactId,
    name: String(callback.name || "").trim(),
    phone: String(callback.phone || "").trim(),
    note: String(callback.note || "").trim(),
    reason: String(callback.reason || "").trim(),
    advisor: String(callback.advisor || "").trim(),
    createdAt: callback.createdAt || nowIso(),
    status: String(callback.status || "pending").trim()
  };
  campaign.callbacks.unshift(entry);
  campaign.updatedAt = Date.now();
  return entry;
}

export function completeCallback(session, contactId) {
  const campaign = ensureCampaign(session);
  const callback = campaign.callbacks.find((item) => item.contactId === contactId);
  if (!callback) return null;
  callback.status = "completed";
  campaign.updatedAt = Date.now();
  return callback;
}
