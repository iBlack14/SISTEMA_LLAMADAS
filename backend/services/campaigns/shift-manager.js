import { nanoid } from "nanoid";

const TIME_ZONE = "America/Lima";
const WORK_SHIFT_TYPES = new Set(["morning", "afternoon"]);

function limaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

export function detectWorkShift(date = new Date()) {
  const local = limaParts(date);
  const minutes = local.hour * 60 + local.minute;
  if (minutes >= 7 * 60 && minutes < 13 * 60 + 30) {
    return { type: "morning", label: "TURNO MAÑANA", schedule: "7:00 a. m. - 2:00 p. m.", ...local };
  }
  if (minutes >= 13 * 60 + 30 && minutes < 20 * 60 + 30) {
    return { type: "afternoon", label: "TURNO TARDE", schedule: "1:30 p. m. - 8:30 p. m.", ...local };
  }
  const next = minutes < 7 * 60
    ? { nextLabel: "TURNO MAÑANA", nextSchedule: "7:00 a. m. - 2:00 p. m." }
    : { nextLabel: "TURNO MAÑANA", nextSchedule: "7:00 a. m. - 2:00 p. m. (día siguiente)" };
  return { type: "outside", label: "FUERA DE TURNO", schedule: next.nextSchedule, ...next, ...local };
}

function pendingKey(contact = {}) {
  return `${String(contact.list || "Principal").trim().toLowerCase()}|${String(contact.phone || "").replace(/\D/g, "")}`;
}

function normalizePending(contact = {}) {
  return {
    id: String(contact.id || nanoid()),
    sourceContactId: String(contact.sourceContactId || contact.id || ""),
    list: String(contact.list || "Principal").trim() || "Principal",
    name: String(contact.name || "Sin nombre").trim() || "Sin nombre",
    phone: String(contact.phone || "").replace(/\D/g, ""),
    totalAttempts: Math.max(0, Number(contact.totalAttempts ?? contact.attempts ?? 0)),
    carryAttempts: Math.max(0, Number(contact.carryAttempts || 0)),
    recoveryAttempts: Math.max(0, Number(contact.recoveryAttempts || 0)),
    originTurnId: String(contact.originTurnId || ""),
    originTurnLabel: String(contact.originTurnLabel || ""),
    originDate: String(contact.originDate || ""),
    lastAttemptAt: contact.lastAttemptAt || null,
    lastWorkerName: String(contact.lastWorkerName || contact.assignedWorkerName || ""),
    status: String(contact.status || "pending_next_shift")
  };
}

export function ensureShiftManagement(session, date = new Date()) {
  const existing = session.shiftManagement && typeof session.shiftManagement === "object"
    ? session.shiftManagement
    : {};
  session.shiftManagement = {
    timezone: TIME_ZONE,
    schedules: {
      morning: "07:00-14:00",
      afternoon: "13:30-20:30"
    },
    current: existing.current || null,
    history: Array.isArray(existing.history) ? existing.history : [],
    pendingContacts: Array.isArray(existing.pendingContacts)
      ? existing.pendingContacts.map(normalizePending).filter((item) => item.phone)
      : [],
    currentReport: Array.isArray(existing.currentReport) ? existing.currentReport : [],
    closedContacts: Array.isArray(existing.closedContacts) ? existing.closedContacts : [],
    sessionHistory: Array.isArray(existing.sessionHistory) ? existing.sessionHistory : [],
    sessionId: String(existing.sessionId || nanoid(12)),
    sessionStartedAt: existing.sessionStartedAt || new Date().toISOString(),
    lastFinalizedWindowKey: String(existing.lastFinalizedWindowKey || ""),
    lastSessionEndedAt: existing.lastSessionEndedAt || null
  };

  const detected = detectWorkShift(date);
  const windowKey = `${detected.date}|${detected.type}`;
  if (!session.shiftManagement.current
      && WORK_SHIFT_TYPES.has(detected.type)
      && session.shiftManagement.lastFinalizedWindowKey !== windowKey) {
    session.shiftManagement.current = {
      id: nanoid(12),
      type: detected.type,
      label: detected.label,
      date: detected.date,
      schedule: detected.schedule,
      status: "active",
      startedAt: new Date().toISOString()
    };
  }
  return session.shiftManagement;
}

