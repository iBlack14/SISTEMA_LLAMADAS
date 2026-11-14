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
} from "../services/campaigns/campaign-manager.js";
import {
  ensureShiftManagement,
  syncPendingContacts,
  finalizeCurrentTurn,
  finalizeCurrentSession,
  markPendingCampaignStarted,
  getShiftSnapshot
} from "../services/campaigns/shift-manager.js";

/**
 * createSessionState: conserva los contratos y reglas existentes.
 * Dependencias: runtime.io, runtime.persistence, runtime.sessions, services.callRestrictions, services.normalizeSessionShape, services.syncSessionPhoneState.
 * Se construye una vez por proceso.
 */
export function createSessionState(runtime, services) {
function saveSoon() {
  return runtime.persistence.save(runtime.sessions).catch(error => {
    console.error("[PERSISTENCE] Guardado pendiente:", error.code || "STORAGE_UNAVAILABLE");
  });
}

function getOrCreateSession(code) {
  if (!runtime.sessions.has(code)) {
    runtime.sessions.set(code, services.normalizeSessionShape());
    saveSoon();
  }

  const session = runtime.sessions.get(code);
  const normalized = services.normalizeSessionShape(session);
  ensureCampaign(normalized);
  runtime.sessions.set(code, normalized);
  return normalized;
}

function getPeer(session, role) {
  services.syncSessionPhoneState(session);
  if (role === "dashboard") return session.activePhoneSocketId || session.phoneSocketId;
  if (role === "phone") return session.dashboardSocketId;
  return null;
}

function emitState(code) {
  const session = runtime.sessions.get(code);
  if (!session) return;
  services.syncSessionPhoneState(session);
  const campaign = ensureCampaign(session);
  syncPendingContacts(session, campaign);
  const phoneWorkers = (session.phoneWorkers || []).map((worker) => {
    const assignment = campaign.assignments?.[worker.id] || null;
    const contact = assignment ? campaign.contacts.find((item) => item.id === assignment.contactId) : null;
    return {
      id: worker.id,
      name: worker.name,
      linkedAt: worker.linkedAt,
      connected: Boolean(worker.connected && worker.socketId),
      callState: worker.callState || "idle",
      paused: campaign.pausedWorkerIds.includes(String(worker.id)),
      active: Boolean(assignment),
      activeContactId: contact?.id || null,
      companyName: contact?.name || worker.lastCompanyName || "",
      phoneNumber: contact?.phone || worker.lastNumber || "",
      attempt: contact?.attempts || 0,
      answeredAt: contact?.answeredAt || null,
      durationSeconds: contact?.durationSeconds || 0,
      speakerOn: Boolean(worker.speakerOn),
      lastError: worker.lastError || "",
      lineLabel: worker.lineLabel || ""
    };
  });

  runtime.io.to(code).emit("state:changed", {
    localTestMode: false,
    storage: runtime.persistence.status(),
    callRestrictions: services.callRestrictions(session),
    connected: {
      dashboard: Boolean(session.dashboardSocketId),
      phone: Boolean(session.phoneSocketId),
      phoneCount: phoneWorkers.filter((worker) => worker.connected).length,
      linking: Boolean(session.phoneDevice) && !session.phoneSocketId
    },
    phoneDevice: session.phoneDevice,
    phoneWorkers,
    blockedNumbers: session.blockedNumbers,
    callState: session.callState,
    lastNumber: session.lastNumber,
    lastCompanyName: session.lastCompanyName,
    lastContactName: session.lastContactName,
    lastImageUrl: session.lastImageUrl,
    micMuted: session.micMuted,
    isSpeakerOn: session.isSpeakerOn,
    shiftManagement: getShiftSnapshot(session),
    updatedAt: session.updatedAt
  });
}

function emitMessageContacts(code) {
  const session = runtime.sessions.get(code);
  if (session?.dashboardSocketId) {
    runtime.io.to(session.dashboardSocketId).emit("messages:contacts", {
      contacts: session.messageContacts || []
    });
  }
}
return { saveSoon, getOrCreateSession, getPeer, emitState, emitMessageContacts };
}
