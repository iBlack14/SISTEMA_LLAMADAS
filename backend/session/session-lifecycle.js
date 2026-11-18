import { nanoid } from "nanoid";
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
 * createSessionLifecycle: conserva los contratos y reglas existentes.
 * Dependencias: runtime.io, runtime.sessions, services.emitState, services.getConnectedPhoneWorkers, services.removePhoneWorker, services.saveSoon, services.syncSessionPhoneState.
 * Se construye una vez por proceso.
 */
export function createSessionLifecycle(runtime, services) {
function emitCampaignState(code) {
  const session = runtime.sessions.get(code);
  if (!session) return;
  const campaign = ensureCampaign(session);
  syncPendingContacts(session, campaign);
  runtime.io.to(code).emit("campaign:state", { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) });
}

function disconnectAllSessionPhones(session, reason = "turn_finished") {
  const sockets = [];
  for (const worker of session.phoneWorkers || []) {
    if (!worker.socketId) continue;
    const phoneSocket = runtime.io.sockets.sockets.get(worker.socketId);
    if (phoneSocket) sockets.push(phoneSocket);
    if (["dialing", "ringing", "in_call"].includes(String(worker.callState || ""))) {
      runtime.io.to(worker.socketId).emit("call:action", { action: "hangup", from: "dashboard", commandId: nanoid() });
    }
    runtime.io.to(worker.socketId).emit("session:force_logout", { reason });
  }
  for (const slot of session.pairingSlots || []) {
    slot.deviceId = "";
    slot.deviceName = "";
    slot.linkedAt = null;
  }
  session.phoneWorkers = [];
  session.phoneDevice = null;
  session.phoneSocketId = null;
  session.activePhoneSocketId = null;
  session.callState = "idle";
  // Android waits briefly for its logout acknowledgement before clearing
  // credentials. Keep the socket alive long enough to finish that handshake.
  setTimeout(() => sockets.forEach((phoneSocket) => {
    if (phoneSocket.connected) phoneSocket.disconnect(true);
  }), 2200);
}

function hasPersistentCampaignData(session) {
  const campaign = ensureCampaign(session);
  return Boolean(session.ownerUserId || session.contactBook || session.hasCallHistory || session.blockedNumbers?.length)
    || campaign.contacts.length > 0 || campaign.history.length > 0 || campaign.callbacks.length > 0;
}

function detachSocketFromCurrentSession(socket) {
  const previousCode = socket.data.code;
  const previousRole = socket.data.role;
  if (!previousCode || !previousRole) return;

  const previousSession = runtime.sessions.get(previousCode);
  if (!previousSession) {
    socket.data.code = null;
    socket.data.role = null;
    return;
  }

  if (previousRole === "dashboard" && previousSession.dashboardSocketId === socket.id) {
    previousSession.dashboardSocketId = null;
  }

  if (previousRole === "phone") {
    const removed = services.removePhoneWorker(previousSession, socket.id);
    if (previousSession.activePhoneSocketId === socket.id) {
      previousSession.activePhoneSocketId = null;
    }
    services.syncSessionPhoneState(previousSession);

    if (removed && previousSession.callState !== "idle" && !previousSession.phoneSocketId) {
      previousSession.callState = "idle";
    }
  }

  previousSession.updatedAt = Date.now();
  socket.leave(previousCode);

  if (!previousSession.dashboardSocketId && !services.getConnectedPhoneWorkers(previousSession).length && !hasPersistentCampaignData(previousSession)) {
    runtime.sessions.delete(previousCode);
  } else {
    services.emitState(previousCode);
    emitCampaignState(previousCode);
  }

  services.saveSoon();
  socket.data.code = null;
  socket.data.role = null;
}
return { emitCampaignState, disconnectAllSessionPhones, hasPersistentCampaignData, detachSocketFromCurrentSession };
}
