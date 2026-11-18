import { nanoid } from "nanoid";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../campaigns/contact-book.js";
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
async function sendPersistedDial(code, socketId, payload) {
  const startedAt = Date.now();
  const sessionId = String(code).slice(-2);
  const commandId = String(payload.commandId || "").slice(-8);
  const callId = String(payload.callId || "").slice(-8);
  try {
    console.info(`[CALL_DISPATCH] persist-before-dial session=${sessionId} worker=${socketId ? "connected" : "missing"} command=${commandId} call=${callId}`);
    await runtime.persistence.save(runtime.sessions);
    const persistedMs = Date.now() - startedAt;
    const session = runtime.sessions.get(code);
    const assignment = Object.values(session?.campaign?.assignments || {})
      .find(item => item.attemptId === payload.callId);
    if (!assignment || assignment.workerSocketId !== socketId) {
      console.warn(`[CALL_DISPATCH] not sent session=${sessionId} reason=assignment_changed command=${commandId} call=${callId} persistMs=${persistedMs}`);
      return;
    }
    const targetConnected = Boolean(runtime.io.sockets?.sockets?.get(socketId)?.connected);
    runtime.io.to(socketId).emit("call:action",payload);
    console.info(`[CALL_DISPATCH] sent session=${sessionId} command=${commandId} call=${callId} persistMs=${persistedMs} targetConnected=${targetConnected}`);
  } catch (error) {
    console.error(`[CALL_DISPATCH] not sent session=${sessionId} reason=persistence command=${commandId} call=${callId} elapsedMs=${Date.now() - startedAt} error=${error.code || error.message || "STORAGE_UNAVAILABLE"}`);
    runtime.io.to(code).emit("call:error",{message:"No se confirmó el guardado en MySQL. No se envió la llamada."});
  }
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
  excludeCalledPending(campaign, services.allCallAttempts());
  excludeBlockedPending(campaign, services.globalBlockedNumbers());
  const next = assignNextContact(session, worker || {});
  session.updatedAt = Date.now();
  services.saveSoon();

  if (!next) {
    services.emitCampaignState(code);
    return null;
  }

  session.callState = "dialing";
  session.lastNumber = next.phone;
  session.lastContactName = next.name;
  session.lastCompanyName = next.name;

  if (worker) {
    console.log(`[CAMPAIGN] Marcado directo a ${next.phone} vía worker ${worker.name}`);
    sendPersistedDial(code, worker.socketId, {
      action: "dial",
      phoneNumber: next.phone,
      contactId: next.id,
      companyName: next.name,
      contactName: next.name,
      callId: getActiveAttemptId(session, worker.id),
      commandId: nanoid()
    });
    services.saveSoon();
    services.emitState(code);
    services.emitCampaignState(code);
  } else {
    console.log(`[CAMPAIGN] Omitido ${next.phone} (No hay worker)`);
    session.callState = "ended";
    markContactResult(session, next.id, "failed", { callbackReason: "Sin celular vinculado" });
    services.saveSoon();
    services.emitState(code);
    services.emitCampaignState(code);
  }

  services.emitState(code);
  services.emitCampaignState(code);
  if (worker) services.refreshGlobalCallRestrictions(code);
  return next;
}

function dispatchCampaignCalls(code, onlyWorkerId = "") {
  if (runtime.historyGate.blocked(code)) return [];
  const session = runtime.sessions.get(code);
  if (!session) return [];
  const campaign = ensureCampaign(session);
  if (campaign.status !== "running") return [];
  excludeCalledPending(campaign, services.allCallAttempts());
  excludeBlockedPending(campaign, services.globalBlockedNumbers());

  const dispatched = [];
  const connectedWorkers = services.getConnectedPhoneWorkers(session);
  const connectedWorkerIds = new Set(connectedWorkers.map((worker) => String(worker.id)));
  for (const contact of campaign.contacts || []) {
    if (contact.targetWorkerId && !connectedWorkerIds.has(String(contact.targetWorkerId))
        && ["pending", "retry_pending"].includes(String(contact.status))) {
      contact.targetWorkerId = "";
    }
  }
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
    excludeCalledPending(campaign, services.allCallAttempts());
    excludeBlockedPending(campaign, services.globalBlockedNumbers());
    const next = assignNextContact(session, worker);
    if (!next) continue;
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
      commandId: nanoid()
    });
    dispatched.push({ workerId: worker.id, contactId: next.id });
  }

  session.updatedAt = Date.now();
  services.saveSoon();
  services.emitState(code);
  services.emitCampaignState(code);
  if (dispatched.length) services.refreshGlobalCallRestrictions(code);
  return dispatched;
}

function dispatchNextCampaignCall(code) {
  return dispatchCampaignCalls(code)[0] || null;
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
  } else {
    archive[index] = record;
  }
}
return { sendPersistedDial, dispatchNextCampaignCallLegacy, dispatchCampaignCalls, dispatchNextCampaignCall, archiveCurrentCampaign };
}
