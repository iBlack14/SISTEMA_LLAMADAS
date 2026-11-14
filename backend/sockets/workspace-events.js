import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import { runtimeIdentity, runtimeLockName, probeRuntime, waitForRuntime } from "../services/workspace/runtime-instance.js";
import { UserWorkspaces } from "../services/workspace/user-workspace.js";
import { splitReportByList } from "../services/reports/report-lists.js";
import { hydrateReportDetails } from "../services/reports/report-details.js";
import { selectPendingReportContacts } from "../services/reports/report-selection.js";
import { isAnsweredAttempt, isVoicemailAttempt, attemptResultLabel } from "../../shared/reports/report-metrics.js";
import { bindDeviceToPairingSlot, clearDeviceFromPairingSlots, dedupePairingSlotDevices } from "../services/calls/pairing-lifecycle.js";
import { assertIsolatedConfig, assertXamppConfig, assertEasypanelConfig } from "../services/auth/config.js";
import { AuthService } from "../services/auth/service.js";
import { installSocketAuth } from "../services/auth/sockets.js";
import { NetworkMonitor } from "../services/network/network-monitor.js";
import { SessionPersistence } from "../shared/persistence.js";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../services/campaigns/contact-book.js";
import { collectReportAttempts } from "../services/reports/report-attempts.js";
import { collectCallAttempts } from "../services/calls/call-history.js";
import { CallHistoryGate } from "../services/calls/call-history-gate.js";
import { normalizeMessageContacts, upsertMessageContact } from "../services/messaging/message-contacts.js";
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

// Extraído del servidor original; conserva validaciones y contratos públicos.
export function registerWorkspaceEvents(runtime, services, socket) {
const { io, sessions, workspaces } = runtime;
const { saveSoon, getPairingSlotByToken, upsertPhoneWorker, syncSessionPhoneState, emitCampaignState, detachSocketFromCurrentSession, dispatchCampaignCalls, getOrCreateSession, emitState, emitMessageContacts } = services;
  const openWorkspace = async ({ dashboardClientId, previousCode } = {}) => {
    const user = socket.data.authUser;
    if (!user) return;
    try {
      const { code, session } = await workspaces.open(user, String(previousCode || "").toUpperCase());
      if (!socket.connected) return;
      detachSocketFromCurrentSession(socket);
      session.updatedAt = Date.now();
      socket.data.code = code;
      socket.data.role = "dashboard";
      socket.data.dashboardClientId = String(dashboardClientId || "").trim();
      socket.join(code);
      session.dashboardSocketId = socket.id;
      session.dashboardClientId = socket.data.dashboardClientId;
      socket.emit("session:created", { code, dashboardToken: session.dashboardToken });
      emitState(code);
      emitCampaignState(code);
      emitMessageContacts(code);
    } catch (error) {
      socket.emit("session:error", { reason: "WORKSPACE_UNAVAILABLE", message: error.message || "No se pudo abrir tu espacio de trabajo." });
    }
  };
  socket.on("workspace:open", openWorkspace);
  // Compatibility: older dashboards also reopen the account workspace.
  socket.on("session:create", openWorkspace);


  socket.on("session:join", ({ code, role, token, deviceName, deviceId, dashboardClientId }) => {
    if (!code || !role) return;

    const normalizedCode = String(code).toUpperCase().trim();
    if (!/^[A-Z0-9_-]{6}$/.test(normalizedCode) || !["dashboard", "phone"].includes(role)) {
      socket.emit("session:error", { message: "Codigo o rol de sesion invalido." });
      return;
    }
    const session = sessions.has(normalizedCode) ? getOrCreateSession(normalizedCode) : null;
    if (!session) {
      socket.emit("session:error", { message: "Sesión no encontrada. Crea una sesión nueva." });
      return;
    }
    const normalizedToken = token ? String(token).trim() : "";

    const pairingSlot = role === "phone" ? getPairingSlotByToken(session, normalizedToken) : null;
    if (role === "phone" && !pairingSlot && normalizedToken !== session.pairingToken) {
      socket.emit("session:error", { message: "Token de vinculacion invalido." });
      return;
    }
    if (role === "phone" && pairingSlot?.deviceId && pairingSlot.deviceId !== String(deviceId || "")) {
      socket.emit("session:error", { message: "Este QR ya esta vinculado a otro telefono." });
      return;
    }
    if (role === "dashboard" && normalizedToken !== session.dashboardToken) {
      socket.emit("session:error", { message: "Token privado del dashboard inválido o ausente." });
      return;
    }

    if (role === "dashboard") {
      const requestedClientId = String(dashboardClientId || "").trim();
      const activeDashboard = session.dashboardSocketId
        ? io.sockets.sockets.get(session.dashboardSocketId)
        : null;
      const activeClientId = String(session.dashboardClientId || activeDashboard?.data?.dashboardClientId || "").trim();
      const sameAccount = String(activeDashboard?.data?.authUser?.id || "") === String(socket.data.authUser?.id || "");
      if (activeDashboard?.connected && activeDashboard.id !== socket.id && !sameAccount
        && (!requestedClientId || !activeClientId || requestedClientId !== activeClientId)) {
        socket.emit("session:error", {
          reason: "dashboard_in_use",
          message: "Esta sesión ya está abierta por otro operador. Se creará una sesión independiente."
        });
        return;
      }
    }

    detachSocketFromCurrentSession(socket);

    socket.data.code = normalizedCode;
    socket.data.role = role;
    socket.join(normalizedCode);

    if (role === "dashboard") {
      session.dashboardSocketId = socket.id;
      session.dashboardClientId = String(dashboardClientId || "").trim();
      socket.data.dashboardClientId = session.dashboardClientId;
    }
    let rotatedPairingToken = "";
    if (role === "phone") {
      const worker = upsertPhoneWorker(session, {
        socketId: socket.id,
        deviceId: deviceId || "web-phone",
        deviceName: deviceName || "Android bridge"
      });
      if (pairingSlot) {
        bindDeviceToPairingSlot(session, pairingSlot, {
          deviceId: deviceId || worker.id,
          deviceName: deviceName || worker.name
        });
        worker.pairingSlotId = pairingSlot.id;
        socket.data.pairingSlotId = pairingSlot.id;
        pairingSlot.token = nanoid(20);
        rotatedPairingToken = pairingSlot.token;
      } else if (normalizedToken === session.pairingToken) {
        session.pairingToken = nanoid(20);
        rotatedPairingToken = session.pairingToken;
      }
      session.activePhoneSocketId ||= worker.socketId;
      syncSessionPhoneState(session);
      saveSoon();
    }

    session.updatedAt = Date.now();
    socket.emit("session:joined", {
      code: normalizedCode,
      role,
      ...(rotatedPairingToken ? { token: rotatedPairingToken } : {})
    });
    emitState(normalizedCode);
    emitCampaignState(normalizedCode);
    if (role === "dashboard") emitMessageContacts(normalizedCode);

    // If a phone joined and a campaign is running but idle, kickstart it
    if (role === "phone") {
        const campaign = ensureCampaign(session);
        if (campaign.status === "running") {
            setTimeout(() => dispatchCampaignCalls(normalizedCode), 1000);
        }
    }
  });


}
