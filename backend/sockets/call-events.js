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
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks } from "../services/campaigns/contact-book.js";
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
export function registerCallEvents(runtime, services, socket) {
const { io, sessions, historyGate, persistence, network } = runtime;
const { saveSoon, getConnectedPhoneWorkers, getPhoneWorkerBySocketId, getActivePhoneWorker, syncSessionPhoneState, emitCampaignState, annualBlock, blockedCallMessage, sendPersistedDial, dispatchCampaignCalls, getPeer, emitState } = services;
  socket.on("call:action", ({ action, phoneNumber, companyName, contactName, imageUrl, commandId, contactId, workerId }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "dashboard") return;

    const session = sessions.get(code);
    if (!session) return;

  if (action === "dial") {
      if (historyGate.blocked(code)) {
        socket.emit("session:error", { error: "El historial tiene un guardado pendiente. Espera antes de llamar." });
        return;
      }
      if (services.isGloballyBlocked(phoneNumber)) {
        socket.emit("call:error", { message: "Número en la lista de bloqueos. Desbloquéalo antes de llamar." });
        return;
      }
      const block = annualBlock(phoneNumber);
      if (block) {
        socket.emit("call:error",{message:blockedCallMessage(block)});
        return;
      }
      session.lastNumber = phoneNumber || "";
      session.lastCompanyName = companyName || "";
      session.lastContactName = contactName || "";
      session.lastImageUrl = imageUrl || "";

      const worker = workerId
        ? getConnectedPhoneWorkers(session).find((item) => item.id === workerId)
        : getActivePhoneWorker(session);
      if (worker) {
        if (getContactByWorker(session, worker.id)) {
          socket.emit("session:error", { error: "El equipo tiene una llamada asignada. Espera a que termine." });
          return;
        }
        const tracked = ensureCampaignContact(session, {
          id: contactId || nanoid(), name: contactName || companyName || "",
          phone: phoneNumber, list: "Manual", targetWorkerId: worker.id
        });
        if (!tracked || !assignSpecificContact(session, worker, tracked.id)) return;
        contactId = tracked.id;
        worker.activeContactId = tracked.id;
        worker.callState = "dialing";
      }
      session.updatedAt = Date.now();
      saveSoon();

      if (worker) {
        console.log(`[MANUAL] Marcado directo a ${phoneNumber} vía worker ${worker.name}`);
        sendPersistedDial(code, worker.socketId, {
          action: "dial",
          phoneNumber: phoneNumber || "",
          companyName: companyName || "",
          contactName: contactName || "",
          imageUrl: imageUrl || "",
          contactId: contactId || "",
          callId: getActiveAttemptId(session, worker.id),
          commandId: commandId || nanoid()
        });
        saveSoon();
        emitState(code);
        services.refreshGlobalCallRestrictions(code);
      } else {
        console.log(`[MANUAL] Intento fallido para ${phoneNumber} (No hay worker activo)`);
        session.callState = "failed";
        saveSoon();
        emitState(code);
      }
    }

    if (action === "hangup") {
      const worker = workerId
        ? getConnectedPhoneWorkers(session).find((item) => item.id === workerId)
        : getActivePhoneWorker(session);
      if (worker) {
        io.to(worker.socketId).emit("call:action", {
          action: "hangup",
          from: "dashboard",
          contactId
        });
      }
      session.callState = "ended";
      saveSoon();
    }

    if (action === "mute" || action === "unmute" || action === "speaker_on" || action === "speaker_off" || action === "answer") {
      const worker = workerId
        ? getConnectedPhoneWorkers(session).find((item) => item.id === workerId)
        : getActivePhoneWorker(session);
      if (worker) {
        io.to(worker.socketId).emit("call:action", {
          action,
          commandId,
          contactId
        });
      }
    }

    session.updatedAt = Date.now();
    emitState(code);
    emitCampaignState(code);
  });

  socket.on("phone:status", (payload = {}) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;
    const statusReceivedAt = Date.now();
    historyGate.serialize(code, async () => {
    const statusStartedAt = Date.now();
    const { callState, phoneNumber, contactName, companyName, contactId, callId, commandId, micMuted, speakerOn, lineLabel, lastError, externalIncoming, terminalConfirmed, detectedVoicemail, detectedAnnouncement } = payload;
    const session = sessions.get(code);
    if (!session) return;

    const worker = getPhoneWorkerBySocketId(session, socket.id);
    const isExternalIncoming = Boolean(externalIncoming);
    // Independent of commands/optimistic campaign state: only an Android event is evidence.
    const currentAttemptId = worker ? getActiveAttemptId(session, worker.id) : "";
    if (isExternalIncoming || !callId || !currentAttemptId || callId === currentAttemptId) network.observe(code, worker, payload);
    if (worker) {
      worker.callState = callState || worker.callState || "idle";
      worker.speakerOn = Boolean(speakerOn);
      worker.connected = true;
      if (lineLabel) worker.lineLabel = String(lineLabel).trim();
      if (lastError) worker.lastError = String(lastError).trim();
      session.activePhoneSocketId = socket.id;
      worker.externalIncoming = isExternalIncoming;
    }
    session.callState = callState || session.callState;
    if (typeof phoneNumber === "string" && phoneNumber.trim()) {
      session.lastNumber = phoneNumber.trim();
    }
    if (typeof contactName === "string" && contactName.trim()) {
      session.lastContactName = contactName.trim();
    }
    if (typeof companyName === "string" && companyName.trim()) {
      session.lastCompanyName = companyName.trim();
    }
    session.micMuted = Boolean(micMuted);
    session.isSpeakerOn = Boolean(speakerOn);
    session.updatedAt = Date.now();
    // Mark session as dirty for targeted persistence
    runtime.persistence.markSessionDirty(code);
    let updatedContact = null;
    if (isExternalIncoming && worker) {
      if (["ringing", "dialing", "in_call"].includes(String(callState || ""))) {
        holdActiveContact(session, worker.id);
      } else if (["idle", "ended", "failed"].includes(String(callState || ""))) {
        resumeHeldContact(session, worker.id);
      }
    } else {
      const reconciledState = terminalConfirmed && callState === "idle" ? "ended" : callState;
      // An unrelated/late Telecom event must not finish the assigned attempt.
      if (contactId && callId) {
        updatedContact = updateActiveCallState(session, reconciledState, worker || {}, { lastError, contactId, callId, detectedVoicemail: detectedVoicemail === true, detectedAnnouncement });
      }
    }
    if (worker && updatedContact) {
      worker.activeContactId = ["dialing", "ringing", "in_call"].includes(updatedContact.status) ? updatedContact.id : null;
      worker.lastCompanyName = updatedContact.name || worker.lastCompanyName || "";
      worker.lastNumber = updatedContact.phone || worker.lastNumber || "";
    }
    syncSessionPhoneState(session);

    const terminal = ["ended", "failed"].includes(String(callState || ""))
      || (terminalConfirmed && callState === "idle");
    const campaign = ensureCampaign(session);
    const alreadyFinalized = terminal && contactId && callId
      && (persistence.hasFinishedAttempt(code, callId, contactId) || campaign.contacts.some((contact) => contact.id === contactId
        && contact.attemptHistory.some((attempt) => attempt.id === callId && attempt.endedAt)));
    const contactBook = session.contactBook;
    console.info("[PHONE_STATUS] persisting-session-snapshot", {
      session: String(code).slice(-2),
      callState: callState || "unknown",
      command: String(commandId || "").slice(-8),
      call: String(callId || "").slice(-8),
      terminal: Boolean(terminal),
      accepted: Boolean(updatedContact || alreadyFinalized),
      contactLists: contactBook?.lists?.length || 0,
      contactBookContacts: contactBook?.contacts?.length || 0,
      campaignContacts: campaign.contacts?.length || 0,
      note: "phone status saves the full in-memory session to MySQL"
    });
    // No successful receipt or next call until the transaction/outbox is durable.
    await historyGate.commit(code, [callId, contactId, callState, terminal].join("|"), () => {
    emitState(code);
    emitCampaignState(code);
    socket.emit("phone:status_ack", {
      persisted: true,
      accepted: Boolean(updatedContact || alreadyFinalized),
      terminal: Boolean(terminal && (updatedContact || alreadyFinalized)),
      commandId: commandId || "",
      contactId: contactId || "",
      callId: callId || ""
    });
    console.info("[PHONE_STATUS] committed", {
      session: String(code).slice(-2),
      workerId: worker?.id,
      callState: callState || "unknown",
      source: payload.source || "unknown",
      command: String(commandId || "").slice(-8),
      call: String(callId || "").slice(-8),
      accepted: Boolean(updatedContact || alreadyFinalized),
      terminal: Boolean(terminal),
      terminalConfirmed: Boolean(terminalConfirmed),
      lastError: String(lastError || "").slice(0, 120),
      queueMs: statusStartedAt - statusReceivedAt,
      persistMs: Date.now() - statusStartedAt
    });
    if (terminal && (updatedContact || alreadyFinalized) && campaign.status === "running") {
      setTimeout(() => dispatchCampaignCalls(code, worker?.id || ""), 1200);
    }
    });
    }).catch(error => {
      socket.emit("phone:status_ack", {
        accepted: false, terminal: false, persisted: false,
        commandId: payload.commandId || "", contactId: payload.contactId || "", callId: payload.callId || ""
      });
      console.error("[PHONE_STATUS] persistence-failed", {
        session: String(code).slice(-2),
        callState: payload.callState || "unknown",
        command: String(payload.commandId || "").slice(-8),
        call: String(payload.callId || "").slice(-8),
        elapsedMs: Date.now() - statusReceivedAt,
        error: error.code || error.message || "STORAGE_UNAVAILABLE"
      });
      emitState(code);
    });
  });

  socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    const log = ok ? console.info : console.warn;
    log(`[CALL_ACK] session=${String(code).slice(-2)} worker=${socket.data.workerId || "phone"} action=${action || "unknown"} ok=${Boolean(ok)} command=${String(commandId || "").slice(-8)} message=${String(message || "").slice(0,120)}`);

    const peerId = getPeer(session, "phone");
    if (!peerId) return;

    io.to(peerId).emit("phone:command_ack", {
      commandId: commandId || "",
      action: action || "",
      ok: Boolean(ok),
      message: message || "",
      at: new Date().toISOString()
    });
  });

  // ── Audio relay (binary PCM frames, 16kHz mono PCM16) ───────────────────
  // Phone mic → dashboard speaker
  socket.on("audio:phone", (data) => {
    const { code, role } = socket.data;
    if (!code || role !== "phone") return;
    const session = sessions.get(code);
    if (!session) return;
    session.activePhoneSocketId = socket.id;
    const worker = getPhoneWorkerBySocketId(session, socket.id);
    syncSessionPhoneState(session);
    const liveWorkers = getConnectedPhoneWorkers(session).filter((item) => ["dialing", "ringing", "in_call"].includes(String(item.callState || "")));
    if (!worker || liveWorkers.length !== 1 || liveWorkers[0].id !== worker.id) return;
    const peerId = getPeer(session, "phone");  // gets dashboardSocketId
    if (peerId) io.to(peerId).emit("audio:phone", data);
  });

  // Dashboard mic → phone speaker
  socket.on("audio:dashboard", (data) => {
    const { code, role } = socket.data;
    if (!code || role !== "dashboard") return;
    const session = sessions.get(code);
    if (!session) return;
    const liveWorkers = getConnectedPhoneWorkers(session).filter((item) => ["dialing", "ringing", "in_call"].includes(String(item.callState || "")));
    if (liveWorkers.length === 1) io.to(liveWorkers[0].socketId).emit("audio:dashboard", data);
  });


}
