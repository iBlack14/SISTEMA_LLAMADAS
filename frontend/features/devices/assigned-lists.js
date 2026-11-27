import { refs } from '../../shared/ui/dom.js';
import * as Contacts from '../contacts/contacts-repository.js';

// Una tabla compartida para todos los teléfonos; los filtros no alteran la campaña.
export function createAssignedLists(state, actions) {
  let team = "all", filter = "pending", query = "", page = 1;
  const pageSize = 25;
  let currentRows = [];
  const esc = value => actions.escHtml(String(value ?? ""));
  let _rafPending = false;
  function renderAssignedListsPanel() {
    // Deduplicar renders en el mismo frame de animación
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => { _rafPending = false; _renderAssignedListsPanelSync(); });
  }
  function _renderAssignedListsPanelSync() {
    const container = refs.assignedListsPanelEl;
    if (!container) return;
    if (!container.querySelector('.calls-contact-workspace')) {
      container.innerHTML = `<section class="calls-contact-workspace" aria-label="Contactos de llamadas">
        <div class="calls-table-heading"><h3>Contactos</h3><span class="calls-table-total" role="status"></span></div>
        <div class="calls-team-tabs" role="group" aria-label="Filtrar contactos por equipo"></div>
        <div class="calls-table-toolbar"><div class="calls-state-tabs" role="group" aria-label="Filtrar por estado"></div><label class="calls-table-search"><span>Buscar</span><input type="search" placeholder="Empresa, teléfono o lista…" aria-label="Buscar contactos de llamadas"></label></div>
        <div class="calls-table-scroll"><table><thead><tr><th scope="col">Empresa</th><th scope="col">Teléfono</th><th scope="col">Lista</th><th scope="col">Equipo</th><th scope="col">Estado</th><th scope="col">Acción</th></tr></thead><tbody></tbody></table></div>
        <div class="calls-table-pagination"><span role="status"></span><div><button class="secondary" data-calls-page="-1">Anterior</button><button class="secondary" data-calls-page="1">Siguiente</button></div></div>
      </section>`;
      container.querySelector('input').addEventListener('input', event => { query = event.target.value; page = 1; renderAssignedListsPanel(); });
      container.addEventListener('click', async event => {
        const tab = event.target.closest('[data-calls-team]');
        if (tab) { team = tab.dataset.callsTeam; page = 1; renderAssignedListsPanel(); }
        const status = event.target.closest('[data-calls-state]');
        if (status) { filter = status.dataset.callsState; page = 1; renderAssignedListsPanel(); }
        const pager = event.target.closest('[data-calls-page]');
        if (pager && !pager.disabled) { page += Number(pager.dataset.callsPage); renderAssignedListsPanel(); }
        const call = event.target.closest('[data-unified-call]');
        if (call && !call.disabled) {
          const row = currentRows[Number(call.dataset.unifiedCall)];
          if (!row) return;
          call.disabled = true;
          try { await actions.callContactFromAssignedList(row.contact.id, row.contact.list || "Principal", row.contact); }
          finally { renderAssignedListsPanel(); }
        }
      });
    }
    container.style.display = 'block';
    const slots = (state.pairingSlotsSnapshot || []).map((slot, index) => ({slot, index})).filter(({slot}) => slot.deviceId);
    const assignments = actions.getPairingListAssignments();
    const byList = new Map(assignments.map(item => [item.listName, item.slot]));
    const workers = new Map((state.latestSessionState?.phoneWorkers || []).map(w => [String(w.id), w]));
    const campaign = new Map((state.campaignState?.contacts || []).map(c => [String(c.id), c]));
    const key = c => `${c.list || "Principal"}|${actions.normalizeValidPeruPhone(c.phone)}`;
    const pending = actions.loadTurnPendingContacts?.() || [];
    const pendingKeys = new Set(pending.map(key));
    const sources = new Map();
    for (const c of [...Contacts.contacts, ...pending]) {
      if (!actions.normalizeValidPeruPhone(c.phone)) continue;
      if (!sources.has(key(c))) sources.set(key(c), {...c, id:c.id || `pending:${key(c)}`});
    }
    for (const c of state.campaignState?.contacts || []) {
      if (actions.normalizeValidPeruPhone(c.phone) && !sources.has(key(c))) sources.set(key(c), c);
    }
    const rows = [...sources.values()].map(contact => {
      const live = campaign.get(String(contact.id));
      const slot = byList.get(contact.list || "Principal");
      const workerId = live?.assignedWorkerId || slot?.deviceId || live?.targetWorkerId || "";
      const worker = workers.get(String(workerId));
      const slotIndex = (state.pairingSlotsSnapshot || []).findIndex(s => s.deviceId === workerId);
      const active = ["dialing", "ringing", "in_call"].includes(live?.status)
        || (worker?.activeContactId === contact.id && ["dialing", "ringing", "in_call"].includes(worker?.callState));
      const restriction = actions.contactAnnualBlock(contact);
      // «No volver a llamar» (permanent) y «Bloqueado» son restricciones definitivas:
      // el número se mueve a «Finalizados» aunque esté en la lista de pendientes del turno
      // o en una campaña pendiente. Así el contador de «Pendientes» sólo refleja números
      // que el sistema puede efectivamente marcar.
      const isPermanentlyRestricted = restriction === "permanent" || restriction === "blocked";
      const final = isPermanentlyRestricted
        || ["completed", "failed", "awaiting_callback"].includes(live?.status)
        || Number(contact.attempts || live?.attempts || 0) > 0 || Boolean(restriction);
      const category = active ? "active"
        : isPermanentlyRestricted ? "finished"
        : pendingKeys.has(key(contact)) || ["pending", "retry_pending", "held"].includes(live?.status) ? "pending"
        : final ? "finished" : "pending";
      const label = active ? (live?.status === "in_call" || worker?.callState === "in_call" ? "En llamada" : "Marcando")
        : restriction === "blocked" ? "Bloqueado" : restriction === "permanent" ? "No volver a llamar"
        : category === "finished" ? "Finalizado" : live?.status === "held" ? "Detenido" : "Pendiente";
      const busy = ["dialing", "ringing", "in_call"].includes(worker?.callState);
      const canCall = Boolean(slot?.deviceId && worker?.connected && !busy && !active && restriction !== "blocked" && restriction !== "permanent");
      return {contact, workerId, label, category, canCall, retry:Boolean(restriction && restriction !== "blocked" && restriction !== "permanent"), equipment:slotIndex >= 0 ? `Equipo ${slotIndex + 1}` : "Sin equipo"};
    });
    if (team !== "all" && team !== "unassigned" && !slots.some(({slot}) => slot.deviceId === team)) team = "all";
    const teamRows = rows.filter(r => team === "all" || (team === "unassigned" ? !r.workerId : r.workerId === team));
    const tab = (label, attr, id, selected) => `<button type="button" ${attr}="${esc(id)}" aria-pressed="${selected}" class="${selected ? "is-active" : ""}">${esc(label)}</button>`;
    container.querySelector('.calls-team-tabs').innerHTML = tab('Todos', 'data-calls-team', 'all', team === 'all') + slots.map(({slot,index}) => tab(`Equipo ${index + 1}`, 'data-calls-team', slot.deviceId, team === slot.deviceId)).join('') + (rows.some(r => !r.workerId) ? tab('Sin equipo','data-calls-team','unassigned',team==='unassigned') : '');
    container.querySelector('.calls-state-tabs').innerHTML = [['pending','Pendientes'],['active','En curso'],['finished','Finalizados']].map(([id,label]) => tab(`${label} · ${teamRows.filter(r => r.category === id).length.toLocaleString('es-PE')}`, 'data-calls-state', id, filter === id)).join('');
    const needle = query.trim().toLocaleLowerCase('es');
    const filtered = teamRows.filter(r => r.category === filter && (!needle || `${r.contact.name || ''} ${r.contact.phone} ${r.contact.list || 'Principal'}`.toLocaleLowerCase('es').includes(needle)));
    page = Math.max(1,Math.min(page,Math.ceil(filtered.length/pageSize) || 1));
    currentRows = filtered.slice((page-1)*pageSize,page*pageSize);
    container.querySelector('tbody').innerHTML = currentRows.map((r,index) => `<tr><td><strong>${esc(r.contact.name || 'Sin nombre')}</strong></td><td>${esc(r.contact.phone)}</td><td>${esc(r.contact.list || 'Principal')}</td><td>${esc(r.equipment)}</td><td><span class="calls-row-status" data-state="${r.category}">${esc(r.label)}</span></td><td>${r.category === 'active' ? '<span aria-label="Controla esta llamada desde la tarjeta del equipo">—</span>' : `<button class="calls-row-call" type="button" data-unified-call="${index}" ${r.canCall ? '' : 'disabled'} title="${r.canCall ? 'Llamar desde el equipo asignado' : 'Requiere un equipo conectado y libre, y un número permitido'}">${r.retry ? 'Reintentar' : 'Llamar'}</button>`}</td></tr>`).join('') || `<tr><td colspan="6" class="calls-table-empty">${needle ? 'No hay coincidencias con tu búsqueda.' : !Contacts.contacts.length && !rows.length ? 'Importa una lista desde Rubro y lista para comenzar.' : 'No hay contactos en este filtro.'}</td></tr>`;
    container.querySelector('.calls-table-total').textContent = `${rows.length.toLocaleString('es-PE')} contactos`;
    container.querySelector('.calls-table-pagination span').textContent = filtered.length ? `Mostrando ${(page-1)*pageSize+1}–${Math.min(page*pageSize,filtered.length)} de ${filtered.length.toLocaleString('es-PE')} · Página ${page}` : '0 contactos';
    container.querySelector('[data-calls-page="-1"]').disabled = page <= 1;
    container.querySelector('[data-calls-page="1"]').disabled = page*pageSize >= filtered.length;
  }
  return {renderAssignedListsPanel};
}
