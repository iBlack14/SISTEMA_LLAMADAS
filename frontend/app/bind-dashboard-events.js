import { socket, API_BASE } from '../shared/realtime/socket.js';
import { validateReportPeriod, isInReportPeriod, reportPeriodLabel } from '../features/reports/report-period.js';
import { refs, setStatus, setBadge, setAckBadge } from '../shared/ui/dom.js';
import * as Contacts from '../features/contacts/contacts-repository.js';
import * as WhatsApp from '../features/messaging/whatsapp.js';
import { openContactSendModal } from '../features/messaging/message-templates.js?v=20261119-email-footer2';
import { showPanelView } from './navigation/panel-navigation.js';

/**
 * createBindDashboardEvents: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.addImportedContacts, dashboardActions.addManualContact, dashboardActions.applyState, dashboardActions.callContactFromAssignedList, dashboardActions.changeBlockedNumber, dashboardActions.clearHistory, dashboardActions.createPairingQr, dashboardActions.deletePairingQr, dashboardActions.disconnectWorker, dashboardActions.downloadAssignedListReport, dashboardActions.downloadCampaignReport, dashboardActions.emitCallActionWithAck, dashboardActions.exportContactsToWord, dashboardActions.finalizeOperationalSession, dashboardActions.finalizeWorkTurn, dashboardActions.getPairingListAssignmentByName, dashboardActions.getSavedDashboardToken, dashboardActions.getUnifiedReportRows, dashboardActions.handleImportFiles, dashboardActions.handleImportUrl, dashboardActions.hangupWorkerWithResult, dashboardActions.hideAssignedRecord, dashboardActions.loadHistory, dashboardActions.loadPairingData, dashboardActions.loadUnifiedReportRows, dashboardActions.markCampaignResult, dashboardActions.markContactDisposition, dashboardActions.normalizeValidPeruPhone, dashboardActions.openAddContactModal, dashboardActions.openEditModal, dashboardActions.openHistory, dashboardActions.pauseCampaignRun, dashboardActions.postCampaignAction, dashboardActions.renderAssignedListsPanel, dashboardActions.renderBlockedNumbers, dashboardActions.renderCampaignReport, dashboardActions.renderContacts, dashboardActions.renderTabs, dashboardActions.requestAutomaticSession, dashboardActions.requestConfirmation, dashboardActions.resetImportPreview, dashboardActions.resumeCampaignRun, dashboardActions.saveModalContact, dashboardActions.saveVoiceAgentConfig, dashboardActions.setBlockedNumbersFeedback, dashboardActions.skipCampaignContact, dashboardActions.skipWorkerList, dashboardActions.startCampaignRun, dashboardActions.startDialForContact, dashboardActions.startIndependentWorker, dashboardActions.startPendingTurnRun, dashboardActions.stopCampaignRun, dashboardActions.stopIndependentWorker, dashboardActions.toggleMute, dashboardState.callCtx, dashboardState.currentPage, dashboardState.dashboardClientId, dashboardState.dashboardToken, dashboardState.reportListFilter, dashboardState.reportPeriod, dashboardState.reportResultFilter, dashboardState.reportShiftId, dashboardState.reportWorkerFilter.
 * Se construye una vez por dashboard.
 */