export function syncPendingContacts(session, campaign, date = new Date()) {
  const management = ensureShiftManagement(session, date);
  const report = new Map(management.currentReport.map((item, index) => [
    String(item.attemptId || [item.list, item.phone, item.workerId, item.attemptNumber, item.startedAt, index].join("|")),
    item
  ]));
  for (const [index, item] of (campaign?.history || []).entries()) {
    const key = String(item.attemptId || [item.list, item.phone, item.workerId, item.attemptNumber, item.startedAt, index].join("|"));
    report.set(key, { ...item });
  }
  management.currentReport = [...report.values()];
  const pending = new Map(management.pendingContacts.map((item) => [pendingKey(item), item]));
  for (const contact of campaign?.contacts || []) {
    const key = pendingKey(contact);
    if (!contact.phone || key.endsWith("|")) continue;
    const answered = contact.status === "completed"
      || contact.technicalResult === "contesto"
      || contact.result === "contesto";
    const neverAnswered = contact.status === "failed"
      || contact.technicalResult === "no_contactado"
      || contact.result === "no_contactado";
    if (answered) {
      pending.delete(key);
    } else if (neverAnswered) {
      const previous = pending.get(key);
      if (campaign?.listName === "Pendientes del turno") {
        pending.set(key, normalizePending({
          ...previous,
          ...contact,
          id: previous?.id || nanoid(),
          sourceContactId: previous?.sourceContactId || contact.id,
          recoveryAttempts: Math.max(2, Number(previous?.recoveryAttempts || 0), Number(contact.attempts || 0)),
          totalAttempts: Math.max(Number(previous?.totalAttempts || 0), Number(contact.attempts || 0)),
          lastAttemptAt: contact.lastAttemptAt,
          lastWorkerName: contact.assignedWorkerName || previous?.lastWorkerName || "",
          status: "exhausted"
        }));
        continue;
      }
      pending.set(key, normalizePending({
        ...previous,
        id: previous?.id || nanoid(),
        sourceContactId: contact.id,
        list: contact.list,
        name: contact.name,
        phone: contact.phone,
        totalAttempts: Math.max(Number(previous?.totalAttempts || 0), Number(contact.attempts || 0)),
        carryAttempts: Number(previous?.carryAttempts || 0),
        originTurnId: previous?.originTurnId || management.current?.id || "",
        originTurnLabel: previous?.originTurnLabel || management.current?.label || "",
        originDate: previous?.originDate || management.current?.date || detectWorkShift(date).date,
        lastAttemptAt: contact.lastAttemptAt,
        lastWorkerName: contact.assignedWorkerName || previous?.lastWorkerName || "",
        status: "pending_next_shift"
      }));
    }
  }
  management.pendingContacts = [...pending.values()];
  return management.pendingContacts;
}

function campaignCounts(campaign = {}) {
  const counts = { total: 0, answered: 0, failed: 0, unfinished: 0 };
  for (const contact of campaign.contacts || []) {
    counts.total += 1;
    if (contact.status === "completed" || contact.technicalResult === "contesto") counts.answered += 1;
    else if (contact.status === "failed" || contact.technicalResult === "no_contactado") counts.failed += 1;
    else counts.unfinished += 1;
  }
  return counts;
}

export function finalizeCurrentTurn(session, campaign, date = new Date()) {
  ensureShiftManagement(session, date);
  syncPendingContacts(session, campaign, date);
  const management = ensureShiftManagement(session, date);
  if (!management.current) return null;
  const detected = detectWorkShift(date);
  const record = {
    ...management.current,
    status: "completed",
    endedAt: new Date().toISOString(),
    summary: campaignCounts(campaign),
    report: management.currentReport.map((item) => ({ ...item })),
    unfinishedContacts: (campaign?.contacts || [])
      .filter((contact) => ["pending", "retry_pending", "held"].includes(contact.status))
      .map((contact) => ({ id: contact.id, list: contact.list, name: contact.name, phone: contact.phone, status: contact.status }))
  };
  management.history.unshift(record);
  management.history = management.history.slice(0, 60);
  management.currentReport = [];
  management.current = null;
  management.lastFinalizedWindowKey = `${detected.date}|${management.current?.type || record.type}`;
  return record;
}

export function finalizeCurrentSession(session, date = new Date()) {
  const management = ensureShiftManagement(session, date);
  const record = {
    id: management.sessionId,
    startedAt: management.sessionStartedAt,
    endedAt: new Date().toISOString(),
    turnCount: management.history.length,
    pendingCount: management.pendingContacts.length
  };
  management.sessionHistory.unshift(record);
  management.sessionHistory = management.sessionHistory.slice(0, 60);
  management.lastSessionEndedAt = record.endedAt;
  management.sessionId = nanoid(12);
  management.sessionStartedAt = new Date().toISOString();
  return record;
}

export function markPendingCampaignStarted(session, contacts = []) {
  const management = ensureShiftManagement(session);
  const pending = new Map(management.pendingContacts.map((contact) => [pendingKey(contact), contact]));
  for (const contact of contacts) {
    const key = pendingKey(contact);
    if (!contact.phone || key.endsWith("|")) continue;
    const previous = pending.get(key);
    pending.set(key, normalizePending({
      ...previous,
      ...contact,
      id: previous?.id || contact.id || nanoid(),
      carryAttempts: Number(previous?.carryAttempts || 0) + 1,
      status: "calling_again"
    }));
  }
  management.pendingContacts = [...pending.values()];
}

export function getShiftSnapshot(session, date = new Date()) {
  const management = ensureShiftManagement(session, date);
  const detected = detectWorkShift(date);
  return {
    timezone: management.timezone,
    detected,
    current: management.current,
    pendingContacts: management.pendingContacts,
    currentReport: management.currentReport,
    history: management.history.map(({ report, unfinishedContacts, ...record }) => ({
      ...record,
      reportCount: report?.length || 0,
      unfinishedCount: unfinishedContacts?.length || 0
    })),
    sessionId: management.sessionId,
    sessionStartedAt: management.sessionStartedAt,
    lastSessionEndedAt: management.lastSessionEndedAt,
    definitiveNoContactCount: management.closedContacts.length
  };
}
