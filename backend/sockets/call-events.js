import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import { logOperationalCall } from "../services/campaigns/operational-log.js";
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
  const { saveSoon, getConnectedPhoneWorkers, getPhoneWorkerBySocketId, getActivePhoneWorker, syncSessionPhoneState, emitCampaignState, annualBlock, blockedCallMessage, sendPersistedDial, dispatchCampaignCalls, getPeer, emitState, acknowledgeDialReceipt, acknowledgeDialDelivery } = services;
  socket.on("phone:call_trace", (payload = {}) => {
    if (socket.data.role !== "phone") return;
    const allowedStages = new Set([
      "apk_socket_received", "apk_received", "dial_started", "dial_rejected", "place_call_accepted",
      "place_call_failed", "dial_timeout", "fallback_call_accepted"
    ]);
    const stage = String(payload.stage || "");
    if (!allowedStages.has(stage)) return;
    const code = socket.data.code;
    const session = code && sessions.get(code);
    const worker = session && getPhoneWorkerBySocketId(session, socket.id);
    const command = String(payload.commandId || "").slice(-8);
    const call = String(payload.callId || "").slice(-8);
    const detail = /^[a-z0-9_-]{1,64}$/i.test(String(payload.detail || "")) ? String(payload.detail) : "";
    const mainQueueMs = Number(payload.mainQueueMs);
    const timing = Number.isFinite(mainQueueMs) && mainQueueMs >= 0 && mainQueueMs <= 600000 ? ` mainQueueMs=${Math.round(mainQueueMs)}` : "";
    console.info(`[CALL_TRACE] stage=${stage} session=${String(code || "").slice(-2)} worker=${String(worker?.id || "").slice(-8)} command=${command} call=${call}${detail ? ` detail=${detail}` : ""}${timing}`);
  });

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
      commandId = commandId || nanoid();
      console.info(`[CALL_TRACE] stage=dashboard_requested session=${String(code).slice(-2)} worker=${String(worker?.id || "none").slice(-8)} command=${String(commandId || "").slice(-8)} call=${String(worker ? getActiveAttemptId(session, worker.id) : "").slice(-8)} result=${worker ? "accepted" : "no_worker"}`);
      session.updatedAt = Date.now();
      saveSoon(code);

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
          commandId
        });
        saveSoon(code);
        emitState(code);
        services.refreshGlobalCallRestrictions(code);
      } else {
        console.log(`[MANUAL] Intento fallido para ${phoneNumber} (No hay worker activo)`);
        session.callState = "failed";
        saveSoon(code);
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
      saveSoon(code);
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
    if (!worker) return;
    if (!["idle", "available", "dialing", "ringing", "in_call", "ended", "failed"].includes(callState)) return;
    // Liveness for the watchdog: any phone:status (including the in_call heartbeat,
    // even if deduplicated below) proves the device is alive and on the call.
    if (worker) worker.lastStatusAt = Date.now();
    if (commandId && worker) acknowledgeDialDelivery?.(code, worker.id, commandId, callId);

    // Only a repeated packet is a duplicate. The same physical state can carry
    // new speaker, voicemail or terminal-confirmation information.
    const statusSessionId = typeof payload.statusSessionId === "string" ? payload.statusSessionId.slice(0, 128) : "";
    const statusSequence = Number(payload.statusSequence);
    const sequenced = Boolean(statusSessionId && Number.isSafeInteger(statusSequence) && statusSequence > 0);
    const previous = socket.data.committedPhoneStatus;
    if (sequenced && previous?.sessionId === statusSessionId && statusSequence <= previous.sequence) {
      socket.emit("phone:status_ack", statusSequence === previous.sequence
        ? { ...previous.receipt, duplicate: true }
        : { persisted: false, accepted: false, terminal: false, reason: "stale_sequence", commandId: commandId || "", contactId: contactId || "", callId: callId || "" });
      return;
    }

    const isExternalIncoming = Boolean(externalIncoming);
    // Independent of commands/optimistic campaign state: only an Android event is evidence.
    const currentAttemptId = worker ? getActiveAttemptId(session, worker.id) : "";
    if (!isExternalIncoming && callId && currentAttemptId && callId !== currentAttemptId) {
      console.warn(`[PHONE_SYNC] stale-call session=${String(code).slice(-2)} worker=${String(worker.id).slice(-8)} state=${callState}`);
      socket.emit("phone:status_ack", { persisted: false, accepted: false, terminal: false, reason: "stale_call", commandId: commandId || "", contactId: contactId || "", callId });
      return;
    }
    const assignedContact = getContactByWorker(session, worker.id);
    const transientIdle = !isExternalIncoming && callState === "idle" && !terminalConfirmed
      && ["dialing", "ringing", "in_call"].includes(assignedContact?.status);
    const effectiveState = transientIdle ? assignedContact.status : callState;
    if (!transientIdle && (isExternalIncoming || !callId || !currentAttemptId || callId === currentAttemptId)) network.observe(code, worker, payload);
    if (worker) {
      worker.callState = effectiveState || worker.callState || "idle";
      worker.speakerOn = Boolean(speakerOn);
      worker.connected = true;
      if (lineLabel) worker.lineLabel = String(lineLabel).trim();
      if (lastError) worker.lastError = String(lastError).trim();
      session.activePhoneSocketId = socket.id;
      worker.externalIncoming = isExternalIncoming;
      // Store voicemail/terminal info on worker for state:changed
      worker.detectedVoicemail = Boolean(detectedVoicemail);
      worker.detectedAnnouncement = detectedAnnouncement || "";
      worker.terminalConfirmed = Boolean(terminalConfirmed);
      network.notifyChanged();
    }
    session.callState = effectiveState || session.callState;
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
    // Publish Android's observed state immediately. Durable receipts and dispatch
    // of the next call still wait for the transaction below.
    emitState(code);
    console.info(`[PHONE_SYNC] observed session=${String(code).slice(-2)} worker=${String(worker.id).slice(-8)} state=${effectiveState} reported=${callState} sequence=${sequenced ? statusSequence : "legacy"} queueMs=${statusStartedAt - statusReceivedAt}`);
    // No successful receipt or next call until the transaction/outbox is durable.
    await historyGate.commit(code, [callId, contactId, callState, terminal].join("|"), () => {
    emitState(code);
    emitCampaignState(code);
    const receipt = {
      persisted: true,
      accepted: Boolean(updatedContact || alreadyFinalized),
      terminal: Boolean(terminal && (updatedContact || alreadyFinalized)),
      commandId: commandId || "",
      contactId: contactId || "",
      callId: callId || ""
    };
    if (sequenced) socket.data.committedPhoneStatus = { sessionId: statusSessionId, sequence: statusSequence, receipt };
    socket.emit("phone:status_ack", receipt);
    if (statusStartedAt - statusReceivedAt > 1000 || Date.now() - statusStartedAt > 1000) {
      console.warn(`[PHONE_SYNC] delayed session=${String(code).slice(-2)} worker=${String(worker.id).slice(-8)} state=${callState} queueMs=${statusStartedAt - statusReceivedAt} persistMs=${Date.now() - statusStartedAt}`);
    }
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
    if (callState) {
      const finalizedContact = alreadyFinalized && contactId
        ? campaign.contacts.find((contact) => contact.id === String(contactId))
        : null;
      if (updatedContact || finalizedContact || (!contactId && !callId && ["idle", "available"].includes(callState))) {
        logOperationalCall({
          campaign,
          worker,
          contact: updatedContact || finalizedContact,
          state: callState,
          event: "LLAMADA",
          sessionCode: code,
          username: session.ownerUsername
        });
      } else if (worker && callId && currentAttemptId && callId !== currentAttemptId) {
        const currentContact = campaign.contacts.find((contact) => contact.id === worker.activeContactId);
        console.warn(`[ESTADO_IGNORADO] Usuario: ${String(session.ownerUsername || "desconocido")} | Sesión: ${code} | ${String(worker.name || worker.deviceName || worker.id).replace(/[|\r\n]/g, " ")} | Llegó «${String(callState).replace(/[|\r\n]/g, " ")}» de otra llamada | Llamada actual: ${String(currentContact?.name || "sin contacto").replace(/[|\r\n]/g, " ")}`);
      }
    }
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

  socket.on("phone:command_received", ({ commandId, action }) => {
    const code = socket.data.code;
    if (!code || socket.data.role !== "phone" || action !== "dial") return;
    const session = sessions.get(code);
    const worker = session && getPhoneWorkerBySocketId(session, socket.id);
    const assignment = worker && session.campaign?.assignments?.[worker.id];
    if (!assignment?.attemptId || String(commandId || "") !== `campaign-${assignment.attemptId}`) return;
    const firstReceipt = acknowledgeDialReceipt?.(code, worker.id, commandId, assignment.attemptId);
    if (firstReceipt) console.info(`[CALL_DELIVERY] APK recibió orden sesión=${String(code).slice(-2)} equipo=${String(worker.id).slice(-8)} intento=${String(assignment.attemptId).slice(-8)}`);
  });

  socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    const worker = getPhoneWorkerBySocketId(session, socket.id);
    if (action === "dial" && worker) {
      const assignment = session.campaign?.assignments?.[worker.id];
      if (assignment?.attemptId && String(commandId || "") === `campaign-${assignment.attemptId}`) {
        const firstConfirmation = acknowledgeDialDelivery?.(code, worker.id, commandId, assignment.attemptId, Boolean(ok));
        if (firstConfirmation) {
          const contact = session.campaign?.contacts?.find(item => item.id === assignment.contactId);
          const deliveryLog = `[CALL_DELIVERY] Android ${ok ? "confirmó" : "rechazó"} la orden sesión=${String(code).slice(-2)} equipo=${String(worker.id).slice(-8)} contacto=${String(contact?.name || "sin nombre").slice(0, 40)} intento=${String(assignment.attemptId).slice(-8)}${ok ? "" : ` motivo=${String(message || "sin detalle").replace(/[|\r\n]/g, " ").slice(0, 100)}`}`;
          (ok ? console.info : console.error)(deliveryLog);
        }
      }
    }
    const contact = worker ? getContactByWorker(session, worker.id) : null;
    logOperationalCall({
      campaign: ensureCampaign(session),
      worker,
      contact,
      state: ok ? "accepted" : "rejected",
      event: "ORDEN",
      sessionCode: code,
      username: session.ownerUsername,
      detail: ok ? "" : `${action || "acción desconocida"}${message ? `: ${String(message).slice(0, 80)}` : ""}`
    });
    const activeAssignment = worker && session.campaign?.assignments?.[worker.id];
    console.info(`[CALL_TRACE] stage=apk_ack session=${String(code).slice(-2)} worker=${String(worker?.id || "").slice(-8)} action=${action || "unknown"} ok=${Boolean(ok)} command=${String(commandId || "").slice(-8)} call=${String(activeAssignment?.attemptId || "").slice(-8)}`);
    console.info(`[CALL_ACK] session=${String(code).slice(-2)} worker=${socket.data.workerId || "phone"} action=${action || "unknown"} ok=${Boolean(ok)} command=${String(commandId || "").slice(-8)}`);

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
