import { nanoid } from "nanoid";
import { logCampaignWaiting, logOperationalCall } from "../campaigns/operational-log.js";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeCalledPendingFromBlocks, addAttemptPhoneBlock, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../campaigns/contact-book.js";
import {
  ensureCampaign,
  getCampaignSnapshot,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  assignNextContact,
  assignSpecificContact,
  ensureCampaignContact,
  updateActiveCallState,
  markContactResult,
  skipActiveContact,
  holdActiveContact,
  resumeHeldContact,
  getActiveContact,
  getContactByWorker,
  getActiveAttemptId,
  setWorkerPaused,
  isWorkerPaused,
  resetCampaignForShift,
  resetCampaignOperation,
  switchWorkerList
} from "../campaigns/campaign-manager.js";

/**
 * createDispatcher: conserva los contratos y reglas existentes.
 * Dependencias: runtime.historyGate, runtime.io, runtime.persistence, runtime.sessions, services.allCallAttempts, services.emitCampaignState, services.emitState, services.getActivePhoneWorker, services.getConnectedPhoneWorkers, services.saveSoon.
 * Se construye una vez por proceso.
 */
export function createDispatcher(runtime, services) {
const dialDeliveries = new Map();
const confirmedDialDeliveries = new Set();
const receivedDialDeliveries = new Set();
const acknowledgedDialResults = new Set();

// Watchdog: a call that never reports a terminal state must not block a worker
// forever. These ceilings are generous enough for real calls but bound the worst
// case, so any cause (OEM battery kill, lost socket, phantom native call, lost
// ACK) degrades to "one lost contact" instead of a permanently stuck device.
const WATCHDOG_INTERVAL_MS = Number(process.env.CALL_WATCHDOG_INTERVAL_MS || 5000);
const WATCHDOG_DIALING_MS = Number(process.env.CALL_WATCHDOG_DIALING_MS || 45000);
// With the app heartbeat (phone:status every 10s while in_call) a live call keeps
// refreshing worker.lastStatusAt, so 45s of silence means the device is frozen.
// The ceiling only applies to old APKs that never send a heartbeat timestamp.
const WATCHDOG_HEARTBEAT_MS = Number(process.env.CALL_WATCHDOG_HEARTBEAT_MS || 45000);
const WATCHDOG_INCALL_CEILING_MS = Number(process.env.CALL_WATCHDOG_INCALL_CEILING_MS || 15 * 60 * 1000);
let callWatchdogTimer = null;

function rememberConfirmedDial(key) {
  confirmedDialDeliveries.add(key);
  if (confirmedDialDeliveries.size > 10000) {
    confirmedDialDeliveries.delete(confirmedDialDeliveries.values().next().value);
  }
}

function rememberDialKey(store, key) {
  store.add(key);
  if (store.size > 10000) store.delete(store.values().next().value);
}

function dialDeliveryKey(code, workerId, commandId) {
  return `${code}:${workerId}:${commandId}`;
}

function stopDialDelivery(code, workerId, commandId) {
  const key = dialDeliveryKey(code, workerId, commandId);
  const delivery = dialDeliveries.get(key);
  if (delivery?.timer) clearTimeout(delivery.timer);
  dialDeliveries.delete(key);
}

function scheduleDialDelivery(code, workerId, payload, retry = 0) {
  const commandId = String(payload.commandId || "");
  const key = dialDeliveryKey(code, workerId, commandId);
  const existing = dialDeliveries.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const delay = Math.min(5000 * (2 ** Math.min(retry, 3)), 30000);
  const delivery = { timer: null, payload, retry };
  delivery.timer = setTimeout(() => {
    if (dialDeliveries.get(key) !== delivery) return;
    if (receivedDialDeliveries.has(key)) {
      stopDialDelivery(code, workerId, commandId);
      return;
    }
    const session = runtime.sessions.get(code);
    const assignment = session?.campaign?.assignments?.[workerId];
    if (!assignment || assignment.attemptId !== payload.callId || assignment.contactId !== payload.contactId
      || runtime.persistence.hasFinishedAttempt(code, payload.callId, payload.contactId)) {
      stopDialDelivery(code, workerId, commandId);
      return;
    }
    if (session.campaign.status !== "running") {
      scheduleDialDelivery(code, workerId, payload, retry + 1);
      return;
    }
    const worker = session.phoneWorkers?.find(item => String(item.id) === String(workerId));
    if (!worker?.connected || !worker.socketId) {
      console.warn(`[CALL_DELIVERY] pendiente sesión=${String(code).slice(-2)} equipo=${String(workerId).slice(-8)} contacto=${String(payload.contactName || "sin nombre").slice(0, 40)} motivo=equipo_desconectado reintento=${retry + 1}`);
      scheduleDialDelivery(code, workerId, payload, retry + 1);
      return;
    }
    console.warn(`[CALL_DELIVERY] sin confirmación Android; reenviando orden sesión=${String(code).slice(-2)} equipo=${String(workerId).slice(-8)} intento=${String(payload.callId).slice(-8)} reintento=${retry + 1}`);
    worker.socketId && runtime.io.to(worker.socketId).emit("call:action", payload);
    scheduleDialDelivery(code, workerId, payload, retry + 1);
  }, delay);
  dialDeliveries.set(key, delivery);
}

function acknowledgeDialReceipt(code, workerId, commandId, callId) {
  const key = dialDeliveryKey(code, workerId, commandId);
  const normalizedCallId = String(callId || "");
  const assignment = runtime.sessions.get(code)?.campaign?.assignments?.[workerId];
  if (!normalizedCallId || String(commandId || "") !== `campaign-${normalizedCallId}`
    || assignment?.attemptId !== normalizedCallId) return false;
  const wasReceived = receivedDialDeliveries.has(key);
  rememberDialKey(receivedDialDeliveries, key);
  stopDialDelivery(code, workerId, commandId);
  return !wasReceived;
}

function acknowledgeDialDelivery(code, workerId, commandId, callId, accepted = true) {
  const key = dialDeliveryKey(code, workerId, commandId);
  const normalizedCallId = String(callId || "");
  const assignment = runtime.sessions.get(code)?.campaign?.assignments?.[workerId];
  if (!normalizedCallId || String(commandId || "") !== `campaign-${normalizedCallId}`
    || assignment?.attemptId !== normalizedCallId) return false;
  const wasAcknowledged = acknowledgedDialResults.has(key);
  rememberDialKey(acknowledgedDialResults, key);
  if (accepted) rememberConfirmedDial(key);
  stopDialDelivery(code, workerId, commandId);
  return !wasAcknowledged;
}

function resumeAssignedDial(code, workerId) {
  const session = runtime.sessions.get(code);
  const assignment = session?.campaign?.assignments?.[workerId];
  const worker = session?.phoneWorkers?.find(item => String(item.id) === String(workerId));
  const contact = assignment && session?.campaign?.contacts?.find(item => item.id === assignment.contactId);
  if (!assignment || !worker?.connected || !worker.socketId || !contact || contact.status !== "dialing") return false;
  const callId = String(assignment.attemptId || contact.currentAttemptId || "");
  if (!callId) return false;
  const payload = {
    action: "dial", phoneNumber: contact.phone || "", contactId: contact.id,
    contactName: contact.name || "", companyName: contact.name || "",
    callId, commandId: `campaign-${callId}`
  };
  console.warn(`[CALL_DELIVERY] reanudando orden pendiente sesión=${String(code).slice(-2)} equipo=${String(workerId).slice(-8)} contacto=${String(contact.name || "sin nombre").slice(0, 40)} progreso=${contact.attempts || 1}`);
  receivedDialDeliveries.delete(dialDeliveryKey(code, workerId, payload.commandId));
  acknowledgedDialResults.delete(dialDeliveryKey(code, workerId, payload.commandId));
  sendPersistedDial(code, worker.socketId, payload);
  return true;
}

async function sendPersistedDial(code, socketId, payload, retry = 0, startedAt = Date.now()) {
  const sessionId = String(code).slice(-2);
  const commandId = String(payload.commandId || "").slice(-8);
  const callId = String(payload.callId || "").slice(-8);
  try {
    console.info(`[CALL_TRACE] stage=server_persist_begin session=${sessionId} command=${commandId} call=${callId}`);
    console.info(`[CALL_DISPATCH] persist-before-dial session=${sessionId} worker=${socketId ? "connected" : "missing"} command=${commandId} call=${callId} retry=${retry}`);
    await runtime.persistence.save(runtime.sessions, [code], { priority: payload.action === "dial" });
    const persistedMs = Date.now() - startedAt;
    const session = runtime.sessions.get(code);
    const assignmentEntry = Object.entries(session?.campaign?.assignments || {})
      .find(([, item]) => item.attemptId === payload.callId);
    if (!assignmentEntry) {
      console.warn(`[CALL_DISPATCH] not sent session=${sessionId} reason=assignment_changed command=${commandId} call=${callId} persistMs=${persistedMs}`);
      return;
    }
    const [workerId] = assignmentEntry;
    const worker = session.phoneWorkers?.find(item => String(item.id) === workerId);
    const targetSocketId = worker?.connected && worker.socketId ? worker.socketId : socketId;
    console.info(`[CALL_DISPATCH] persisted session=${sessionId} command=${commandId} call=${callId} persistMs=${persistedMs}`);
    console.info(`[CALL_TRACE] stage=server_persisted session=${sessionId} worker=${String(workerId).slice(-8)} command=${commandId} call=${callId} persistMs=${persistedMs}`);
    emitDialWithAck(code, workerId, targetSocketId, payload, 0, startedAt);
  } catch (error) {
    console.error(`[CALL_TRACE] stage=server_persist_failed session=${sessionId} command=${commandId} call=${callId} error=${error.code || "STORAGE_UNAVAILABLE"}`);
    console.error(`[CALL_DISPATCH] not sent session=${sessionId} reason=persistence command=${commandId} call=${callId} retry=${retry} elapsedMs=${Date.now() - startedAt} error=${error.code || error.message || "STORAGE_UNAVAILABLE"}`);
    if (!retry) runtime.io.to(code).emit("call:error",{message:"No se confirmó el guardado en MySQL. La orden queda pendiente y se reintentará."});
    schedulePersistedDialRetry(code, socketId, payload, retry, startedAt);
  }
}

function pendingAssignment(code, payload) {
  const campaign = runtime.sessions.get(code)?.campaign;
  return Object.entries(campaign?.assignments || {}).find(([, assignment]) =>
    assignment.attemptId === payload.callId && assignment.contactId === payload.contactId
  ) || null;
}

function schedulePersistedDialRetry(code, socketId, payload, retry, startedAt) {
  const sessionId = String(code).slice(-2);
  const commandId = String(payload.commandId || "").slice(-8);
  const callId = String(payload.callId || "").slice(-8);
  const delay = Math.min(1000 * (2 ** Math.min(retry, 5)), 30000);
  setTimeout(() => {
    if (!pendingAssignment(code, payload) || runtime.persistence.hasFinishedAttempt(code, payload.callId, payload.contactId)) {
      console.info(`[CALL_DISPATCH] persist-retry-cancelled session=${sessionId} command=${commandId} call=${callId} reason=assignment_finished`);
      return;
    }
    console.info(`[CALL_DISPATCH] persist-retry session=${sessionId} command=${commandId} call=${callId} retry=${retry + 1} delayMs=${delay} elapsedMs=${Date.now() - startedAt}`);
    return sendPersistedDial(code, socketId, payload, retry + 1, startedAt);
  }, delay);
}

function emitDialWithAck(code, workerId, socketId, payload, retry, startedAt) {
  const sessionId = String(code).slice(-2);
  const commandId = String(payload.commandId || "").slice(-8);
  const callId = String(payload.callId || "").slice(-8);
  const target = runtime.io.sockets?.sockets?.get(socketId);
  const deliveryKey = dialDeliveryKey(code, workerId, String(payload.commandId || ""));
  if (payload.action === "dial" && confirmedDialDeliveries.has(deliveryKey)) {
    console.info(`[CALL_DELIVERY] reenvío omitido: Android ya confirmó sesión=${sessionId} equipo=${String(workerId).slice(-8)} intento=${callId}`);
    return;
  }
  receivedDialDeliveries.delete(deliveryKey);
  if (!target?.connected) {
    console.warn(`[CALL_DISPATCH] not sent session=${sessionId} reason=worker_disconnected command=${commandId} call=${callId} retry=${retry}`);
    if (Date.now() - startedAt < 30000) scheduleDialRetry(code, workerId, payload, retry, startedAt);
    return;
  }

  // The APK does not answer call:action via the Socket.IO ack callback; it
  // confirms with a separate phone:command_ack event and reports call state
  // through phone:status. Sending without a callback avoids the 5s timeout
  // that otherwise reports invalid_ack/ack-timeout for every successful dial.
  target.emit("call:action", payload);
  console.info(`[CALL_TRACE] stage=server_sent session=${sessionId} worker=${String(workerId).slice(-8)} command=${commandId} call=${callId} retry=${retry}`);
  console.info(`[CALL_DISPATCH] sent session=${sessionId} command=${commandId} call=${callId} retry=${retry} targetConnected=true`);
  if (payload.action === "dial" && workerId && String(payload.commandId || "").startsWith("campaign-")) {
    scheduleDialDelivery(code, workerId, payload);
  }
}

function scheduleDialRetry(code, workerId, payload, retry, startedAt, waitCount = 0) {
  const sessionId = String(code).slice(-2);
  const commandId = String(payload.commandId || "").slice(-8);
  const callId = String(payload.callId || "").slice(-8);
  const delay = Math.min(1000 * (2 ** Math.min(waitCount, 4)), 15000);
  setTimeout(() => {
    const session = runtime.sessions.get(code);
    const assignmentEntry = Object.entries(session?.campaign?.assignments || {})
      .find(([id, item]) => id === workerId && item.attemptId === payload.callId);
    if (!assignmentEntry || runtime.persistence.hasFinishedAttempt(code, payload.callId, payload.contactId)) {
      console.info(`[CALL_DISPATCH] retry-cancelled session=${sessionId} command=${commandId} call=${callId} reason=assignment_finished`);
      return;
    }
    const worker = session.phoneWorkers?.find(item => String(item.id) === workerId);
    if (!worker?.connected || !worker.socketId) {
      console.info(`[CALL_DISPATCH] retry-waiting session=${sessionId} command=${commandId} call=${callId} retry=${retry} reason=worker_disconnected delayMs=${delay} elapsedMs=${Date.now() - startedAt}`);
      scheduleDialRetry(code, workerId, payload, retry, startedAt, waitCount + 1);
      return;
    }
    console.info(`[CALL_DISPATCH] retry session=${sessionId} command=${commandId} call=${callId} retry=${retry + 1}`);
    emitDialWithAck(code, workerId, worker.socketId, payload, retry + 1, startedAt);
  }, delay);
}

function dispatchNextCampaignCallLegacy(code) {
  const session = runtime.sessions.get(code);
  if (!session) return null;

  const campaign = ensureCampaign(session);
  if (campaign.status !== "running" || campaign.activeContactId) {
    services.emitCampaignState(code);
    return null;
  }

  // Seleccionar worker para saber si vamos directo o por PBX
  const worker = services.getActivePhoneWorker(session);
  excludeCalledPendingFromBlocks(campaign, services.annualBlocks());
  excludeBlockedPending(campaign, services.globalBlockedNumbers());
  const next = assignNextContact(session, worker || {});
  session.updatedAt = Date.now();
  services.saveSoon(code);

  if (!next) {
    services.emitCampaignState(code);
    return null;
  }

  session.callState = "dialing";
  session.lastNumber = next.phone;
  session.lastContactName = next.name;
  session.lastCompanyName = next.name;

  if (worker) {
    logOperationalCall({ campaign, worker, contact: next, state: "dialing", event: "ASIGNACION", sessionCode: code, username: session.ownerUsername });
    sendPersistedDial(code, worker.socketId, {
      action: "dial",
      phoneNumber: next.phone,
      contactId: next.id,
      companyName: next.name,
      contactName: next.name,
      callId: getActiveAttemptId(session, worker.id),
      commandId: `campaign-${getActiveAttemptId(session, worker.id)}`
    });
    services.saveSoon(code);
    services.emitState(code);
    services.emitCampaignState(code);
  } else {
    session.callState = "ended";
    markContactResult(session, next.id, "failed", { callbackReason: "Sin celular vinculado" });
    logOperationalCall({ campaign, contact: next, state: "failed", event: "CAMPAÑA", sessionCode: code, username: session.ownerUsername, detail: "No se marcó porque no hay equipo conectado" });
    services.saveSoon(code);
    services.emitState(code);
    services.emitCampaignState(code);
  }

  services.emitState(code);
  services.emitCampaignState(code);
  if (worker) services.refreshGlobalCallRestrictions(code);
  return next;
}

function dispatchCampaignCalls(code, onlyWorkerId = "") {
  const dispatchStartedAt = Date.now();
  if (runtime.historyGate.blocked(code)) return [];
  const session = runtime.sessions.get(code);
  if (!session) return [];
  const campaign = ensureCampaign(session);
  if (campaign.status !== "running") return [];
  const attempts = services.allCallAttempts();
  const calledBlocks = services.annualBlocks();
  const blockedNumbers = services.globalBlockedNumbers();
  excludeCalledPendingFromBlocks(campaign, calledBlocks);
  excludeBlockedPending(campaign, blockedNumbers);

  const dispatched = [];
  const connectedWorkers = services.getConnectedPhoneWorkers(session);
  const workers = connectedWorkers.filter((worker) =>
    (!onlyWorkerId || worker.id === onlyWorkerId)
    &&
    !isWorkerPaused(session, worker.id)
    // Android may keep `ended` as its last reported state after hanging up.
    // That phone is available for a new outbound call.
    && ["idle", "ended", "failed", "available"].includes(String(worker.callState || "idle"))
    && !campaign.assignments?.[worker.id]
  );

  for (const worker of workers) {
    excludeCalledPendingFromBlocks(campaign, calledBlocks);
    excludeBlockedPending(campaign, blockedNumbers);
    const next = assignNextContact(session, worker);
    if (!next) continue;
    // Preserve the old per-worker duplicate-phone guard without rescanning the
    // full history after every assignment in this synchronous dispatch batch.
    addAttemptPhoneBlock(calledBlocks, next.phone, next.lastAttemptAt);
    worker.callState = "dialing";
    worker.activeContactId = next.id;
    worker.lastCompanyName = next.name;
    worker.lastNumber = next.phone;
    session.callState = "dialing";
    session.lastNumber = next.phone;
    session.lastContactName = next.name;
    session.lastCompanyName = next.name;
    sendPersistedDial(code, worker.socketId, {
      action: "dial",
      phoneNumber: next.phone,
      contactId: next.id,
      companyName: next.name,
      contactName: next.name,
      callId: getActiveAttemptId(session, worker.id),
      commandId: `campaign-${getActiveAttemptId(session, worker.id)}`
    });
    logOperationalCall({ campaign, worker, contact: next, state: "dialing", event: "ASIGNACION", sessionCode: code, username: session.ownerUsername });
    dispatched.push({ workerId: worker.id, contactId: next.id });
  }

  if (!dispatched.length) {
    const hasPending = campaign.contacts.some((contact) => ["pending", "retry_pending"].includes(contact.status));
    const hasActive = campaign.contacts.some((contact) => ["dialing", "ringing", "in_call"].includes(contact.status));
    if (hasPending && !hasActive) logCampaignWaiting({ campaign, workers: connectedWorkers, sessionCode: code, username: session.ownerUsername });
  }

  session.updatedAt = Date.now();
  services.saveSoon(code);
  services.emitState(code);
  services.emitCampaignState(code);
  if (dispatched.length) services.refreshGlobalCallRestrictions(code);
  const dispatchCycleMs = Date.now() - dispatchStartedAt;
  if (dispatchCycleMs >= 100) {
    console.info(`[CALL_DISPATCH] cycle session=${String(code).slice(-2)} contacts=${campaign.contacts.length} workers=${workers.length} dispatched=${dispatched.length} attempts=${attempts.length} elapsedMs=${dispatchCycleMs}`);
  }
  return dispatched;
}

function dispatchNextCampaignCall(code) {
  return dispatchCampaignCalls(code)[0] || null;
}

function finalizeStuckAssignment(code, workerId, contact, assignment, reason) {
  const session = runtime.sessions.get(code);
  if (!session?.campaign) return false;
  const worker = session.phoneWorkers?.find(item => String(item.id) === String(workerId));
  // 1. Ask the phone to drop the physical call (best effort; the server does not
  // depend on this succeeding to release the worker).
  if (worker?.connected && worker.socketId) {
    try {
      runtime.io.to(worker.socketId).emit("call:action", {
        action: "hangup", from: "watchdog", contactId: contact.id,
        commandId: `watchdog-${assignment.attemptId}`
      });
    } catch { /* socket already gone; the assignment is still reclaimed below */ }
  }
  // 2. Mark the attempt terminal. markContactResult finalizes the attempt and
  // releases the assignment; a late ended/failed from Android is then ignored
  // because the contact is no longer in an active state (idempotent terminal).
  markContactResult(session, contact.id, "sin_respuesta", { callbackReason: reason });
  // 3. Guarantee the worker is free even if the result path kept the assignment.
  if (session.campaign.assignments?.[workerId]) skipActiveContact(session, workerId);
  session.updatedAt = Date.now();
  services.saveSoon(code);
  services.emitState(code);
  services.emitCampaignState(code);
  console.warn(`[WATCHDOG] intento colgado liberado sesión=${String(code).slice(-2)} equipo=${String(workerId).slice(-8)} contacto=${String(contact.name || "").slice(0, 30)} intento=${String(assignment.attemptId).slice(-8)} motivo=${reason}`);
  return true;
}

function scanStuckCalls() {
  for (const [code, session] of runtime.sessions) {
    const campaign = session?.campaign;
    if (!campaign || campaign.status !== "running" || !campaign.assignments) continue;
    for (const [workerId, assignment] of Object.entries(campaign.assignments)) {
      const contact = campaign.contacts?.find(item => item.id === assignment.contactId);
      if (!contact) continue;
      const attempt = (contact.attemptHistory || []).find(item => item.id === assignment.attemptId);
      const worker = session.phoneWorkers?.find(item => String(item.id) === String(workerId));
      const status = String(contact.status || "");
      if (status === "in_call") {
        const lastStatusAt = Number(worker?.lastStatusAt || 0);
        if (lastStatusAt) {
          // Heartbeat-aware: a live call refreshes lastStatusAt every ~10s.
          if (Date.now() - lastStatusAt > WATCHDOG_HEARTBEAT_MS) {
            finalizeStuckAssignment(code, workerId, contact, assignment, "watchdog_in_call_heartbeat_timeout");
          }
        } else {
          // Old APK without heartbeat: fall back to a generous hard ceiling.
          const answeredAt = Date.parse(attempt?.answeredAt || contact.answeredAt || 0);
          if (answeredAt && Date.now() - answeredAt > WATCHDOG_INCALL_CEILING_MS) {
            finalizeStuckAssignment(code, workerId, contact, assignment, "watchdog_in_call_timeout");
          }
        }
      } else if (status === "dialing" || status === "ringing") {
        const startedAt = Date.parse(attempt?.startedAt || contact.lastAttemptAt || 0);
        if (startedAt && Date.now() - startedAt > WATCHDOG_DIALING_MS) {
          finalizeStuckAssignment(code, workerId, contact, assignment, "watchdog_dialing_timeout");
        }
      }
    }
  }
}

function startCallWatchdog() {
  if (callWatchdogTimer) return callWatchdogTimer;
  callWatchdogTimer = setInterval(() => {
    if (runtime.shuttingDown) return;
    try { scanStuckCalls(); }
    catch (error) { console.error("[WATCHDOG] error:", error.code || error.message || "WATCHDOG_FAILED"); }
  }, WATCHDOG_INTERVAL_MS);
  callWatchdogTimer.unref?.();
  console.info(`[WATCHDOG] activo interval=${WATCHDOG_INTERVAL_MS}ms dialing=${WATCHDOG_DIALING_MS}ms heartbeat=${WATCHDOG_HEARTBEAT_MS}ms in_callCeiling=${WATCHDOG_INCALL_CEILING_MS}ms`);
  return callWatchdogTimer;
}

function stopCallWatchdog() {
  if (callWatchdogTimer) clearInterval(callWatchdogTimer);
  callWatchdogTimer = null;
}

function archiveCurrentCampaign(session) {
  const campaign = ensureCampaign(session);
  const archive = session.reportArchive ||= [];

  if (!campaign.contacts?.length && !campaign.history?.length) return;

  const key = campaign.reportRunId ||= nanoid(12);
  const date = campaign.reportDate ||= (
    campaign.history?.[0]?.startedAt
      ? new Date(campaign.history[0].startedAt).toLocaleDateString("en-CA", { timeZone: "America/Lima" })
      : new Date().toLocaleDateString("en-CA", { timeZone: "America/Lima" })
  );

  const record = {
    id: key,
    date,
    rubro: campaign.reportRubro ||
      campaign.listName ||
      campaign.contacts?.[0]?.list || "Principal",

    contacts: (campaign.contacts || []).map(c => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      list: c.list,
      status: c.status,
      targetWorkerId: c.targetWorkerId,
      assignedWorkerId: c.assignedWorkerId,
      assignedWorkerName: c.assignedWorkerName,
      technicalResult: c.technicalResult,
      result: c.result,
      durationSeconds: c.durationSeconds
    })),

    history: (campaign.history || []).map(h => ({ ...h }))
  };

  const index = archive.findIndex(x => x.id === key);

  if (index < 0) {
    archive.push(record);
    // Retention policy: keep max 100 archives per session to prevent unbounded growth
    if (archive.length > 100) {
      archive.splice(0, archive.length - 100);
    }
  } else {
    archive[index] = record;
  }
}
return { sendPersistedDial, dispatchNextCampaignCallLegacy, dispatchCampaignCalls, dispatchNextCampaignCall, archiveCurrentCampaign, acknowledgeDialReceipt, acknowledgeDialDelivery, resumeAssignedDial, startCallWatchdog, stopCallWatchdog, scanStuckCalls };
}
