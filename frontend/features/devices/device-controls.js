import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import * as Contacts from '../contacts/contacts-repository.js';

/**
 * createDeviceControls: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.contactAnnualBlock, dashboardActions.escHtml, dashboardActions.formatSeconds, dashboardActions.loadPairingData, dashboardActions.normalizeValidPeruPhone, dashboardActions.postCampaignAction, dashboardActions.requestConfirmation, dashboardState.PAIRING_LIST_ASSIGNMENTS_PREFIX, dashboardState.campaignState, dashboardState.latestSessionState, dashboardState.pairingSlotsSnapshot, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createDeviceControls(dashboardState, dashboardActions) {
function renderWorkersPanelLegacy() {
  const workers = Array.isArray(dashboardState.latestSessionState?.phoneWorkers) ? dashboardState.latestSessionState.phoneWorkers : [];
  const connected = workers.filter((worker) => worker?.connected);
  if (refs.workersSummaryEl) refs.workersSummaryEl.textContent = `${connected.length} conectados`;
  if (!refs.workersListEl) return;

  if (!connected.length) {
    refs.workersListEl.innerHTML = `<div class="campaign-list-empty">Sin workers conectados.</div>`;
    return;
  }

  refs.workersListEl.innerHTML = connected.map((worker) => `
    <div class="worker-chip ${worker.active ? "is-active" : ""}">
      <strong>${dashboardActions.escHtml(worker.name || "Android")}</strong>
      <span>${dashboardActions.escHtml(worker.id || "worker")}</span>
      <small>${dashboardActions.escHtml(worker.callState || "idle")}</small>
    </div>
  `).join("");
}

function workerStateLabel(worker) {
  if (!worker.connected) return "Desconectado";
  if (worker.paused) return "Pausado";
  const labels = {
    idle: "Disponible",
    ended: "Disponible",
    failed: "Error",
    dialing: "Llamando",
    ringing: "Sonando",
    in_call: "En llamada"
  };
  return labels[worker.callState] || worker.callState || "Disponible";
}

function renderWorkersPanel() {
  const workers = Array.isArray(dashboardState.latestSessionState?.phoneWorkers) ? dashboardState.latestSessionState.phoneWorkers : [];
  const connected = workers.filter((worker) => worker?.connected);
  if (refs.workersSummaryEl) refs.workersSummaryEl.textContent = `${connected.length} conectados`;
  if (!refs.workersListEl) return;
  if (!workers.length) {
    refs.workersListEl.innerHTML = `<div class="campaign-list-empty">Sin teléfonos vinculados.</div>`;
    return;
  }

  refs.workersListEl.innerHTML = workers.map((worker) => {
    const busy = ["dialing", "ringing", "in_call"].includes(worker.callState);
    const stateClass = worker.paused ? "is-paused" : busy ? "is-busy" : worker.connected ? "is-ready" : "is-offline";
    return `
      <article class="worker-card ${stateClass}" data-worker-id="${dashboardActions.escHtml(worker.id)}">
        <div class="worker-card-head">
          <div><strong>${dashboardActions.escHtml(worker.name || "Android")}</strong><small>${dashboardActions.escHtml(worker.lineLabel || worker.id || "Teléfono")}</small></div>
          <span class="worker-state">${dashboardActions.escHtml(workerStateLabel(worker))}</span>
        </div>
        ${busy ? `
          <div class="worker-contact"><strong>${dashboardActions.escHtml(worker.companyName || "Contacto")}</strong><span>${dashboardActions.escHtml(worker.phoneNumber || "-")}</span></div>
          <div class="worker-duration">${dashboardActions.formatSeconds(worker.answeredAt ? Math.floor((Date.now() - Date.parse(worker.answeredAt)) / 1000) : (worker.durationSeconds || 0))}</div>
        ` : `<div class="worker-empty">${worker.paused ? "No recibirá nuevas llamadas" : "Esperando asignación"}</div>`}
        <div class="worker-actions">
          <button class="secondary" data-worker-action="pause" data-worker-id="${dashboardActions.escHtml(worker.id)}">${worker.paused ? "Reanudar" : "Pausar"}</button>
          <button class="danger-soft" data-worker-action="hangup" data-worker-id="${dashboardActions.escHtml(worker.id)}" ${busy ? "" : "disabled"}>Colgar</button>
          <button class="worker-disconnect-btn" data-worker-action="disconnect" data-worker-id="${dashboardActions.escHtml(worker.id)}">Cerrar sesión</button>
        </div>
      </article>`;
  }).join("");

  refs.workersListEl.querySelectorAll("[data-worker-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const workerId = button.dataset.workerId;
      const worker = workers.find((item) => item.id === workerId);
      if (button.dataset.workerAction === "pause") await setWorkerPause(workerId, !worker?.paused);
      if (button.dataset.workerAction === "hangup") await hangupWorker(workerId);
      if (button.dataset.workerAction === "disconnect") await disconnectWorker(workerId, worker?.name);
    });
  });
}

async function setWorkerPause(workerId, paused) {
  const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(workerId)}/pause`, { paused });
  if (data) setStatus(paused ? "Teléfono pausado; no recibirá nuevas llamadas." : "Teléfono reanudado.", true);
}

async function hangupWorker(workerId) {
  const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(workerId)}/hangup`);
  if (data) setStatus("Orden de colgar enviada al teléfono.", true);
}

async function startIndependentWorker(workerId) {
  if (!workerId) return;
  const worker = (dashboardState.latestSessionState?.phoneWorkers || [])
    .find((item) => String(item.id) === String(workerId));
  if (!worker?.connected) {
    setStatus("Este teléfono está desconectado. Vincula el celular actual con el QR de este equipo antes de iniciar.", true);
    await dashboardActions.loadPairingData(dashboardState.sessionCode);
    return;
  }
  const assignment = getPairingListAssignments().find(({ slot }) => String(slot.deviceId) === String(workerId));
  if (!assignment) {
    setStatus("Selecciona una lista para este equipo antes de iniciar.", true);
    return;
  }
  const contacts = Contacts.contacts.filter((contact) =>
    (contact.list || "Principal") === assignment.listName
    && dashboardActions.normalizeValidPeruPhone(contact.phone)
    && !["completed", "failed", "awaiting_callback"].includes(String(contact.campaignStatus || ""))
    && contact.technicalResult !== "no_contactado"
  ).map((contact) => ({
    id: contact.id, name: contact.name,
    phone: dashboardActions.normalizeValidPeruPhone(contact.phone),
    note: contact.note || "", list: assignment.listName
  }));
  const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(workerId)}/start-independent`, { contacts });
  if (data) setStatus(data.dispatched ? "Llamada independiente iniciada." : "Este teléfono no tiene contactos pendientes.", true);
}

async function assignWorkerList(slotId, workerId, listName, currentList = "") {
  if (!slotId) return;
  const previous = String(currentList || "").trim();
  const next = String(listName || "").trim();
  if (previous === next) return;

  // Guardar la asignación local y liberar la lista de cualquier otro equipo.
  let saved = {};
  try { saved = Contacts.getPreference("pairingListAssignments", {}) || {}; } catch { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  for (const [id, name] of Object.entries(saved)) {
    if (name === next) delete saved[id];
  }
  if (next) saved[slotId] = next;
  else delete saved[slotId];
  Contacts.setPreference("pairingListAssignments", saved);

  const worker = (dashboardState.latestSessionState?.phoneWorkers || [])
    .find((item) => String(item.id) === String(workerId));
  const hasCampaignContacts = Array.isArray(dashboardState.campaignState?.contacts) && dashboardState.campaignState.contacts.length > 0;
  if (hasCampaignContacts && worker?.connected && previous && next) {
    const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(workerId)}/switch-list`, { currentList: previous, nextList: next });
    if (!data) { await dashboardActions.loadPairingData(dashboardState.sessionCode); return; }
    setStatus(`Lista del equipo actualizada a "${next}".`, true);
  } else {
    setStatus(next ? `Lista "${next}" asignada al equipo. Pulsa "Iniciar llamada" para comenzar.` : "Lista del equipo liberada.", true);
  }
  await dashboardActions.loadPairingData(dashboardState.sessionCode);
}

async function skipWorkerList(slotId, workerId, currentList) {
  if (!slotId || !workerId || !currentList) return;
  const assignments = getPairingListAssignments();
  const usedLists = new Set(assignments.map((item) => item.listName));
  const nextList = Contacts.lists.find((listName) =>
    listName !== currentList
    && !usedLists.has(listName)
    && Contacts.contacts.some((contact) =>
      (contact.list || "Principal") === listName
      && dashboardActions.normalizeValidPeruPhone(contact.phone)
      && !["completed", "failed", "awaiting_callback"].includes(String(contact.campaignStatus || ""))
    )
  ) || "";
  if (!nextList) {
    setStatus("No hay otra lista libre con contactos pendientes.", true);
    return;
  }
  const accepted = await dashboardActions.requestConfirmation({
    title: "Saltar lista",
    message: `¿Liberar "${currentList}" y asignar "${nextList}" a este equipo? Los contactos pendientes de la lista actual se conservarán.`,
    confirmLabel: "Saltar lista"
  });
  if (!accepted) return;
  if (Array.isArray(dashboardState.campaignState?.contacts) && dashboardState.campaignState.contacts.length) {
    const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(workerId)}/switch-list`, { currentList, nextList });
    if (!data) return;
  }
  const storageKey = `${dashboardState.PAIRING_LIST_ASSIGNMENTS_PREFIX}${dashboardState.sessionCode}`;
  let saved = {};
  try { saved = Contacts.getPreference("pairingListAssignments", {}); } catch { saved = {}; }
  saved[slotId] = nextList;
  Contacts.setPreference("pairingListAssignments", saved);
  setStatus(`Lista saltada. Ahora el equipo tiene asignada "${nextList}".`, true);
  await dashboardActions.loadPairingData(dashboardState.sessionCode);
}

function getPairingListAssignments() {
  const listNames = Contacts.lists.filter((name) =>
    Contacts.contacts.some((contact) =>
      (contact.list || "Principal") === name && dashboardActions.normalizeValidPeruPhone(contact.phone)
    )
  );
  const linkedSlots = dashboardState.pairingSlotsSnapshot.map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(({ slot }) => Boolean(slot?.deviceId));
  const linkedSlotIds = new Set(linkedSlots.map(({ slot }) => String(slot.id)));
  const campaignContacts = Array.isArray(dashboardState.campaignState?.contacts) ? dashboardState.campaignState.contacts : [];
  const completedLists = new Set(listNames.filter((listName) => {
    const contacts = campaignContacts.filter((contact) => String(contact.list || "Principal") === listName);
    return contacts.length > 0 && contacts.every((contact) =>
      ["completed", "failed", "awaiting_callback"].includes(String(contact.status || ""))
    );
  }));
  const validLists = new Set(listNames.filter((listName) => !completedLists.has(listName)));
  const storageKey = `${dashboardState.PAIRING_LIST_ASSIGNMENTS_PREFIX}${dashboardState.sessionCode}`;
  let saved = {};
  try { saved = Contacts.getPreference("pairingListAssignments", {}); } catch { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};

  const usedLists = new Set();
  for (const [slotId, listName] of Object.entries(saved)) {
    if (!linkedSlotIds.has(slotId) || !validLists.has(listName) || usedLists.has(listName)) {
      delete saved[slotId];
    } else {
      usedLists.add(listName);
    }
  }

  const unassignedSlots = linkedSlots
    .filter(({ slot }) => !saved[slot.id])
    .sort((a, b) => (Date.parse(a.slot.linkedAt || 0) || a.slotIndex) - (Date.parse(b.slot.linkedAt || 0) || b.slotIndex));
  for (const { slot } of unassignedSlots) {
    const nextList = listNames.find((listName) => !usedLists.has(listName));
    if (!nextList) break;
    saved[slot.id] = nextList;
    usedLists.add(nextList);
  }
  if (dashboardState.sessionCode) Contacts.setPreference("pairingListAssignments", saved);

  return listNames.flatMap((listName, assignmentIndex) => {
    const linked = linkedSlots.find(({ slot }) => saved[slot.id] === listName);
    return linked ? [{ ...linked, assignmentIndex, listName }] : [];
  });
}

function getPairingListAssignmentByName(listName) {
  return getPairingListAssignments().find((assignment) => assignment.listName === (listName || "Principal")) || null;
}

async function stopIndependentWorker(workerId) {
  if (!workerId) return;
  const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(workerId)}/stop-independent`);
  if (data) setStatus(`Llamada detenida${data.heldContact?.phone ? `: ${data.heldContact.phone}` : ""}. No consumió un intento.`, true);
}

async function callContactFromAssignedList(contactId, listName) {
  const slot = getPairingListAssignmentByName(listName)?.slot || null;
  if (!slot?.deviceId) {
    setStatus(`La lista "${listName || "Principal"}" no tiene un equipo vinculado.`, true);
    return;
  }
  const contact = Contacts.contacts.find((item) => item.id === contactId);
  if (!contact) return;
  const restriction = dashboardActions.contactAnnualBlock(contact);
  const manualRetry = Boolean(restriction && restriction !== "blocked" && restriction !== "permanent");
  if (restriction === "blocked" || restriction === "permanent") {
    setStatus(restriction === "blocked"
      ? "Este número está bloqueado para todas las cuentas. Quítalo del panel global para llamar."
      : "Este número está marcado como inválido y no se puede volver a llamar.", true);
    return;
  }
  if (manualRetry && !await dashboardActions.requestConfirmation({
    title: "Rellamada manual",
    message: "Este número ya fue llamado. ¿Quieres volver a intentarlo manualmente? Las campañas automáticas seguirán excluyéndolo.",
    confirmLabel: "Reintentar manualmente"
  })) return;
  const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(slot.deviceId)}/call-contact`, {
    contactId,
    manualRetry,
    contact: contact ? {
      id: contact.id,
      name: contact.name,
      phone: dashboardActions.normalizeValidPeruPhone(contact.phone),
      note: contact.note || "",
      list: contact.list || "Principal",
      targetWorkerId: slot.deviceId
    } : null
  });
  if (data) setStatus("Llamada manual enviada al equipo asignado.", true);
}

async function hangupWorkerWithResult(workerId) {
  if (!workerId) return;
  const answered = await dashboardActions.requestConfirmation({
    title: "Resultado de la llamada",
    message: "¿Contestó una persona? Pulsa Cancelar si no contestó o fue buzón de voz.",
    confirmLabel: "Sí contestó",
    cancelLabel: "No contestó / buzón"
  });
  const worker = (dashboardState.latestSessionState?.phoneWorkers || []).find((item) => item.id === workerId);
  if (worker?.activeContactId) {
    await dashboardActions.postCampaignAction("/campaign/result", { contactId: worker.activeContactId, result: answered ? "contesto" : "sin_respuesta" });
  }
  await hangupWorker(workerId);
}

async function disconnectWorker(workerId, workerName = "este teléfono") {
  const accepted = window.confirm(`¿Desvincular ${workerName || "este teléfono"}?`);
  if (!accepted) return;
  const data = await dashboardActions.postCampaignAction(`/workers/${encodeURIComponent(workerId)}/disconnect`);
  if (data) setStatus("Teléfono desvinculado correctamente.", true);
}
return { renderWorkersPanelLegacy, workerStateLabel, renderWorkersPanel, setWorkerPause, hangupWorker, startIndependentWorker, assignWorkerList, skipWorkerList, getPairingListAssignments, getPairingListAssignmentByName, stopIndependentWorker, callContactFromAssignedList, hangupWorkerWithResult, disconnectWorker };
}
