import { socket, API_BASE } from '../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../shared/ui/dom.js';
import * as Contacts from '../features/contacts/contacts-repository.js';
import * as WhatsApp from '../features/messaging/whatsapp.js';
import { openQuoteModal } from '../features/reservations/reservations-controller.js';

/**
 * bindDashboardEvents: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.applyState, dashboardActions.dialManual, dashboardActions.fetchCampaignState, dashboardActions.loadPairingData, dashboardActions.renderBlockedNumbers, dashboardActions.renderCampaignPanel, dashboardActions.renderContacts, dashboardActions.renderMessageContacts, dashboardActions.renderReminderFloat, dashboardActions.renderShiftManagement, dashboardActions.renderTabs, dashboardActions.renderWorkersPanel, dashboardActions.requestAutomaticSession, dashboardActions.requestConfirmation, dashboardActions.saveSessionCode, dashboardActions.setBlockedNumbersFeedback, dashboardActions.startCampaignRun, dashboardActions.syncCampaignResultsToContacts, dashboardActions.syncTurnPendingContacts, dashboardActions.updateSessionUi, dashboardState.DASHBOARD_SESSION_KEY, dashboardState.DASHBOARD_TOKEN_PREFIX, dashboardState.autoSessionRequested, dashboardState.callCtx, dashboardState.campaignState, dashboardState.currentPhoneLinked, dashboardState.dashboardToken, dashboardState.latestSessionState, dashboardState.normalCampaignResumeRequested, dashboardState.pairingStateSignature, dashboardState.pendingCommandTimeouts, dashboardState.pendingRecoveryRunning, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function bindDashboardEvents(dashboardState, dashboardActions) {
let previousBlockedSignature = "";
let previousContactSignature = "";
let previousShiftSignature = "";
window.addEventListener("contact-book:loaded", () => {
  WhatsApp.loadWhatsAppPresetMessages();
  dashboardActions.renderTabs();
  dashboardActions.renderContacts();
  dashboardActions.renderCampaignPanel();
  if (dashboardActions.renderPairingSlotsOnly) dashboardActions.renderPairingSlotsOnly();
  if (dashboardActions.renderAssignedListsPanel) dashboardActions.renderAssignedListsPanel();
});

window.addEventListener("contact-book:error", event => {
  setStatus(event.detail + " No cierres esta página; recarga para recuperar la base confirmada.", true);
});

window.AppDialogs = {
  confirm: (message, title = "Confirmar acción") => dashboardActions.requestConfirmation({ title, message }),
  alert: (message, title = "Aviso") => dashboardActions.requestConfirmation({ title, message, confirmLabel: "Entendido", showCancel: false })
};

window.dismissReminder = (id) => {
    Contacts.dismissedReminderIds[id] = true;
    Contacts.saveDismissedReminders();
    dashboardActions.renderReminderFloat();
};

socket.on("quote:open_modal", data => openQuoteModal(data));

socket.on("contact-book:changed", async (payload) => {
  if (payload?.revision && typeof Contacts.getRevision === "function" && payload.revision <= Contacts.getRevision()) {
    return;
  }
  if (Contacts && typeof Contacts.refreshDatabase === "function") {
    await Contacts.refreshDatabase().catch(() => {});
  }
});

socket.on("call:error", ({message}) => setStatus(message || "No se permite llamar a este número.", true));

socket.on("state:changed", st => {
  dashboardActions.updateSessionUi(st);
  dashboardActions.applyState(st.callState, st.lastNumber, st);
  const blockedSignature = JSON.stringify(st.blockedNumbers || []);
  if (blockedSignature !== previousBlockedSignature) {
    previousBlockedSignature = blockedSignature;
    dashboardActions.renderBlockedNumbers();
  }
  const contactSignature = JSON.stringify([
    st.callRestrictions || {},
    st.callState || "idle",
    st.lastNumber || "",
    (st.phoneWorkers || []).map((worker) => [worker.id, worker.callState || "idle", worker.activeContactId || ""])
  ]);
  if (contactSignature !== previousContactSignature) {
    previousContactSignature = contactSignature;
    dashboardActions.renderContacts();
    dashboardActions.renderAssignedListsPanel();
  }
  const shiftSignature = JSON.stringify(st.shiftManagement || {});
  if (shiftSignature !== previousShiftSignature) {
    previousShiftSignature = shiftSignature;
    dashboardActions.renderShiftManagement();
  }
  const nextDeviceSignature = JSON.stringify((st.phoneWorkers || []).map((worker) => [
    worker.id,
    Boolean(worker.connected)
  ]));
  const nextCallSignature = JSON.stringify((st.phoneWorkers || []).map((worker) => [
    worker.id,
    worker.callState || "idle",
    worker.companyName || "",
    worker.phoneNumber || "",
    Boolean(worker.speakerOn),
    worker.detectorState || "unknown",
    Boolean(worker.paused)
  ]));

  if (nextDeviceSignature !== dashboardState.pairingDeviceSignature) {
    dashboardState.pairingDeviceSignature = nextDeviceSignature;
    dashboardState.pairingStateSignature = nextCallSignature;
    // pairing data already in st.phoneWorkers and st.pairingSlots from state:changed
    if (dashboardActions.updatePairingSlotsFromState && st.pairingSlots) {
      dashboardActions.updatePairingSlotsFromState(st.pairingSlots);
    } else if (dashboardActions.renderPairingSlotsOnly) {
      dashboardActions.renderPairingSlotsOnly();
    }
  } else if (nextCallSignature !== dashboardState.pairingStateSignature) {
    dashboardState.pairingStateSignature = nextCallSignature;
    if (dashboardActions.renderPairingSlotsOnly) {
      dashboardActions.renderPairingSlotsOnly();
    }
  }
});

socket.on("messages:contacts", ({ contacts }) => dashboardActions.renderMessageContacts(contacts));

socket.on("blocked-numbers:ack", ({ action, phone }) => {
  const message = action === "add" ? `Número ${phone} agregado a la lista de bloqueos.` : `Número ${phone} quitado de la lista.`;
  setStatus(message, true);
  dashboardActions.setBlockedNumbersFeedback(message);
});

socket.on("blocked-numbers:error", ({ message }) => {
  const text = message || "No se pudo actualizar la lista de bloqueos.";
  setStatus(text, true);
  dashboardActions.setBlockedNumbersFeedback(text, true);
});

socket.on("campaign:state", st => {
  if (String(st?.listName || "") === "Pendientes del turno" && String(st?.status || "") === "running") {
    dashboardState.pendingRecoveryRunning = true;
  }
  const pendingCampaignFinished = dashboardState.pendingRecoveryRunning
    && String(st?.listName || "") === "Pendientes del turno"
    && String(st?.status || "") === "completed";
  dashboardState.campaignState = st;
  dashboardActions.syncCampaignResultsToContacts();
  dashboardActions.syncTurnPendingContacts();
  dashboardActions.renderCampaignPanel();
  dashboardActions.renderPairingSlotsOnly();
  dashboardActions.renderContacts();
  if (pendingCampaignFinished && !dashboardState.normalCampaignResumeRequested) {
    dashboardState.pendingRecoveryRunning = false;
    dashboardState.normalCampaignResumeRequested = true;
    setTimeout(async () => {
      try {
        await dashboardActions.startCampaignRun();
      } finally {
        dashboardState.normalCampaignResumeRequested = false;
      }
    }, 400);
  }
});

setInterval(() => {
  if ((dashboardState.latestSessionState?.phoneWorkers || []).some((worker) => worker.callState === "in_call")) dashboardActions.renderWorkersPanel();
  for (const timer of document.querySelectorAll('#callsContent:not([hidden]) .call-equipment-duration[data-started-at]')) {
    const started = Date.parse(timer.dataset.startedAt);
    if (Number.isFinite(started)) timer.textContent = dashboardActions.formatSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
  }
}, 1000);

socket.on("session:created", ({ code, dashboardToken: createdToken }) => {
  dashboardState.autoSessionRequested = false;
  dashboardState.sessionCode = code;
  dashboardState.dashboardToken = String(createdToken || "");
  refs.sessionCodeIn.value = code;
  dashboardActions.saveSessionCode(code, dashboardState.dashboardToken);
  dashboardActions.updateSessionUi({ connected: { dashboard: true, phone: false } });
  dashboardActions.loadPairingData(code);
  dashboardActions.fetchCampaignState(code);
});

socket.on("session:joined", ({ code, role }) => {
  if (role === "dashboard") {
    dashboardState.sessionCode = code;
    refs.sessionCodeIn.value = code;
    dashboardActions.saveSessionCode(code);
    dashboardActions.updateSessionUi({ connected: { dashboard: true, phone: dashboardState.currentPhoneLinked } });
    dashboardActions.loadPairingData(code);
    dashboardActions.fetchCampaignState(code);
  }
});

socket.on("session:error", ({ message, reason }) => {
  if (["AUTH_REQUIRED", "AUTH_ORIGIN", "AUTH_UNAVAILABLE", "FORBIDDEN", "SESSION_FORBIDDEN", "WORKSPACE_UNAVAILABLE"].includes(reason)) {
    dashboardState.autoSessionRequested = false;
    setStatus(message || "No se pudo validar el acceso.", true);
    if (reason === "AUTH_REQUIRED") window.location.replace("/login");
    return;
  }
  if (dashboardState.sessionCode && !dashboardState.autoSessionRequested) {
    if (reason === "dashboard_in_use") {
      localStorage.removeItem(dashboardState.DASHBOARD_SESSION_KEY);
      localStorage.removeItem(`${dashboardState.DASHBOARD_TOKEN_PREFIX}${dashboardState.sessionCode}`);
      setStatus(message || "Recuperando el espacio de tu cuenta...", true);
    }
    dashboardState.sessionCode = "";
    dashboardState.dashboardToken = "";
    dashboardActions.requestAutomaticSession();
    return;
  }
  dashboardState.autoSessionRequested = false;
  setStatus(message || "No se pudo cargar tu espacio de trabajo.", true);
});

socket.on("connect", () => {
  dashboardState.autoSessionRequested = false;
  dashboardActions.requestAutomaticSession();
});

socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
  const timeoutId = dashboardState.pendingCommandTimeouts.get(commandId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    dashboardState.pendingCommandTimeouts.delete(commandId);
  }
  setAckBadge(
    refs.apkAckBadgeEl,
    ok ? "ok" : "error",
    ok ? `APK · ${action} ok` : `APK · ${action} error`
  );
  if (refs.callHintEl) {
    refs.callHintEl.textContent = message || (ok ? "Orden recibida por el celular." : "El celular rechazó la orden.");
  }
  if (!ok && action === "dial") {
    dashboardActions.applyState("failed", dashboardState.callCtx?.phone || "");
  }
});

window.dialFromHistory = (phone) => {
  refs.historyModalEl.style.display = "none";
  dashboardActions.dialManual(phone, "Historial");
};
}
