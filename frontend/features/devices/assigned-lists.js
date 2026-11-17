import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import * as Contacts from '../contacts/contacts-repository.js';

/**
 * createAssignedLists: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.contactActionButtons, dashboardActions.escHtml, dashboardActions.getHiddenAssignedRecords, dashboardActions.getPairingListAssignments, dashboardActions.normalizeValidPeruPhone, dashboardState.campaignState, dashboardState.pairingSlotsSnapshot.
 * Se construye una vez por dashboard.
 */
export function createAssignedLists(dashboardState, dashboardActions) {
function renderAssignedListsPanel() {
  const container = refs.assignedListsPanelEl;
  if (!container) {
    console.warn('assignedListsPanelEl no encontrado en el DOM');
    return;
  }

  const hiddenRecords = dashboardActions.getHiddenAssignedRecords();
  const listAssignments = dashboardActions.getPairingListAssignments()
    .filter(({ listName }) => !hiddenRecords.has(String(listName)));

  // Obtener todas las listas disponibles
  const availableLists = Contacts.lists.filter((name) =>
    Contacts.contacts.some((contact) =>
      (contact.list || "Principal") === name && dashboardActions.normalizeValidPeruPhone(contact.phone)
    )
  );

  const history = Array.isArray(dashboardState.campaignState?.history) ? dashboardState.campaignState.history : [];
  const latestHistoryByContact = new Map();
  for (const entry of history) {
    const key = String(entry.contactId || "");
    if (!key) continue;
    const previous = latestHistoryByContact.get(key);
    if (!previous || Date.parse(entry.startedAt || 0) >= Date.parse(previous.startedAt || 0)) {
      latestHistoryByContact.set(key, entry);
    }
  }

  // Si no hay asignaciones, mostrar los slots vinculados para permitir asignar listas
  const linkedSlots = dashboardState.pairingSlotsSnapshot.map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(({ slot }) => Boolean(slot?.deviceId));

  if (!linkedSlots.length) {
    container.innerHTML = `<div class="assigned-lists-empty">Vincula teléfonos usando los códigos QR de arriba para asignar listas.</div>`;
    container.style.display = 'block';
    return;
  }

  // Si no hay listas, mostrar mensaje pero mantener las tarjetas de equipos
  if (!availableLists.length) {
    container.innerHTML = linkedSlots.map(({ slot, slotIndex }) => {
      const worker = (dashboardState.latestSessionState?.phoneWorkers || []).find(w => w.id === slot.deviceId);
      const isConnected = worker?.connected || false;
      
      return `
        <article class="assigned-list-card">
          <div class="assigned-list-head">
            <div>
              <span>EQUIPO ${slotIndex + 1} · ${isConnected ? '🟢 Conectado' : '⚫ Desconectado'}</span>
              <h3>${dashboardActions.escHtml(worker?.name || slot.deviceName || `Teléfono ${slotIndex + 1}`)}</h3>
            </div>
          </div>
          <div class="assigned-list-empty-state" style="padding: 30px; text-align: center; color: rgba(255,255,255,0.6);">
            <p style="margin-bottom: 10px;">📋 No hay listas disponibles</p>
            <p style="font-size: 13px;">Ve a "RUBRO Y LISTA" para crear listas de contactos</p>
          </div>
        </article>`;
    }).join("");
    container.style.display = 'block';
    return;
  }

  container.innerHTML = linkedSlots.map(({ slot, slotIndex }, listIndex) => {
    const assignment = listAssignments.find(a => a.slotIndex === slotIndex);
    const listName = assignment?.listName || "";
    
    const contacts = listName ? Contacts.contacts.filter((contact) =>
      (contact.list || "Principal") === listName && dashboardActions.normalizeValidPeruPhone(contact.phone)
    ) : [];
    
    const called = listName ? contacts.filter((contact) => Number(contact.attempts || 0) > 0 || latestHistoryByContact.has(String(contact.id))) : [];
    const campaignContactById = new Map((dashboardState.campaignState?.contacts || []).map((contact) => [String(contact.id), contact]));
    const pending = listName ? contacts.filter((contact) => {
      const status = campaignContactById.get(String(contact.id))?.status || contact.campaignStatus || "";
      return !called.includes(contact) || ["pending", "retry_pending", "held"].includes(status);
    }) : [];
    
    const finished = contacts.length > 0 && pending.length === 0;
    const worker = (dashboardState.latestSessionState?.phoneWorkers || []).find(w => w.id === slot.deviceId);
    const isConnected = worker?.connected || false;
    const isBusy = ["dialing", "ringing", "in_call"].includes(worker?.callState);

    // Crear el selector de listas
    const listOptions = availableLists.map(name => 
      `<option value="${dashboardActions.escHtml(name)}" ${name === listName ? 'selected' : ''}>${dashboardActions.escHtml(name)}</option>`
    ).join("");

    const pendingRows = pending.map((contact) => `
      <tr>
        <td>${contacts.indexOf(contact) + 1}</td>
        <td>${dashboardActions.escHtml(contact.name || "Sin nombre")}</td>
        <td><span class="pending-contact-phone"><span>${dashboardActions.escHtml(contact.phone || "-")}</span><img src="/features/calls/assets/call-status/contacto-pendiente.png" alt="Contacto pendiente" /></span></td>
        <td>${dashboardActions.contactActionButtons(contact, "assigned-pending")}</td>
      </tr>`).join("");

    return `
      <article class="assigned-list-card" data-slot-id="${dashboardActions.escHtml(slot.id)}" data-worker-id="${dashboardActions.escHtml(slot.deviceId || '')}">
        <div class="assigned-list-head">
          <div>
            <span>EQUIPO ${slotIndex + 1} · ${isConnected ? '🟢 Conectado' : '⚫ Desconectado'}</span>
            <h3>${dashboardActions.escHtml(worker?.name || slot.deviceName || `Teléfono ${slotIndex + 1}`)}</h3>
          </div>
          <div class="assigned-list-head-actions">
            <div class="list-selector-group">
              <label for="listSelect_${slotIndex}" style="font-size: 13px; margin-right: 8px; color: rgba(255,255,255,0.7);">Lista:</label>
              <select id="listSelect_${slotIndex}" class="list-select" data-slot-id="${dashboardActions.escHtml(slot.id)}" data-slot-index="${slotIndex}" ${!isConnected || isBusy ? 'disabled' : ''}>
                <option value="">Seleccionar lista...</option>
                ${listOptions}
              </select>
              <button type="button" class="start-worker-btn" data-slot-id="${dashboardActions.escHtml(slot.id)}" data-worker-id="${dashboardActions.escHtml(slot.deviceId || '')}" ${!listName || !isConnected || isBusy ? 'disabled' : ''}>▶ Iniciar</button>
            </div>
            ${finished && listName !== "Principal" ? `<button type="button" class="assigned-list-delete" data-delete-assigned-list="${dashboardActions.escHtml(listName)}">Eliminar registro</button>` : ""}
          </div>
        </div>
        ${listName ? `
        <div class="assigned-list-group">
          <h4>Pendientes por llamar <span>${pending.length} / ${contacts.length}</span></h4>
          <div class="assigned-list-table-wrap">
            <table><thead><tr><th>N.º</th><th>Empresa</th><th>Teléfono</th><th>Contacto</th></tr></thead>
            <tbody>${pendingRows || `<tr><td colspan="4" class="assigned-list-none">No quedan contactos pendientes.</td></tr>`}</tbody></table>
          </div>
        </div>
        ` : `<div class="assigned-list-empty-state">Selecciona una lista y pulsa Iniciar</div>`}
      </article>`;
  }).join("");

  container.style.display = 'block';

  // Agregar event listeners para los selectores y botones
  container.querySelectorAll('.list-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const slotId = e.target.dataset.slotId;
      const slotIndex = Number(e.target.dataset.slotIndex);
      const newList = e.target.value;
      const slot = dashboardState.pairingSlotsSnapshot[slotIndex];
      const workerId = slot?.deviceId;
      
      if (workerId && slotId) {
        const currentAssignment = listAssignments.find(a => a.slotIndex === slotIndex);
        await dashboardActions.assignWorkerList(slotId, workerId, newList, currentAssignment?.listName || "");
      }
    });
  });

  container.querySelectorAll('.start-worker-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const workerId = e.target.dataset.workerId;
      if (workerId) {
        await dashboardActions.startIndependentWorker(workerId);
      }
    });
  });
}
return { renderAssignedListsPanel };
}
