import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import { apiFetch as fetch, currentUser, bindAccountControls } from '../auth/auth-session.js';
import * as Contacts from '../contacts/contacts-repository.js';

/**
 * createPairingController: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardActions.getPairingListAssignments, dashboardActions.renderAssignedListsPanel, dashboardState.campaignState, dashboardState.dashboardToken, dashboardState.latestSessionState, dashboardState.pairQrObjectUrls, dashboardState.pairingSlotsSnapshot, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createPairingController(dashboardState, dashboardActions) {
if (!dashboardState.pairQrCache) {
  dashboardState.pairQrCache = new Map();
}

function pairingQrCacheKey(slot) {
  return `${slot.id}:${slot.token || ""}`;
}

function renderPairingSlotsUi(slots) {
  const listAssignmentBySlotId = new Map(dashboardActions.getPairingListAssignments().map((assignment) => [assignment.slot.id, assignment]));
  const workers = Array.isArray(dashboardState.latestSessionState?.phoneWorkers) ? dashboardState.latestSessionState.phoneWorkers : [];
  const selectableListNames = Contacts.lists.filter((name) =>
    Contacts.contacts.some((contact) =>
      (contact.list || "Principal") === name && dashboardActions.normalizeValidPeruPhone(contact.phone)
    )
  );

  const renderedSlots = slots.map((slot, index) => {
    const slotDisplayLabel = `EQUIPO ${index + 1}`;
    const assigned = Boolean(slot.deviceId);
    const qrUrl = assigned ? "" : (dashboardState.pairQrCache?.get(pairingQrCacheKey(slot)) || "");
    const activeWorkerList = slot.deviceId
      ? (dashboardState.campaignState?.contacts || []).find((contact) =>
          contact.targetWorkerId === slot.deviceId && !["completed", "failed", "awaiting_callback"].includes(contact.status)
        )?.list
      : "";
    const assignedList = activeWorkerList || listAssignmentBySlotId.get(slot.id)?.listName || "";
    const optionList = Array.from(new Set([...selectableListNames, ...(assignedList ? [assignedList] : [])]));
    const worker = workers.find((item) => String(item.id) === String(slot.deviceId));
    const connected = Boolean(worker?.connected);
    const callState = String(worker?.callState || "idle");
    const calling = Boolean(connected && ["dialing", "ringing", "in_call"].includes(callState));
    const ringing = ["dialing", "ringing"].includes(callState);
    const answered = callState === "in_call";
    const ended = Boolean(worker && ["ended", "failed"].includes(callState));
    const heldContact = (dashboardState.campaignState?.contacts || []).find((contact) =>
      contact.targetWorkerId === slot.deviceId && contact.status === "held"
    );
    const statusIcon = ringing
      ? { src: "/features/calls/assets/call-status/timbrando.png", label: "Timbrando", effect: "is-vibrating" }
      : answered
        ? { src: "/features/calls/assets/call-status/contesto.png", label: "Llamada contestada", effect: "is-pulsing" }
        : ended || heldContact
          ? { src: "/features/calls/assets/call-status/rechazado.png", label: "Llamada rechazada o finalizada", effect: "is-rejected" }
          : null;

    return `
      <article class="pairing-slot-card ${assigned ? "is-assigned" : ""}">
        <div class="pairing-slot-top">
          <strong>${slotDisplayLabel}</strong>
          <span class="pairing-slot-state">${assigned ? (connected ? "Conectado" : "Desconectado") : "Disponible"}</span>
        </div>
        ${assigned
          ? `<div class="pairing-slot-linked-box">
               <span class="pairing-slot-linked-icon">${connected ? "📱" : "📵"}</span>
               <strong class="pairing-slot-linked-title">${connected ? "Teléfono conectado" : "Teléfono desconectado"}</strong>
               <small class="pairing-slot-linked-sub">${dashboardActions.escHtml(slot.deviceName || "Vinculado")}</small>
             </div>`
          : (qrUrl
              ? `<img class="pairing-slot-qr" src="${qrUrl}" alt="QR independiente para ${slotDisplayLabel}" />`
              : `<div class="pairing-slot-qr-loading">Cargando código QR...</div>`
            )
        }
        <div class="pairing-slot-details">
          <span>Teléfono</span>
          <strong>${assigned ? dashboardActions.escHtml(slot.deviceName || "Teléfono vinculado") : "Sin vincular"}</strong>
        </div>
        ${assigned
          ? `<label class="pairing-slot-list-field">
               <span>Lista asignada</span>
               <select class="pairing-slot-list-select" data-slot-list-select="${dashboardActions.escHtml(slot.id)}" data-worker-id="${dashboardActions.escHtml(slot.deviceId || "")}" data-current-list="${dashboardActions.escHtml(assignedList)}" aria-label="Lista asignada a ${slotDisplayLabel}">
                 <option value="">Sin lista</option>
                 ${optionList.map((name) => `<option value="${dashboardActions.escHtml(name)}"${name === assignedList ? " selected" : ""}>${dashboardActions.escHtml(name)}</option>`).join("")}
               </select>
             </label>`
          : `<div class="pairing-slot-list-field"><span>Lista asignada</span><strong class="pairing-slot-list-empty">Sin vincular</strong></div>`}
        <div class="pairing-slot-current-call ${ringing ? "is-ringing" : answered ? "is-answered" : ended || heldContact ? "is-ended" : ""}">
          <span>${ringing ? "Teléfono timbrando" : answered ? "Llamada contestada" : heldContact ? "Llamada detenida" : ended ? "Llamada finalizada" : "Estado de llamada"}</span>
          <div class="pairing-call-number-row">
            <strong class="pairing-call-number">${calling || ended ? dashboardActions.escHtml(worker.phoneNumber || "Sin número") : heldContact ? dashboardActions.escHtml(heldContact.phone || "") : "Esperando llamada"}</strong>
            ${statusIcon ? `<img class="pairing-call-status-icon ${statusIcon.effect}" src="${statusIcon.src}" alt="${statusIcon.label}" />` : ""}
          </div>
          <small class="pairing-call-company">${calling || ended ? dashboardActions.escHtml(worker.companyName || "Empresa") : heldContact ? dashboardActions.escHtml(heldContact.name || "Empresa") : ""}</small>
        </div>
        <div class="pairing-slot-call-actions">
          <button type="button" class="pairing-slot-independent" data-independent-pairing-slot="${dashboardActions.escHtml(slot.id)}" data-worker-id="${dashboardActions.escHtml(slot.deviceId || "")}" ${connected && assignedList && !calling ? "" : "disabled"}>▶ Iniciar llamada</button>
          <button type="button" class="pairing-slot-stop" data-stop-pairing-slot="${dashboardActions.escHtml(slot.id)}" data-worker-id="${dashboardActions.escHtml(slot.deviceId || "")}" ${calling ? "" : "disabled"}>■ Detener</button>
          <button type="button" class="pairing-slot-hangup" data-hangup-pairing-slot="${dashboardActions.escHtml(slot.id)}" data-worker-id="${dashboardActions.escHtml(slot.deviceId || "")}" ${calling ? "" : "disabled"}>☎ Colgar</button>
        </div>
        <button type="button" class="pairing-slot-skip-list" data-skip-list-slot="${dashboardActions.escHtml(slot.id)}" data-worker-id="${dashboardActions.escHtml(slot.deviceId || "")}" data-current-list="${dashboardActions.escHtml(assignedList)}" ${connected && assignedList ? "" : "disabled"}>SALTAR LISTA</button>
        ${assigned ? `<button type="button" class="pairing-slot-disconnect" data-disconnect-pairing-slot="${dashboardActions.escHtml(slot.id)}" data-worker-id="${dashboardActions.escHtml(slot.deviceId || "")}" data-worker-name="${dashboardActions.escHtml(slot.deviceName || "Teléfono vinculado")}">Desvincular teléfono</button>` : ""}
        ${assigned ? "" : `<button type="button" class="pairing-slot-delete" data-delete-pairing-slot="${dashboardActions.escHtml(slot.id)}" data-slot-label="${slotDisplayLabel}">Eliminar QR</button>`}
      </article>`;
  });

  if (refs.pairingSlotsEl) {
    refs.pairingSlotsEl.innerHTML = renderedSlots.length
      ? renderedSlots.join("")
      : `<div class="campaign-list-empty">No hay códigos QR disponibles.</div>`;
  }
  dashboardActions.renderAssignedListsPanel();
}

const pairingLoads = new Map();

function renderPairingSlotsOnly() {
  if (Array.isArray(dashboardState.pairingSlotsSnapshot) && dashboardState.pairingSlotsSnapshot.length) {
    renderPairingSlotsUi(dashboardState.pairingSlotsSnapshot);
  }
}

async function loadPairingData(code) {
  if (pairingLoads.has(code)) return pairingLoads.get(code);
  const pending = loadPairingDataOnce(code).finally(() => pairingLoads.delete(code));
  pairingLoads.set(code, pending);
  return pending;
}

async function loadPairingDataOnce(code) {
  try {
    const res = await fetch(`${API_BASE}/api/pairing/${code}`, {
      headers: { "X-Dashboard-Token": dashboardState.dashboardToken }
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo generar la vinculación.");
    const slots = Array.isArray(data.pairingSlots) ? data.pairingSlots : [];
    dashboardState.pairingSlotsSnapshot = slots;

    // Limpiar URLs cacheadas de slots eliminados
    const activeSlotIds = new Set(slots.map(pairingQrCacheKey));
    for (const [cachedSlotId, url] of dashboardState.pairQrCache.entries()) {
      if (!activeSlotIds.has(cachedSlotId)) {
        URL.revokeObjectURL(url);
        dashboardState.pairQrCache.delete(cachedSlotId);
      }
    }

    // Solo consultar QR para slots NO vinculados y que NO estén cacheados
    const unassignedToFetch = slots.filter((slot) => !slot.deviceId && !dashboardState.pairQrCache.has(pairingQrCacheKey(slot)));
    if (unassignedToFetch.length > 0) {
      await Promise.all(unassignedToFetch.map(async (slot) => {
        try {
          const qrResponse = await fetch(`${API_BASE}/api/pairing-qr/${code}.svg?slot=${encodeURIComponent(slot.id)}&v=${encodeURIComponent(slot.token || slot.id)}`, {
            headers: { "X-Dashboard-Token": dashboardState.dashboardToken }
          });
          if (qrResponse.ok) {
            const url = URL.createObjectURL(await qrResponse.blob());
            dashboardState.pairQrCache.set(pairingQrCacheKey(slot), url);
            dashboardState.pairQrObjectUrls.push(url);
          }
        } catch {
          // Ignorar fallas temporales
        }
      }));
    }

    renderPairingSlotsUi(slots);
  } catch (error) {
    if (refs.pairingSlotsEl) refs.pairingSlotsEl.innerHTML = `<div class="campaign-list-empty">${dashboardActions.escHtml(error.message || "No se pudieron cargar los códigos QR.")}</div>`;
  }
}

async function createPairingQr() {
  if (!dashboardState.sessionCode || !dashboardState.dashboardToken) return;
  if (refs.addPairingQrBtn) refs.addPairingQrBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(dashboardState.sessionCode)}/pairing-slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Token": dashboardState.dashboardToken },
      body: "{}"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo crear el QR.");
    await loadPairingData(dashboardState.sessionCode);
    setStatus("Nuevo código QR creado.", true);
  } catch (error) {
    setStatus(error.message || "No se pudo crear el QR.", true);
  } finally {
    if (refs.addPairingQrBtn) refs.addPairingQrBtn.disabled = false;
  }
}

async function deletePairingQr(slotId) {
  if (!dashboardState.sessionCode || !dashboardState.dashboardToken || !slotId) return;
  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(dashboardState.sessionCode)}/pairing-slots/${encodeURIComponent(slotId)}`, {
      method: "DELETE",
      headers: { "X-Dashboard-Token": dashboardState.dashboardToken }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo eliminar el QR.");
    await loadPairingData(dashboardState.sessionCode);
    setStatus("Código QR eliminado.", true);
  } catch (error) {
    setStatus(error.message || "No se pudo eliminar el QR.", true);
  }
}
return { loadPairingData, createPairingQr, deletePairingQr, renderPairingSlotsOnly };
}
