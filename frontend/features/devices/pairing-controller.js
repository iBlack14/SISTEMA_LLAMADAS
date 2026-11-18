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

/** Los eventos de estado pueden traer el slot sin token: conservamos el último conocido. */
function preserveSlotToken(slot) {
  if (slot.token) return slot;
  const known = (dashboardState.pairingSlotsSnapshot || []).find((item) => item.id === slot.id);
  return known?.token ? { ...slot, token: known.token } : slot;
}

function renderPairingSlotsUi(slots) {
  const listAssignmentBySlotId = new Map(dashboardActions.getPairingListAssignments().map((assignment) => [assignment.slot.id, assignment]));
  const workers = Array.isArray(dashboardState.latestSessionState?.phoneWorkers) ? dashboardState.latestSessionState.phoneWorkers : [];
  const selectableListNames = (Contacts.lists || []).filter((name) =>
    name && (name !== "Principal" || Contacts.contacts.some((contact) => (contact.list || "Principal") === "Principal"))
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
      <article class="pairing-slot-card ${assigned ? "is-assigned" : ""}" data-slot-id="${dashboardActions.escHtml(slot.id)}">
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
  dashboardState.pairingSlotsSnapshot = slots;
  dashboardActions.renderAssignedListsPanel();
}

const pairingLoads = new Map();

async function updatePairingSlotsFromState(slots) {
  if (!Array.isArray(slots)) return;

  // Sin esto, cada evento de estado cambiaba la clave de cache (id:token -> id:)
  // y volvia a pedir el mismo QR. Si el token si rota, se usa el nuevo normalmente.
  slots = slots.map(preserveSlotToken);

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
    // Renderizar primero con "Cargando..." y luego de nuevo cuando lleguen los QR
    renderPairingSlotsGranular(slots);
    const results = await fetchQrBatch(dashboardState.sessionCode, unassignedToFetch);
    const hadStaleIds = results.some((r) => r === "not_found");
    if (hadStaleIds) {
      // Los IDs del estado local son stale — recargar datos frescos del servidor
      await loadPairingData(dashboardState.sessionCode);
      return;
    }
    // Re-renderizar con los QR ya disponibles en cache sin perder el snapshot:
    // dejarlo vacío hacia que el diff granular insertara las tarjetas de nuevo.
    renderPairingSlotsGranular(slots);
    return;
  }

  renderPairingSlotsGranular(slots);
}

function renderPairingSlotsOnly() {
  if (Array.isArray(dashboardState.pairingSlotsSnapshot) && dashboardState.pairingSlotsSnapshot.length) {
    renderPairingSlotsUi(dashboardState.pairingSlotsSnapshot);
  }
}

function renderPairingSlotsGranular(newSlots) {
  const container = refs.pairingSlotsEl;
  if (!container) return;

  // El placeholder inicial o un diff desincronizado deja tarjetas duplicadas.
  // Si el DOM no coincide con los slots esperados, se regenera el contenedor completo.
  const domIds = [...container.querySelectorAll("[data-slot-id]")].map((el) => el.dataset.slotId);
  const expectedIds = newSlots.map((slot) => slot.id);
  if (container.querySelector(".campaign-list-empty") ||
      domIds.length !== expectedIds.length ||
      domIds.some((id, index) => id !== expectedIds[index])) {
    renderPairingSlotsUi(newSlots);
    return;
  }

  const oldSlots = dashboardState.pairingSlotsSnapshot || [];
  const oldSlotMap = new Map(oldSlots.map((slot, idx) => [slot.id, { slot, idx }]));
  const newSlotMap = new Map(newSlots.map((slot, idx) => [slot.id, { slot, idx }]));

  // Determine which slots need updates
  const allSlotIds = new Set([...oldSlotMap.keys(), ...newSlotMap.keys()]);

  for (const slotId of allSlotIds) {
    const oldEntry = oldSlotMap.get(slotId);
    const newEntry = newSlotMap.get(slotId);

    if (!oldEntry) {
      // New slot added - insert at correct position
      const newSlotHtml = renderSingleSlot(newEntry.slot, newEntry.idx, dashboardState, dashboardActions);
      if (newEntry.idx === 0) {
        container.insertAdjacentHTML('afterbegin', newSlotHtml);
      } else {
        const prevSlot = newSlots[newEntry.idx - 1];
        const prevEl = container.querySelector(`[data-slot-id="${dashboardActions.escHtml(prevSlot.id)}"]`);
        if (prevEl) {
          prevEl.insertAdjacentHTML('afterend', newSlotHtml);
        } else {
          container.insertAdjacentHTML('beforeend', newSlotHtml);
        }
      }
    } else if (!newEntry) {
      // Slot removed
      const el = container.querySelector(`[data-slot-id="${dashboardActions.escHtml(slotId)}"]`);
      if (el) el.remove();
    } else {
      // Slot exists - check if content changed
      const oldSlot = oldEntry.slot;
      const newSlot = newEntry.slot;
      if (slotsChanged(oldSlot, newSlot)) {
        const newSlotHtml = renderSingleSlot(newSlot, newEntry.idx, dashboardState, dashboardActions);
        const el = container.querySelector(`[data-slot-id="${dashboardActions.escHtml(slotId)}"]`);
        if (el) el.outerHTML = newSlotHtml;
      }
    }
  }

  dashboardState.pairingSlotsSnapshot = newSlots;
  dashboardActions.renderAssignedListsPanel();
}

