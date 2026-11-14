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
export function registerUtilityEvents(runtime, services, socket) {
const { io, sessions, persistence } = runtime;
const { saveSoon, getConnectedPhoneWorkers, removePhoneWorker, syncSessionPhoneState, emitCampaignState, hasPersistentCampaignData, emitState, emitMessageContacts } = services;
  socket.on("blocked-numbers:change", (payload = {}) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || !["dashboard", "phone"].includes(role)) return;
    const session = sessions.get(code);
    if (!session) return;

    const data = payload && typeof payload === "object" ? payload : {};
    const action = String(data.action || "");
    const phone = String(data.phone || "").trim();
    const key = phoneKey(phone);
    const name = String(data.name || "").trim().slice(0, 120) || phone;
    if (!["add", "remove"].includes(action) || !/^\d{6,15}$/.test(key)) {
      socket.emit("blocked-numbers:error", { message: "Ingresa un nombre y un número válido." });
      return;
    }

    const blockedNumbers = Array.isArray(session.blockedNumbers) ? session.blockedNumbers : [];
    if (action === "add") {
      const current = blockedNumbers.find((item) => phoneKey(item.phone) === key);
      if (!current && blockedNumbers.length >= 5000) {
        socket.emit("blocked-numbers:error", { message: "La lista alcanzó el límite de 5000 números." });
        return;
      }
      session.blockedNumbers = [
        ...blockedNumbers.filter((item) => phoneKey(item.phone) !== key),
        { name, phone }
      ];
    } else {
      session.blockedNumbers = blockedNumbers.filter((item) => phoneKey(item.phone) !== key);
    }
    session.updatedAt = Date.now();
    saveSoon();
    emitState(code);
    socket.emit("blocked-numbers:ack", { accepted: true, action, phone });
  });

  socket.on("phone:message-contact:add", async (payload = {}) => {
    const code = socket.data.code;
    if (!code || socket.data.role !== "phone") return;
    const session = sessions.get(code);
    if (!session) return;

    const data = payload && typeof payload === "object" ? payload : {};
    const result = upsertMessageContact(session.messageContacts, data);
    if (result.error) {
      socket.emit("phone:message-contact:ack", { ok: false, message: result.error });
      return;
    }

    session.messageContacts = result.contacts;
    session.updatedAt = Date.now();
    try {
      await persistence.save(sessions);
      emitMessageContacts(code);
      socket.emit("phone:message-contact:ack", {
        ok: true,
        message: `Contacto ${result.contact.name} guardado en la web.`
      });
    } catch (error) {
      console.error("[MESSAGES] No se pudo guardar el contacto:", error.code || "STORAGE_UNAVAILABLE");
      socket.emit("phone:message-contact:ack", {
        ok: false,
        message: "No se pudo guardar el contacto en la web. Verifica la conexión e inténtalo de nuevo."
      });
    }
  });

  socket.on("session:logout", (acknowledge) => {
    const { code, role } = socket.data;
    if (!code || role !== "phone") return;
    const session = sessions.get(code);
    if (!session) return;
    const worker = (session.phoneWorkers || []).find((item) => item.socketId === socket.id);
    clearDeviceFromPairingSlots(session, worker?.id);
    socket.data.explicitLogout = true;
    session.updatedAt = Date.now();
    saveSoon();
    emitState(code);
    emitCampaignState(code);
    if (typeof acknowledge === "function") acknowledge({ ok: true });
  });


  socket.on("disconnect", () => {
    const { code, role } = socket.data;
    if (!code || !role) return;

    const session = sessions.get(code);
    if (!session) return;

    if (role === "dashboard" && session.dashboardSocketId === socket.id) session.dashboardSocketId = null;
    if (role === "phone") {
      const removed = removePhoneWorker(session, socket.id);
      if (session.activePhoneSocketId === socket.id) {
        session.activePhoneSocketId = null;
      }

      // If the disconnecting worker was in a call, cleanup campaign
      if (removed) {
          updateActiveCallState(session, "ended", removed);
      }

      syncSessionPhoneState(session);
      // Let the dashboard keep the call window open during micro-cuts.
      // The user can manually click 'Cortar' if the phone never reconnects.
      /*
      if (removed && session.callState !== "idle" && !session.phoneSocketId) {
        session.callState = "idle";
        const dash = session.dashboardSocketId;
        if (dash) io.to(dash).emit("state:changed", { ...session, connected: { dashboard: true, phone: false, phoneCount: 0 } });
      }
      */
    }

    session.updatedAt = Date.now();

    if (!session.dashboardSocketId && !getConnectedPhoneWorkers(session).length && !hasPersistentCampaignData(session)) {
      sessions.delete(code);
      saveSoon();
      return;
    }

    emitState(code);
    emitCampaignState(code);
  });
}