export function createBindDashboardEvents(dashboardState, dashboardActions) {
function bindEvents() {
  const blockedNameInput = document.getElementById("blockedContactName");
  const blockedPhoneInput = document.getElementById("blockedContactPhone");
  const blockedNumbersBody = document.getElementById("blockedNumbersBody");
  document.getElementById("blockedNumbersOpen")?.addEventListener("click", () => {
    dashboardActions.renderBlockedNumbers();
    dashboardActions.setBlockedNumbersFeedback("");
    showPanelView("blocked");
    document.getElementById("blockedNumbersSearch")?.focus({ preventScroll: true });
  });
  document.getElementById("blockedNumbersBack")?.addEventListener("click", () => showPanelView("calls"));
  document.getElementById("contactsBackBtn")?.addEventListener("click", () => showPanelView("calls"));
  document.getElementById("messagesBackBtn")?.addEventListener("click", () => showPanelView("calls"));
  document.getElementById("blockedNumbersSearch")?.addEventListener("input", dashboardActions.renderBlockedNumbers);
  const blockedForm = document.getElementById("blockedNumberForm");
  if (blockedForm) blockedForm.onsubmit = event => {
    event.preventDefault();
    const name = blockedNameInput?.value.trim() || "";
    const phone = blockedPhoneInput?.value.trim() || "";
    if (dashboardActions.changeBlockedNumber("add", name, phone)) {
      if (blockedNameInput) blockedNameInput.value = "";
      if (blockedPhoneInput) blockedPhoneInput.value = "";
    }
  };
  if (blockedNumbersBody) blockedNumbersBody.onclick = event => {
    const button = event.target.closest("button[data-remove-blocked-number]");
    if (!button) return;
    dashboardActions.changeBlockedNumber("remove", "", button.dataset.removeBlockedNumber);
  };
  document.addEventListener("reports:open", dashboardActions.loadUnifiedReportRows);
  document.addEventListener("reports:filter", event => {
    const nextPeriod = { from: event.detail?.from || "", to: event.detail?.to || "" };
    if (validateReportPeriod(nextPeriod.from, nextPeriod.to)) return;
    dashboardState.reportPeriod = nextPeriod;
    dashboardState.reportShiftId = "";
    dashboardState.reportListFilter = "";
    dashboardState.reportWorkerFilter = "";
    dashboardState.reportResultFilter = "";
    dashboardActions.renderCampaignReport();
  });
  const shiftSelect = document.getElementById("reportShiftFilter");
  if (shiftSelect) shiftSelect.onchange = () => { dashboardState.reportShiftId = shiftSelect.value; dashboardActions.renderCampaignReport(); };
  const listSelect = document.getElementById("reportListFilter");
  if (listSelect) listSelect.onchange = () => { dashboardState.reportListFilter = listSelect.value; dashboardActions.renderCampaignReport(); };
  const workerSelect = document.getElementById("reportWorkerFilter");
  if (workerSelect) workerSelect.onchange = () => { dashboardState.reportWorkerFilter = workerSelect.value; dashboardActions.renderCampaignReport(); };
  const resultSelect = document.getElementById("reportResultFilter");
  if (resultSelect) resultSelect.onchange = () => { dashboardState.reportResultFilter = resultSelect.value; dashboardActions.renderCampaignReport(); };
  if (refs.campaignReportFilterEl) refs.campaignReportFilterEl.oninput = dashboardActions.renderCampaignReport;
  if (refs.campaignReportBodyEl) refs.campaignReportBodyEl.onclick = async (event) => {
    const button = event.target.closest("button[data-report-attempt]");
    if (!button || button.disabled) return;
    const row = dashboardActions.getUnifiedReportRows().find((item) => item.attemptId === button.dataset.reportAttempt);
    if (!row) return;
    const slot = dashboardActions.getPairingListAssignmentByName(row.list)?.slot;
    const workerId = slot?.deviceId || row.workerId;
    if (!workerId) return setStatus("Vincula un equipo a esta lista para volver a llamar.", true);
    button.disabled = true;
    try {
      const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(workerId)}/call-contact`, {
        contactId: row.contactId,
        manualRetry: true,
        contact: { id: row.contactId, name: row.name, phone: row.phone, list: row.list }
      });
      if (data) setStatus("Rellamada enviada. El intento anterior permanece en el reporte.", true);
    } finally {
      button.disabled = false;
    }
  };
  if (refs.createBtn) refs.createBtn.onclick = () => dashboardActions.requestAutomaticSession();
  if (refs.joinBtn) refs.joinBtn.onclick = () => {
    const code = refs.sessionCodeIn.value.trim().toUpperCase();
    if (code) {
      dashboardState.dashboardToken = dashboardActions.getSavedDashboardToken(code);
      if (!dashboardState.dashboardToken) {
        setStatus("Recarga para recuperar el acceso de tu cuenta.", true);
        return;
      }
      socket.emit("session:join", { code, role: "dashboard", token: dashboardState.dashboardToken, dashboardClientId: dashboardState.dashboardClientId });
      dashboardActions.loadPairingData(code);
    }
  };

  refs.cBodyEl.onclick = async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const contact = Contacts.contacts.find(c => c.id === id);
    if (!contact) return;

    if (action === "dial") dashboardActions.startDialForContact(contact);
    if (action === "result-interested") dashboardActions.markContactDisposition(id, "interesado");
    if (action === "result-no-interest") dashboardActions.markContactDisposition(id, "no_interesado");
    if (action === "result-callback") dashboardActions.markContactDisposition(id, "reintentar");
    if (action === "whatsapp") WhatsApp.openWhatsAppModal(contact);
    if (action === "whatsapp-direct") {
      const phone = dashboardActions.normalizeValidPeruPhone(contact.phone);
      if (!phone) {
        setStatus("Este contacto no tiene un número peruano válido para WhatsApp.", true);
      } else {
        openContactSendModal(contact, "whatsapp");
      }
    }
    if (action === "call-direct") await dashboardActions.callContactFromAssignedList(contact.id, contact.list || "Principal");
    if (action === "edit") {
       dashboardActions.openEditModal(contact);
    }
    if (action === "delete") {
      if (await dashboardActions.requestConfirmation({ title: "Eliminar contacto", message: `¿Eliminar a ${contact.name}?`, confirmLabel: "Eliminar" })) {
        Contacts.deleteContact(id);
        dashboardActions.renderContacts();
      }
    }
  };

  refs.hangupBtnEl.onclick = () => {
    dashboardActions.emitCallActionWithAck("hangup");
    dashboardActions.applyState("ended", dashboardState.callCtx?.phone || "");
  };

  refs.muteBtnEl.onclick = dashboardActions.toggleMute;
  if (refs.addContactBtn) refs.addContactBtn.onclick = dashboardActions.addManualContact;
  if (refs.openAddContactBtn) refs.openAddContactBtn.onclick = dashboardActions.openAddContactModal;
  if (refs.floatingAddContactBtn) refs.floatingAddContactBtn.onclick = dashboardActions.openAddContactModal;
  if (refs.addCloseBtn) refs.addCloseBtn.onclick = () => { refs.addContactModalEl.style.display = "none"; };
  if (refs.addSaveBtn) refs.addSaveBtn.onclick = dashboardActions.saveModalContact;
  if (refs.addPhoneInput) refs.addPhoneInput.onkeydown = (event) => { if (event.key === "Enter") dashboardActions.saveModalContact(); };
  if (refs.importFileEl) refs.importFileEl.onchange = (e) => dashboardActions.handleImportFiles(e.target.files);
  if (refs.importConfirm) refs.importConfirm.onclick = dashboardActions.addImportedContacts;
  if (refs.importCancel) refs.importCancel.onclick = dashboardActions.resetImportPreview;
  if (refs.prevPageBtn) refs.prevPageBtn.onclick = () => {
    dashboardState.currentPage = Math.max(1, dashboardState.currentPage - 1);
    dashboardActions.renderContacts();
  };
  if (refs.nextPageBtn) refs.nextPageBtn.onclick = () => {
    dashboardState.currentPage += 1;
    dashboardActions.renderContacts();
  };
  if (refs.campaignStartBtn) refs.campaignStartBtn.onclick = dashboardActions.startCampaignRun;
  if (refs.pendingTurnCallBtn) refs.pendingTurnCallBtn.onclick = dashboardActions.startPendingTurnRun;
  if (refs.pendingTurnBodyEl) refs.pendingTurnBodyEl.onclick = async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const contact = Contacts.contacts.find((item) => item.id === button.dataset.id);
    if (!contact) return;
    if (button.dataset.action === "call-direct") {
      await dashboardActions.callContactFromAssignedList(contact.id, contact.list || "Principal");
    } else if (button.dataset.action === "whatsapp-direct") {
      const phone = dashboardActions.normalizeValidPeruPhone(contact.phone);
      if (phone) openContactSendModal(contact, "whatsapp");
      else setStatus("Este contacto no tiene un número peruano válido para WhatsApp.", true);
    }
  };
  if (refs.finalizeTurnBtn) refs.finalizeTurnBtn.onclick = dashboardActions.finalizeWorkTurn;
  if (refs.finalizeSessionBtn) refs.finalizeSessionBtn.onclick = dashboardActions.finalizeOperationalSession;
  if (refs.addPairingQrBtn) refs.addPairingQrBtn.onclick = dashboardActions.createPairingQr;
  if (refs.assignedListsPanelEl) refs.assignedListsPanelEl.onclick = async (event) => {
    const contactButton = event.target.closest("button[data-action]");
    if (contactButton) {
      const contact = Contacts.contacts.find((item) => item.id === contactButton.dataset.id);
      if (!contact) return;
      if (contactButton.dataset.action === "call-direct") {
        await dashboardActions.callContactFromAssignedList(contact.id, contact.list || "Principal");
      } else if (contactButton.dataset.action === "whatsapp-direct") {
        const phone = dashboardActions.normalizeValidPeruPhone(contact.phone);
        if (phone) openContactSendModal(contact, "whatsapp");
        else setStatus("Este contacto no tiene un número peruano válido para WhatsApp.", true);
      }
      return;
    }
    const downloadButton = event.target.closest("button[data-download-assigned-list]");
    if (downloadButton) {
      dashboardActions.downloadAssignedListReport(downloadButton.dataset.downloadAssignedList);
      return;
    }
    const deleteButton = event.target.closest("button[data-delete-assigned-list]");
    if (!deleteButton) return;
    const listName = deleteButton.dataset.deleteAssignedList;
    const accepted = await dashboardActions.requestConfirmation({
      title: "Eliminar registro terminado",
      message: `¿Quitar el registro terminado de "${listName}"? La lista original y todos sus contactos se conservarán.`,
      confirmLabel: "Eliminar registro"
    });
    if (!accepted) return;
    dashboardActions.hideAssignedRecord(listName);
    dashboardActions.renderAssignedListsPanel();
    setStatus(`Registro terminado de "${listName}" eliminado. La base original se conserva.`, true);
  };
  if (refs.pairingSlotsEl) refs.pairingSlotsEl.onchange = async (event) => {
    const select = event.target.closest("select[data-slot-list-select]");
    if (!select) return;
    await dashboardActions.assignWorkerList(select.dataset.slotListSelect, select.dataset.workerId, select.value, select.dataset.currentList);
  };
  if (refs.pairingSlotsEl) refs.pairingSlotsEl.onclick = async (event) => {
    const skipListButton = event.target.closest("button[data-skip-list-slot]");
    if (skipListButton) {
      await dashboardActions.skipWorkerList(skipListButton.dataset.skipListSlot, skipListButton.dataset.workerId, skipListButton.dataset.currentList);
      return;
    }
    const independentButton = event.target.closest("button[data-independent-pairing-slot]");
    if (independentButton) {
      if (independentButton.disabled) return;
      const workerId = independentButton.dataset.workerId;
      const showStartFeedback = (message) => {
        const button = Array.from(refs.pairingSlotsEl.querySelectorAll("button[data-independent-pairing-slot]"))
          .find((item) => item.dataset.workerId === workerId);
        const card = button?.closest(".pairing-slot-card");
        if (!card) return;
        let feedback = card.querySelector(".pairing-start-feedback");
        if (!feedback) {
          feedback = document.createElement("p");
          feedback.className = "pairing-start-feedback";
          feedback.setAttribute("role", "status");
          button.closest(".pairing-slot-call-actions").after(feedback);
        }
        feedback.textContent = message;
      };
      independentButton.disabled = true;
      setStatus("Preparando llamada y guardando contactos…", true);
      showStartFeedback("Preparando llamada y guardando contactos…");
      try {
        await dashboardActions.startIndependentWorker(workerId);
        showStartFeedback(refs.statusTextEl.textContent);
      } catch (error) {
        const message = error.message || "No se pudo iniciar la llamada.";
        setStatus(message, true);
        showStartFeedback(message);
        console.error("Error al iniciar equipo:", error);
      } finally {
        independentButton.disabled = false;
      }
      return;
    }
    const stopButton = event.target.closest("button[data-stop-pairing-slot]");
    if (stopButton) {
      await dashboardActions.stopIndependentWorker(stopButton.dataset.workerId);
      return;
    }
    const hangupButton = event.target.closest("button[data-hangup-pairing-slot]");
    if (hangupButton) {
      await dashboardActions.hangupWorkerWithResult(hangupButton.dataset.workerId);
      return;
    }
    const disconnectButton = event.target.closest("button[data-disconnect-pairing-slot]");
    if (disconnectButton) {
      await dashboardActions.disconnectWorker(disconnectButton.dataset.workerId, disconnectButton.dataset.workerName || "este teléfono");
      return;
    }
    const button = event.target.closest("button[data-delete-pairing-slot]");
    if (!button) return;
    const confirmed = await dashboardActions.requestConfirmation({
      title: "Eliminar código QR",
      message: `¿Eliminar ${button.dataset.slotLabel || "este QR"}?`,
      confirmLabel: "Eliminar"
    });
    if (confirmed) await dashboardActions.deletePairingQr(button.dataset.deletePairingSlot);
  };
  if (refs.campaignPauseBtn) refs.campaignPauseBtn.onclick = dashboardActions.pauseCampaignRun;
  if (refs.campaignResumeBtn) refs.campaignResumeBtn.onclick = dashboardActions.resumeCampaignRun;
  if (refs.campaignStopBtn) refs.campaignStopBtn.onclick = dashboardActions.stopCampaignRun;
  if (refs.campaignReportBtn) refs.campaignReportBtn.onclick = dashboardActions.downloadCampaignReport;
  if (refs.campaignSkipBtn) refs.campaignSkipBtn.onclick = dashboardActions.skipCampaignContact;
  if (refs.campaignResultAgendaBtn) refs.campaignResultAgendaBtn.onclick = () => dashboardActions.markCampaignResult("agendado");
  if (refs.campaignResultNoBtn) refs.campaignResultNoBtn.onclick = () => dashboardActions.markCampaignResult("no_interesado");
  if (refs.campaignResultAdvisorBtn) refs.campaignResultAdvisorBtn.onclick = () => dashboardActions.markCampaignResult("requiere_asesor");
  if (refs.campaignResultRetryBtn) refs.campaignResultRetryBtn.onclick = () => dashboardActions.markCampaignResult("reintentar");
  if (refs.agentDisableBtn) {
    refs.agentDisableBtn.onclick = () => dashboardActions.saveVoiceAgentConfig(false);
    refs.agentDisableBtn.disabled = true;
    refs.agentDisableBtn.title = "Agente de voz desactivado temporalmente";
  }

  // History
  if (refs.openHistoryBtn) refs.openHistoryBtn.onclick = dashboardActions.openHistory;
  if (refs.historyCloseBtn) refs.historyCloseBtn.onclick = () => { refs.historyModalEl.style.display = "none"; };
  if (refs.clearHistoryBtn) refs.clearHistoryBtn.onclick = dashboardActions.clearHistory;

  // Tabs
  dashboardActions.renderTabs();

  dashboardActions.loadHistory();


  // Missing button handlers
  if (refs.exportWordBtn) refs.exportWordBtn.onclick = dashboardActions.exportContactsToWord;
  if (refs.connectWhatsAppBtn) refs.connectWhatsAppBtn.onclick = WhatsApp.openWhatsAppConnectModal;

  // WhatsApp modal handlers
  if (refs.whatsappCloseBtn) refs.whatsappCloseBtn.onclick = WhatsApp.closeWhatsAppModal;
  if (refs.whatsappSendBtn) refs.whatsappSendBtn.onclick = WhatsApp.sendWhatsAppMessage;
  if (refs.whatsappLogoutBtn) refs.whatsappLogoutBtn.onclick = WhatsApp.logoutWhatsAppAccount;
  if (refs.whatsappTemplateSaveBtn) refs.whatsappTemplateSaveBtn.onclick = WhatsApp.saveNewWhatsAppPresetMessage;

  // WhatsApp file drop zone handlers
  if (refs.whatsappDropZone) {
    refs.whatsappDropZone.onclick = () => refs.whatsappFileInput?.click();

    refs.whatsappDropZone.ondragover = (e) => {
      e.preventDefault();
      refs.whatsappDropZone.classList.add("drag-over");
    };

    refs.whatsappDropZone.ondragleave = () => {
      refs.whatsappDropZone.classList.remove("drag-over");
    };

    refs.whatsappDropZone.ondrop = (e) => {
      e.preventDefault();
      refs.whatsappDropZone.classList.remove("drag-over");
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        refs.whatsappFileInput.files = files;
        WhatsApp.updateWhatsAppFileLabel();
      }
    };

    if (refs.whatsappFileInput) {
      refs.whatsappFileInput.onchange = WhatsApp.updateWhatsAppFileLabel;
    }
  }
}
return { bindEvents };
}