function slotsChanged(oldSlot, newSlot) {
  return oldSlot.deviceId !== newSlot.deviceId ||
    oldSlot.deviceName !== newSlot.deviceName ||
    oldSlot.token !== newSlot.token ||
    oldSlot.linkedAt !== newSlot.linkedAt;
}

function renderSingleSlot(slot, index, state, actions) {
  const listAssignmentBySlotId = new Map(actions.getPairingListAssignments().map((assignment) => [assignment.slot.id, assignment]));
  const workers = Array.isArray(state.latestSessionState?.phoneWorkers) ? state.latestSessionState.phoneWorkers : [];
  const selectableListNames = (Contacts.lists || []).filter((name) =>
    name && (name !== "Principal" || Contacts.contacts.some((contact) => (contact.list || "Principal") === "Principal"))
  );

  const slotDisplayLabel = `EQUIPO ${index + 1}`;
  const assigned = Boolean(slot.deviceId);
  const qrUrl = assigned ? "" : (state.pairQrCache?.get(pairingQrCacheKey(slot)) || "");
  const activeWorkerList = slot.deviceId
    ? (state.campaignState?.contacts || []).find((contact) =>
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
  const heldContact = (state.campaignState?.contacts || []).find((contact) =>
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
    <article class="pairing-slot-card ${assigned ? "is-assigned" : ""}" data-slot-id="${actions.escHtml(slot.id)}">
      <div class="pairing-slot-top">
        <strong>${slotDisplayLabel}</strong>
        <span class="pairing-slot-state">${assigned ? (connected ? "Conectado" : "Desconectado") : "Disponible"}</span>
      </div>
      ${assigned
        ? `<div class="pairing-slot-linked-box">
             <span class="pairing-slot-linked-icon">${connected ? "📱" : "📵"}</span>
             <strong class="pairing-slot-linked-title">${connected ? "Teléfono conectado" : "Teléfono desconectado"}</strong>
             <small class="pairing-slot-linked-sub">${actions.escHtml(slot.deviceName || "Vinculado")}</small>
           </div>`
        : (qrUrl
            ? `<img class="pairing-slot-qr" src="${qrUrl}" alt="QR independiente para ${slotDisplayLabel}" />`
            : `<div class="pairing-slot-qr-loading">Cargando código QR...</div>`
          )
      }
      <div class="pairing-slot-details">
        <span>Teléfono</span>
        <strong>${assigned ? actions.escHtml(slot.deviceName || "Teléfono vinculado") : "Sin vincular"}</strong>
      </div>
      ${assigned
        ? `<label class="pairing-slot-list-field">
             <span>Lista asignada</span>
             <select class="pairing-slot-list-select" data-slot-list-select="${actions.escHtml(slot.id)}" data-worker-id="${actions.escHtml(slot.deviceId || "")}" data-current-list="${actions.escHtml(assignedList)}" aria-label="Lista asignada a ${slotDisplayLabel}">
               <option value="">Sin lista</option>
               ${optionList.map((name) => `<option value="${actions.escHtml(name)}"${name === assignedList ? " selected" : ""}>${actions.escHtml(name)}</option>`).join("")}
             </select>
           </label>`
        : `<div class="pairing-slot-list-field"><span>Lista asignada</span><strong class="pairing-slot-list-empty">Sin vincular</strong></div>`}
      <div class="pairing-slot-current-call ${ringing ? "is-ringing" : answered ? "is-answered" : ended || heldContact ? "is-ended" : ""}">
        <span>${ringing ? "Teléfono timbrando" : answered ? "Llamada contestada" : heldContact ? "Llamada detenida" : ended ? "Llamada finalizada" : "Estado de llamada"}</span>
        <div class="pairing-call-number-row">
          <strong class="pairing-call-number">${calling || ended ? actions.escHtml(worker.phoneNumber || "Sin número") : heldContact ? actions.escHtml(heldContact.phone || "") : "Esperando llamada"}</strong>
          ${statusIcon ? `<img class="pairing-call-status-icon ${statusIcon.effect}" src="${statusIcon.src}" alt="${statusIcon.label}" />` : ""}
        </div>
        <small class="pairing-call-company">${calling || ended ? actions.escHtml(worker.companyName || "Empresa") : heldContact ? actions.escHtml(heldContact.name || "Empresa") : ""}</small>
      </div>
      <div class="pairing-slot-call-actions">
        <button type="button" class="pairing-slot-independent" data-independent-pairing-slot="${actions.escHtml(slot.id)}" data-worker-id="${actions.escHtml(slot.deviceId || "")}" ${connected && assignedList && !calling ? "" : "disabled"}>▶ Iniciar llamada</button>
        <button type="button" class="pairing-slot-stop" data-stop-pairing-slot="${actions.escHtml(slot.id)}" data-worker-id="${actions.escHtml(slot.deviceId || "")}" ${calling ? "" : "disabled"}>■ Detener</button>
        <button type="button" class="pairing-slot-hangup" data-hangup-pairing-slot="${actions.escHtml(slot.id)}" data-worker-id="${actions.escHtml(slot.deviceId || "")}" ${calling ? "" : "disabled"}>☎ Colgar</button>
      </div>
      <button type="button" class="pairing-slot-skip-list" data-skip-list-slot="${actions.escHtml(slot.id)}" data-worker-id="${actions.escHtml(slot.deviceId || "")}" data-current-list="${actions.escHtml(assignedList)}" ${connected && assignedList ? "" : "disabled"}>SALTAR LISTA</button>
      ${assigned ? `<button type="button" class="pairing-slot-disconnect" data-disconnect-pairing-slot="${actions.escHtml(slot.id)}" data-worker-id="${actions.escHtml(slot.deviceId || "")}" data-worker-name="${actions.escHtml(slot.deviceName || "Teléfono vinculado")}">Desvincular teléfono</button>` : ""}
      ${assigned ? "" : `<button type="button" class="pairing-slot-delete" data-delete-pairing-slot="${actions.escHtml(slot.id)}" data-slot-label="${slotDisplayLabel}">Eliminar QR</button>`}
    </article>`;
}

async function loadPairingData(code) {
  if (pairingLoads.has(code)) return pairingLoads.get(code);
  const pending = loadPairingDataOnce(code).finally(() => pairingLoads.delete(code));
  pairingLoads.set(code, pending);
  return pending;
}

async function fetchQrForSlot(code, slot) {
  const qrResponse = await fetch(
    `${API_BASE}/api/pairing-qr/${code}.svg?slot=${encodeURIComponent(slot.id)}&v=${encodeURIComponent(slot.token || slot.id)}`,
    { headers: { "X-Dashboard-Token": dashboardState.dashboardToken } }
  );
  if (qrResponse.status === 404) return "not_found";
  if (!qrResponse.ok) return "error";
  const url = URL.createObjectURL(await qrResponse.blob());
  dashboardState.pairQrCache.set(pairingQrCacheKey(slot), url);
  dashboardState.pairQrObjectUrls.push(url);
  return "ok";
}

async function fetchQrBatch(code, slots) {
  const results = await Promise.all(
    slots.map(async (slot) => {
      try { return await fetchQrForSlot(code, slot); }
      catch { return "error"; }
    })
  );
  return results;
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
      const results = await fetchQrBatch(code, unassignedToFetch);
      const hadStaleIds = results.some((r) => r === "not_found");
      if (hadStaleIds) {
        // Los IDs del servidor cambiaron — recargar desde cero con los IDs frescos
        return loadPairingDataOnce(code);
      }
    }

    renderPairingSlotsGranular(slots);
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
    if (!res.ok || !data.ok) {
      // Si el slot no se encuentra (IDs desincronizados), refresca la lista
      // desde el servidor para corregir el estado stale del frontend.
      if (res.status === 404) {
        await loadPairingData(dashboardState.sessionCode);
        throw new Error("El código QR ya no existe en el servidor. La lista fue actualizada.");
      }
      throw new Error(data.error || "No se pudo eliminar el QR.");
    }
    await loadPairingData(dashboardState.sessionCode);
    setStatus("Código QR eliminado.", true);
  } catch (error) {
    setStatus(error.message || "No se pudo eliminar el QR.", true);
  }
}
return { loadPairingData, createPairingQr, deletePairingQr, renderPairingSlotsOnly, updatePairingSlotsFromState, renderPairingSlotsGranular };
}
