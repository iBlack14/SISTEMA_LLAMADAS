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
let saveSoonTimer = null;
let saveSoonPromise = null;
let saveSoonPendingCodes = new Set();
let saveSoonRequiresFullSnapshot = false;

function saveSoon(code = "") {
  if (code && runtime.sessions.has(code)) {
    runtime.persistence.markSessionDirty(code);
    saveSoonPendingCodes.add(code);
  } else {
    // An unscoped mutation must keep the previous full-snapshot behavior.
    saveSoonRequiresFullSnapshot = true;
  }
  if (saveSoonTimer) return saveSoonPromise;
  saveSoonPromise = new Promise((resolve) => {
    saveSoonTimer = setTimeout(() => {
      saveSoonTimer = null;
      const pendingCodes = saveSoonPendingCodes;
      const requiresFullSnapshot = saveSoonRequiresFullSnapshot;
      saveSoonPendingCodes = new Set();
      saveSoonRequiresFullSnapshot = false;
      const dirtyCodes = runtime.persistence.getDirtySessions();
      const changedCodes = new Set([...pendingCodes, ...dirtyCodes]);
      runtime.persistence.save(runtime.sessions,
        requiresFullSnapshot || !changedCodes.size ? null : [...changedCodes])
        .then(resolve)
        .catch(error => {
          // Re-add dirty codes on failure so they can be retried
          for (const code of dirtyCodes) {
            runtime.persistence.markSessionDirty(code);
          }
          console.error("[PERSISTENCE] Guardado pendiente:", error.code || "STORAGE_UNAVAILABLE");
          resolve();
        });
    }, 150);
  });
  return saveSoonPromise;
}

function getOrCreateSession(code) {
  if (!runtime.sessions.has(code)) {
    runtime.sessions.set(code, services.normalizeSessionShape());
    saveSoon(code);
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
  const neededContactIds = new Set();
  for (const worker of session.phoneWorkers || []) {
    const assignment = campaign.assignments?.[worker.id];
    if (assignment?.contactId) neededContactIds.add(assignment.contactId);
  }
  const assignedContactsById = new Map();
  if (neededContactIds.size > 0) {
    for (const item of campaign.contacts || []) {
      if (neededContactIds.has(item.id)) {
        assignedContactsById.set(item.id, item);
        if (assignedContactsById.size === neededContactIds.size) break;
      }
    }
  }
  const phoneWorkers = (session.phoneWorkers || []).map((worker) => {
    const assignment = campaign.assignments?.[worker.id] || null;
    const contact = assignment ? (assignedContactsById.get(assignment.contactId) || null) : null;
    return {
      id: worker.id,
      name: worker.name,
      detectorState: worker.detectorState || "unknown",
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
      lineLabel: worker.lineLabel || "",
      detectedVoicemail: Boolean(worker.detectedVoicemail),
      detectedAnnouncement: worker.detectedAnnouncement || "",
      terminalConfirmed: Boolean(worker.terminalConfirmed)
    };
  });

  const blockedNumbers = services.globalBlockedNumbers();
  const fullPayload = {
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
    pairingSlots: session.pairingSlots || [],
    blockedNumbers,
    callState: session.callState,
    lastNumber: session.lastNumber,
    lastCompanyName: session.lastCompanyName,
    lastContactName: session.lastContactName,
    lastImageUrl: session.lastImageUrl,
    micMuted: session.micMuted,
    isSpeakerOn: session.isSpeakerOn,
    shiftManagement: getShiftSnapshot(session),
    updatedAt: session.updatedAt
  };

  if (runtime.io.sockets?.sockets) {
    // El dashboard necesita todo el estado; las APKs solo usan blockedNumbers y phoneWorkers.
    // Con 5-10+ equipos evita enviar cientos de KB de callRestrictions/shiftManagement a cada celular.
    if (session.dashboardSocketId) {
      runtime.io.to(session.dashboardSocketId).emit("state:changed", fullPayload);
    }
    const phonePayload = { blockedNumbers, phoneWorkers };
    for (const worker of session.phoneWorkers || []) {
      if (worker.connected && worker.socketId) {
        runtime.io.to(worker.socketId).emit("state:changed", phonePayload);
      }
    }
  } else {
    runtime.io.to(code).emit("state:changed", fullPayload);
  }
  // Cualquier cambio de estado en Llamadas, campañas, equipos o APK
  // notifica también a Núcleo de Red en tiempo real (agrupado en 250 ms).
  runtime.network?.notifyChanged?.();
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
