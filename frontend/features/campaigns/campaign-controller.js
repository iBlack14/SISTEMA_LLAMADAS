import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import * as Contacts from '../contacts/contacts-repository.js';
import { apiFetch as fetch, currentUser, bindAccountControls } from '../auth/auth-session.js';

/**
 * createCampaignController: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardActions.getPairingListAssignments, dashboardActions.loadTurnPendingContacts, dashboardActions.normalizeValidPeruPhone, dashboardActions.renderAssignedListsPanel, dashboardActions.renderCampaignReport, dashboardActions.renderShiftManagement, dashboardActions.renderTurnPendingContacts, dashboardActions.renderWorkersPanel, dashboardActions.requestListName, dashboardActions.syncTurnPendingContacts, dashboardState.campaignState, dashboardState.dashboardToken, dashboardState.latestSessionState, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createCampaignController(dashboardState, dashboardActions) {
function getCampaignContactMap() {
  return new Map((dashboardState.campaignState?.contacts || []).map((contact) => [contact.id, contact]));
}

function getActiveCampaignContact() {
  if (!dashboardState.campaignState?.activeContactId) return null;
  return getCampaignContactMap().get(dashboardState.campaignState.activeContactId) || null;
}

function campaignCounter(label, value, tone = "") {
  return `<div class="campaign-counter ${tone}"><span>${dashboardActions.escHtml(label)}</span><strong>${value}</strong></div>`;
}

let _renderCampaignPanelPending = false;
function renderCampaignPanel() {
  // requestAnimationFrame: evita múltiples re-renders en el mismo frame
  if (_renderCampaignPanelPending) return;
  _renderCampaignPanelPending = true;
  requestAnimationFrame(() => {
    _renderCampaignPanelPending = false;
    _renderCampaignPanelSync();
  });
}
function _renderCampaignPanelSync() {
  dashboardActions.syncTurnPendingContacts();
  dashboardActions.renderTurnPendingContacts();
  dashboardActions.renderShiftManagement();
  dashboardActions.renderWorkersPanel();
  dashboardActions.renderCampaignReport();
  dashboardActions.renderAssignedListsPanel();
  const campaignStatus = String(dashboardState.campaignState?.status || "idle");
  const assignmentsCount = Object.keys(dashboardState.campaignState?.assignments || {}).length;
  const availableContactLists = new Set();
  for (const contact of Contacts.contacts) {
    if (dashboardActions.normalizeValidPeruPhone(contact.phone)) availableContactLists.add(contact.list || "Principal");
  }
  const availableLists = Contacts.lists.filter(name => availableContactLists.has(name));
  const availableWorkers = (dashboardState.latestSessionState?.phoneWorkers || []).filter((worker) => worker.connected && !worker.paused).length;
  if (refs.campaignStartBtn) {
    const campaignBusy = campaignStatus === "running" || assignmentsCount > 0;
    refs.campaignStartBtn.disabled = campaignBusy || !availableLists.length || !availableWorkers;
    refs.campaignStartBtn.title = !availableLists.length
      ? "Importa una lista de contactos primero."
      : !availableWorkers ? "No hay teléfonos conectados y disponibles. Revisa la conexión de la APK y pulsa Reconectar bridge." : campaignBusy ? "Detén o completa la campaña actual antes de iniciar otra." : "";
    if (refs.campaignStartHint) {
      refs.campaignStartHint.textContent = refs.campaignStartBtn.title;
      refs.campaignStartHint.hidden = !refs.campaignStartBtn.title;
    }
  }
  if (refs.campaignStartBtn) refs.campaignStartBtn.textContent = "Iniciar todos";
  if (refs.pendingTurnCallBtn) {
    const pendingCount = dashboardActions.loadTurnPendingContacts().length;
    const campaignBusy = campaignStatus === "running" || assignmentsCount > 0;
    refs.pendingTurnCallBtn.disabled = !pendingCount || campaignBusy || !availableWorkers;
    refs.pendingTurnCallBtn.title = !pendingCount
      ? "No hay números que hayan agotado sus intentos."
      : !availableWorkers ? "No hay equipos disponibles." : campaignBusy ? "Espera a que termine la campaña actual." : "";
  }
  const counts = dashboardState.campaignState?.counts || {};
  const active = getActiveCampaignContact();
  const callbacks = dashboardState.campaignState?.callbacks || [];
  const pendingCallbacks = callbacks.filter(c => c.status === "pending").length;

  if (refs.callbacksSummaryEl) {
    refs.callbacksSummaryEl.textContent = `${pendingCallbacks} pendientes`;
  }

  if (refs.campaignStatusLineEl) {
    const status = String(dashboardState.campaignState?.status || "idle");
    const labelMap = {
      idle: "Sin campaña activa.",
      running: "Campaña corriendo.",
      paused: "Campaña pausada.",
      completed: "Campaña completada."
    };
    refs.campaignStatusLineEl.textContent = labelMap[status] || `Campaña ${status}`;
  }

  if (refs.campaignCountersEl) {
    refs.campaignCountersEl.innerHTML = [
      campaignCounter("Pendientes", counts.pending || 0),
      campaignCounter("Reintentos", counts.retry_pending || 0, "accent"),
      campaignCounter("Llamando", (counts.dialing || 0) + (counts.ringing || 0), "warn"),
      campaignCounter("En llamada", counts.in_call || 0, "ok"),
      campaignCounter("Callbacks", counts.awaiting_callback || 0, "accent"),
      campaignCounter("Completados", counts.completed || 0, "ok"),
      campaignCounter("Fallidos", counts.failed || 0, "danger")
    ].join("");
  }

  if (refs.campaignActiveCardEl) {
    refs.campaignActiveCardEl.innerHTML = active
      ? `
        <div class="campaign-active-card">
          <strong>${dashboardActions.escHtml(active.name)}</strong>
          <span>${dashboardActions.escHtml(active.phone)}</span>
          <small>${dashboardActions.escHtml(active.note || "Sin nota")}</small>
          <small>Intentos: ${active.attempts || 0}${active.assignedWorkerId ? ` · Worker: ${dashboardActions.escHtml(active.assignedWorkerId)}` : ""}</small>
        </div>
      `
      : `<div class="campaign-list-empty">Sin contacto activo.</div>`;
  }

  const disableResult = !active;
  if (refs.campaignResultAgendaBtn) refs.campaignResultAgendaBtn.disabled = disableResult;
  if (refs.campaignResultNoBtn) refs.campaignResultNoBtn.disabled = disableResult;
  if (refs.campaignResultAdvisorBtn) refs.campaignResultAdvisorBtn.disabled = disableResult;
  if (refs.campaignResultRetryBtn) refs.campaignResultRetryBtn.disabled = disableResult;
  if (refs.campaignPauseBtn) refs.campaignPauseBtn.disabled = dashboardState.campaignState?.status !== "running";
  if (refs.campaignResumeBtn) refs.campaignResumeBtn.disabled = !["paused", "idle"].includes(String(dashboardState.campaignState?.status || "idle"));
  if (refs.campaignSkipBtn) refs.campaignSkipBtn.disabled = disableResult;
  if (refs.campaignStopBtn) refs.campaignStopBtn.style.display = ["running", "paused"].includes(campaignStatus) || assignmentsCount ? "" : "none";
  if (refs.campaignPauseBtn) refs.campaignPauseBtn.style.display = campaignStatus === "running" ? "" : "none";
  if (refs.campaignResumeBtn) refs.campaignResumeBtn.style.display = campaignStatus === "paused" ? "" : "none";
  if (refs.campaignSkipBtn) refs.campaignSkipBtn.style.display = active ? "" : "none";

  if (refs.callbacksListEl) {
    refs.callbacksListEl.innerHTML = callbacks.length
      ? callbacks.map((item) => `
          <div class="callback-item ${item.status === "completed" ? "is-completed" : ""}">
            <strong>${dashboardActions.escHtml(item.name || "Contacto")}</strong>
            <span>${dashboardActions.escHtml(item.phone || "-")}</span>
            <small>${dashboardActions.escHtml(item.reason || "Sin motivo")}</small>
            <small>${dashboardActions.escHtml(item.advisor ? `Asesor: ${item.advisor}` : "Asesor sin asignar")}</small>
          </div>
        `).join("")
      : `<div class="campaign-list-empty">Sin callbacks pendientes.</div>`;
  }
}

async function fetchCampaignState(code = dashboardState.sessionCode) {
  if (!code) return;
  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(code)}/campaign`, {
      headers: { "X-Dashboard-Token": dashboardState.dashboardToken }
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    dashboardState.campaignState = data.campaign || null;
    renderCampaignPanel();
  } catch (error) {
    console.error("Campaign state fetch error:", error);
  }
}

async function postCampaignAction(path, body = {}) {
  if (!dashboardState.sessionCode) {
    setStatus("Espera a que cargue tu espacio de trabajo.", true);
    return null;
  }

  try {
    if (/\/(start|resume|dispatch|start-independent|call-contact|continue|switch-list)$/.test(path)) {
      try {
        await Contacts.flushDatabase();
      } catch (flushErr) {
        if (flushErr?.conflict || flushErr?.status === 409 || String(flushErr?.message || "").includes("La base cambió")) {
          if (typeof Contacts.refreshDatabase === "function") {
            await Contacts.refreshDatabase(true).catch(() => {});
          }
        } else {
          throw flushErr;
        }
      }
    }
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(dashboardState.sessionCode)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Token": dashboardState.dashboardToken },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setStatus(data.error || "No se pudo ejecutar la acción de campaña.", true);
      return null;
    }
    dashboardState.campaignState = data.campaign || dashboardState.campaignState;
    renderCampaignPanel();
    return data;
  } catch (error) {
    console.error("Campaign action error:", error);
    setStatus(error.message || "No se pudo comunicar la acción de campaña.", true);
    return null;
  }
}

async function stopCampaignRun() {
  const data = await postCampaignAction("/campaign/stop");
  if (data) setStatus("Campaña detenida. El historial se conservó.", true);
}

async function saveVoiceAgentConfig(enabled) {
  void enabled;
  setStatus("Agente de voz desactivado por ahora.");
  return null;
}

async function startCampaignRunLegacy() {
  if (!Contacts.contacts.length) {
    setStatus("Importa o agrega contactos antes de iniciar la campaña.", true);
    return;
  }
  const data = await postCampaignAction("/campaign/start", {
    contacts: Contacts.contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      note: contact.note || ""
    }))
  });
  if (data) setStatus("Campaña iniciada.", true);
}

async function startCampaignRun() {
  const eligibleForGeneral = (contact) => !["completed", "failed", "awaiting_callback"].includes(String(contact.campaignStatus || ""))
    && contact.technicalResult !== "no_contactado";
  const listAssignments = dashboardActions.getPairingListAssignments();
  const workerByList = new Map(listAssignments.map(({ listName, slot }) => [listName, slot.deviceId]));
  const assignedListNames = new Set(workerByList.keys());
  const selectedContacts = Contacts.contacts.filter((contact) =>
    dashboardActions.normalizeValidPeruPhone(contact.phone) && eligibleForGeneral(contact)
  );
  const listName = "Asignación automática";
  if (!selectedContacts.length) {
    setStatus(`La lista ${listName} no tiene contactos.`, true);
    return;
  }
  const connectedCount = (dashboardState.latestSessionState?.phoneWorkers || []).filter((worker) => worker.connected && !worker.paused).length;
  if (!connectedCount) {
    setStatus("Vincula al menos un teléfono disponible antes de iniciar.", true);
    return;
  }
  const data = await postCampaignAction("/campaign/start", {
    listName,
    maxAttempts: 2,
    contacts: selectedContacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      phone: dashboardActions.normalizeValidPeruPhone(contact.phone),
      note: contact.note || "",
      list: contact.list || "Principal",
      targetWorkerId: assignedListNames.has(contact.list || "Principal")
        ? (workerByList.get(contact.list || "Principal") || "")
        : ""
    }))
  });
  if (data) {
    const dispatched = Number(data.dispatched || 0);
    if (!dispatched) {
      setStatus("La campaña se preparó, pero ningún equipo estaba disponible para recibir la primera llamada. Revisa el estado de los equipos e inténtalo nuevamente.", true);
      return;
    }
    setStatus(`Llamada general iniciada: ${selectedContacts.length} contactos y ${dispatched} llamadas enviadas.`, true);
  }
}

async function pauseCampaignRun() {
  const data = await postCampaignAction("/campaign/pause");
  if (data) setStatus("Campaña pausada.", true);
}

async function resumeCampaignRun() {
  const data = await postCampaignAction("/campaign/resume");
  if (data) setStatus("Campaña reanudada.", true);
}

async function skipCampaignContact() {
  const data = await postCampaignAction("/campaign/skip");
  if (data) setStatus("Contacto saltado y marcado para reintento.", true);
}

async function markCampaignResult(result) {
  const active = getActiveCampaignContact();
  if (!active) {
    setStatus("No hay contacto activo en campaña.", true);
    return;
  }

  const payload = { contactId: active.id, result };
  if (result === "requiere_asesor") {
    const callbackReason = await dashboardActions.requestListName({
      title: "Derivar a un asesor",
      label: "Motivo de derivación",
      placeholder: "Ej. Solicita información comercial",
      defaultValue: active.callbackReason || "Solicitó asesor"
    });
    if (!callbackReason) return;
    const assignedAdvisor = await dashboardActions.requestListName({
      title: "Asignar asesor",
      label: "Nombre del asesor",
      placeholder: "Ej. Alonso",
      defaultValue: active.assignedAdvisor || "Sin asignar"
    });
    if (assignedAdvisor === null) return;
    payload.callbackReason = callbackReason;
    payload.assignedAdvisor = assignedAdvisor === "Sin asignar" ? "" : assignedAdvisor;
  }

  const data = await postCampaignAction("/campaign/result", payload);
  if (!data) return;

  const labels = {
    agendado: "Contacto marcado como agendado.",
    no_interesado: "Contacto marcado como no interesado.",
    requiere_asesor: "Contacto derivado a callback.",
    reintentar: "Contacto marcado para reintento."
  };
  setStatus(labels[result] || "Resultado de campaña actualizado.", true);
}

async function markContactDisposition(contactId, result) {
  const data = await postCampaignAction("/campaign/result", { contactId, result });
  if (data) setStatus("Resultado comercial actualizado.", true);
}

function syncCampaignResultsToContacts() {
  const campaignContacts = Array.isArray(dashboardState.campaignState?.contacts) ? dashboardState.campaignState.contacts : [];
  const contactsById = new Map(Contacts.contacts.map(contact => [String(contact.id), contact]));
  for (const result of campaignContacts) {
    const local = contactsById.get(String(result.id));
    if (!local) continue;
    local.campaignStatus = result.status || "";
    local.campaignResult = result.result || "";
    local.technicalResult = result.technicalResult || "";
    local.attempts = Number(result.attempts || 0);
    local.lastAttemptAt = result.lastAttemptAt || null;
    local.callDurationSeconds = Number(result.durationSeconds || 0);
    local.lastWorkerName = result.assignedWorkerName || local.lastWorkerName || "";
  }
  // Los resultados y estados de campaña ya son persistidos en el servidor y MySQL (call_attempts).
  // No reenviar los 850 KB del libro completo en cada tick de llamada para no saturar la red ni MySQL.
}
return { getCampaignContactMap, getActiveCampaignContact, campaignCounter, renderCampaignPanel, fetchCampaignState, postCampaignAction, stopCampaignRun, saveVoiceAgentConfig, startCampaignRunLegacy, startCampaignRun, pauseCampaignRun, resumeCampaignRun, skipCampaignContact, markCampaignResult, markContactDisposition, syncCampaignResultsToContacts };
}
