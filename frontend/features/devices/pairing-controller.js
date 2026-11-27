import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import { apiFetch as fetch, currentUser, bindAccountControls } from '../auth/auth-session.js';
import * as Contacts from '../contacts/contacts-repository.js';
import { shortDeviceId } from '../../shared/device-id.js';

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
  if (!refs.pairingSlotsEl) return;
  const focus = document.activeElement;
  const focusedSlot = refs.pairingSlotsEl.contains(focus) ? focus?.dataset.slotListSelect : null;
  const openMenus = new Set([...refs.pairingSlotsEl.querySelectorAll('.call-equipment-more[open]')].map(el => el.closest('[data-slot-id]').dataset.slotId));
  refs.pairingSlotsEl.innerHTML = slots.map((slot, index) => renderSingleSlot(slot, index, dashboardState, dashboardActions)).join("")
    || '<div class="campaign-list-empty">Pulsa «Vincular equipo» para crear un QR.</div>';
  dashboardState.pairingSlotsSnapshot = slots;
  for (const card of refs.pairingSlotsEl.querySelectorAll('[data-slot-id]')) {
    if (openMenus.has(card.dataset.slotId)) card.querySelector('.call-equipment-more')?.setAttribute('open', '');
  }
  if (focusedSlot) {
    [...refs.pairingSlotsEl.querySelectorAll('[data-slot-list-select]')]
      .find(select => select.dataset.slotListSelect === focusedSlot && !select.disabled)?.focus({ preventScroll: true });
  }
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
  renderPairingSlotsUi(newSlots);
}

function renderSingleSlot(slot, index, state, actions) {
  const esc = actions.escHtml;
  const worker = (state.latestSessionState?.phoneWorkers || []).find(w => String(w.id) === String(slot.deviceId));
  const assigned = Boolean(slot.deviceId);
  const connected = Boolean(worker?.connected);
  const busy = connected && ["dialing", "ringing", "in_call"].includes(worker?.callState);
  const answered = worker?.callState === "in_call";
  const paused = worker?.paused || state.campaignState?.pausedWorkerIds?.includes(slot.deviceId);
  const assignment = actions.getPairingListAssignments().find(item => item.slot.id === slot.id);
  const list = assignment?.listName || "";
  const options = (Contacts.lists || []).filter(name => Contacts.contacts.some(c => (c.list || "Principal") === name));
  if (list && !options.includes(list)) options.push(list);
  const active = (state.campaignState?.contacts || []).find(c => c.assignedWorkerId === slot.deviceId && ["dialing", "ringing", "in_call"].includes(c.status));
  const pending = Contacts.contacts.filter(c => (c.list || "Principal") === list && !c.attempts && !actions.contactAnnualBlock(c)).length;
  const label = !assigned ? "Sin vincular" : !connected ? "Desconectado" : busy ? (answered ? "En llamada" : "Marcando") : paused ? "Detenido" : !list ? "Sin lista" : pending ? "Disponible" : "Sin contactos pendientes";
  const tone = !connected ? "offline" : busy ? (answered ? "active" : "dialing") : "ready";
  const voicemailDetected = connected && (active?.technicalResult === "buzon_de_voz" || (!busy && worker?.detectedVoicemail));
  const detectorTone = !connected ? "offline" : voicemailDetected ? "detected" : worker?.detectorState || "unknown";
  const detectorLabel = !connected ? "Sin conexión" : voicemailDetected ? "Buzón de voz detectado"
    : ({ ready: "Detector listo", disabled: "Detector desactivado", preparing: "Preparando detector" })[worker?.detectorState] || "Sin información del detector";
  const qr = state.pairQrCache?.get(pairingQrCacheKey(slot));
  const workerId = esc(slot.deviceId || "");
  const slotId = esc(slot.id);
  return `<article class="pairing-slot-card call-equipment-card ${assigned ? "is-assigned" : ""}" data-slot-id="${slotId}" data-tone="${tone}">
    <div class="call-equipment-heading"><strong>Equipo ${index + 1}${assigned ? ` <small>· ID ${esc(shortDeviceId(slot.deviceId))}</small>` : ""}</strong><span class="call-connection">${connected ? "Conectado" : assigned ? "Desconectado" : "QR"}</span></div>
    ${assigned ? `<label class="call-equipment-list">Lista<select data-slot-list-select="${slotId}" data-worker-id="${workerId}" data-current-list="${esc(list)}" aria-label="Lista del equipo ${index + 1}" ${busy ? "disabled" : ""}><option value="">Sin lista</option>${options.map(name => `<option value="${esc(name)}" ${name === list ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>
    <div class="call-equipment-current"><div><strong>${label}</strong><span>${busy ? esc(active?.name || worker.companyName || "Contacto") : list ? `${pending.toLocaleString("es-PE")} contactos sin llamar` : "Selecciona una lista"}</span><small>${busy ? esc(active?.phone || worker.phoneNumber || "") : esc(slot.deviceName || worker?.name || "")}</small></div>${busy ? `<strong class="call-equipment-duration" data-started-at="${esc(worker.answeredAt || active?.startedAt || "")}">${actions.formatSeconds(worker.answeredAt ? Math.max(0, Math.floor((Date.now() - Date.parse(worker.answeredAt)) / 1000)) : Number(worker.durationSeconds || 0))}</strong>` : ""}</div>
    <div class="call-equipment-actions"><button data-independent-pairing-slot="${slotId}" data-worker-id="${workerId}" ${!connected || !list || busy ? "disabled" : ""}>Iniciar</button><button class="secondary" data-stop-pairing-slot="${slotId}" data-worker-id="${workerId}" ${!connected || paused ? "disabled" : ""}>Detener</button><button class="secondary" data-hangup-pairing-slot="${slotId}" data-worker-id="${workerId}" ${busy ? "" : "disabled"}>Colgar</button></div>
    <div class="call-equipment-detector" data-detector="${esc(detectorTone)}" role="status"><span>Buzón de voz</span><strong>${esc(detectorLabel)}</strong></div>
    <details class="call-equipment-more"><summary>Opciones del equipo</summary><button class="secondary" data-skip-list-slot="${slotId}" data-worker-id="${workerId}" data-current-list="${esc(list)}" ${connected && list ? "" : "disabled"}>Saltar lista</button><button class="secondary" data-disconnect-pairing-slot="${slotId}" data-worker-id="${workerId}" data-worker-name="${esc(slot.deviceName || "Teléfono")}">Desvincular teléfono</button></details>`
    : `<div class="call-equipment-qr">${qr ? `<img src="${qr}" alt="QR para vincular el equipo ${index + 1}">` : "Cargando código QR…"}<p>Escanea este QR desde la APK.</p></div><button class="secondary" data-delete-pairing-slot="${slotId}" data-slot-label="Equipo ${index + 1}">Eliminar QR</button>`}
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
