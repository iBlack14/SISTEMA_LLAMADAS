import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { showPanelView } from '../../app/navigation/panel-navigation.js';

let reservationsState = {
  reservations: [],
  activeFilter: 'all',
  searchQuery: '',
  initialized: false
};
let quoteReturnFocus = null;
let activeReservationType = "quote";

function getSessionCode() {
  const input = document.getElementById("sessionCode");
  if (input && input.value) return input.value.trim().toUpperCase();
  const match = location.search.match(/[?&]code=([A-Za-z0-9]+)/);
  if (match) return match[1].toUpperCase();
  return (window.currentSessionCode || "QQ9EKF").toUpperCase();
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function loadReservations() {
  const code = getSessionCode();
  if (!code) return;

  try {
    const res = await fetch(`${API_BASE}/api/session/${code}/reservations`, {
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    reservationsState.reservations = Array.isArray(data.reservations) ? data.reservations : [];
    renderReservations();
  } catch (err) {
    console.warn("[RESERVATIONS] Error al cargar reservas:", err);
    const count = document.getElementById('reservationsResultCount');
    if (count) count.textContent = 'No se pudieron cargar las reservas';
    if (reservationsState.reservations.length) return;
    const empty = document.getElementById('reservationsEmptyState');
    if (empty) empty.style.display = 'block';
    const title = document.getElementById('reservationsEmptyTitle');
    const description = document.getElementById('reservationsEmptyDescription');
    const action = document.getElementById('reservationsEmptyAction');
    if (title) title.textContent = 'No pudimos cargar tu agenda';
    if (description) description.textContent = 'Verifica tu conexión y vuelve a intentarlo.';
    if (action) { action.textContent = 'Volver a intentar'; action.dataset.mode = 'retry'; }
  }
}

export function openQuoteModal(initialData = {}) {
  const modal = document.getElementById("quoteModal");
  if (!modal) return;

  const quoteId = document.getElementById("quoteId");
  const phoneInput = document.getElementById("quotePhoneInput");
  const nameInput = document.getElementById("quoteNameInput");
  const descInput = document.getElementById("quoteDescInput");
  const priceInput = document.getElementById("quotePriceInput");
  const dateInput = document.getElementById("quoteDateInput");
  const timeInput = document.getElementById("quoteTimeInput");
  const statusSelect = document.getElementById("quoteStatusSelect");
  const notesInput = document.getElementById("quoteNotesInput");
  const modalTitle = document.getElementById("quoteModalTitle");
  const modalDescription = document.getElementById("quoteModalDescription");
  const detailLabel = document.getElementById("quoteDetailLabel");
  const priceField = document.getElementById("quotePriceField");
  const saveButton = document.getElementById("quoteSaveBtn");
  activeReservationType = initialData.reservationType === "appointment" ? "appointment" : "quote";

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const nextHour = String((now.getHours() + 1) % 24).padStart(2, '0') + ":00";

  if (quoteId) quoteId.value = initialData.id || "";
  if (phoneInput) phoneInput.value = initialData.phone || initialData.phoneNumber || "";
  if (nameInput) nameInput.value = initialData.name || initialData.company || initialData.contactName || "";
  if (descInput) descInput.value = initialData.quote || "";
  if (priceInput) priceInput.value = initialData.price || "";
  if (dateInput) dateInput.value = initialData.date || todayStr;
  if (timeInput) timeInput.value = initialData.time || nextHour;
  if (statusSelect) statusSelect.value = initialData.status || "scheduled";
  if (notesInput) notesInput.value = initialData.notes || "";
  if (modalTitle) modalTitle.textContent = initialData.id ? "Editar reserva" : activeReservationType === "appointment" ? "Agendar llamada" : "Nueva reserva";
  if (modalDescription) modalDescription.textContent = activeReservationType === "appointment"
    ? "Programa el seguimiento de este contacto."
    : "Completa la cotización y agenda tu próxima llamada.";
  if (detailLabel) detailLabel.textContent = activeReservationType === "appointment" ? "Motivo del seguimiento *" : "Detalle de la cotización *";
  if (descInput) descInput.placeholder = activeReservationType === "appointment"
    ? "Ej: Volver a llamar para confirmar disponibilidad..."
    : "Ej: Solicita cotización de 50 sacos de alimento y flete...";
  if (priceField) priceField.style.display = activeReservationType === "appointment" ? "none" : "";
  if (saveButton) saveButton.textContent = activeReservationType === "appointment" ? "Guardar llamada" : "Guardar reserva";

  if (modal.style.display === 'none') quoteReturnFocus = document.activeElement;
  modal.style.display = "grid";
  (initialData.phone ? descInput : phoneInput)?.focus();
}

export function closeQuoteModal() {
  const modal = document.getElementById("quoteModal");
  if (modal) modal.style.display = "none";
  quoteReturnFocus?.focus();
}

async function handleSaveQuote(e) {
  if (e) e.preventDefault();
  const code = getSessionCode();
  if (!code) return;

  const id = document.getElementById("quoteId")?.value.trim();
  const phone = document.getElementById("quotePhoneInput")?.value.trim();
  const name = document.getElementById("quoteNameInput")?.value.trim();
  const quote = document.getElementById("quoteDescInput")?.value.trim();
  const price = document.getElementById("quotePriceInput")?.value.trim();
  const date = document.getElementById("quoteDateInput")?.value.trim();
  const time = document.getElementById("quoteTimeInput")?.value.trim();
  const status = document.getElementById("quoteStatusSelect")?.value || "scheduled";
  const notes = document.getElementById("quoteNotesInput")?.value.trim();

  if (!phone) {
    alert("Por favor ingresa un número de teléfono.");
    return;
  }
  if (!quote) {
    alert("Por favor ingresa el detalle de la cotización.");
    return;
  }

  const payload = {
    phone,
    name: name || phone,
    company: name || "",
    quote,
    price,
    date,
    time,
    status,
    notes
  };

  try {
    let res;
    if (id) {
      res = await fetch(`${API_BASE}/api/session/${code}/reservations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(`${API_BASE}/api/session/${code}/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    closeQuoteModal();
    await loadReservations();
  } catch (err) {
    console.error("[RESERVATIONS] Error al guardar cotización:", err);
    alert("No se pudo guardar la reserva. Verifica tu conexión.");
  }
}

async function handleCallReservation(id) {
  const code = getSessionCode();
  if (!code) return;

  const reservation = reservationsState.reservations.find(r => r.id === id);
  if (!reservation) return;

  if (!confirm(`¿Deseas iniciar llamada a ${reservation.name || reservation.phone} (${reservation.phone})?`)) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/session/${code}/reservations/${id}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      alert(data.error || "No se pudo realizar la llamada.");
      return;
    }

    alert(`📞 ${data.message || 'Llamada enviada al teléfono'}`);
    showPanelView("calls");
  } catch (err) {
    console.error("[RESERVATIONS] Error al llamar:", err);
    alert("Error de conexión al solicitar llamada.");
  }
}

async function handleTogglePause(id) {
  const code = getSessionCode();
  if (!code) return;

  const reservation = reservationsState.reservations.find(r => r.id === id);
  if (!reservation) return;

  const nextStatus = reservation.status === "paused" ? "scheduled" : "paused";
  try {
    await fetch(`${API_BASE}/api/session/${code}/reservations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus })
    });
    await loadReservations();
  } catch (err) {
    console.error("[RESERVATIONS] Error al cambiar estado:", err);
  }
}

async function handleToggleComplete(id) {
  const code = getSessionCode();
  if (!code) return;

  const reservation = reservationsState.reservations.find(r => r.id === id);
  if (!reservation) return;

  const nextStatus = reservation.status === "completed" ? "scheduled" : "completed";
  try {
    await fetch(`${API_BASE}/api/session/${code}/reservations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus })
    });
    await loadReservations();
  } catch (err) {
    console.error("[RESERVATIONS] Error al cambiar estado:", err);
  }
}

async function handleDeleteReservation(id) {
  const code = getSessionCode();
  if (!code) return;

  if (!confirm("¿Seguro que deseas eliminar esta reserva de cotización?")) return;

  try {
    await fetch(`${API_BASE}/api/session/${code}/reservations/${id}`, {
      method: "DELETE"
    });
    await loadReservations();
  } catch (err) {
    console.error("[RESERVATIONS] Error al eliminar:", err);
  }
}

export function renderReservations() {
  const container = document.getElementById("reservationsCardsGrid");
  const emptyState = document.getElementById("reservationsEmptyState");
  if (!container) return;

  const all = reservationsState.reservations;
  const countScheduled = all.filter(r => r.status === "scheduled").length;
  const countPaused = all.filter(r => r.status === "paused").length;
  const countCompleted = all.filter(r => r.status === "completed").length;

  const cAll = document.getElementById("resCountAll");
  const cSch = document.getElementById("resCountScheduled");
  const cPau = document.getElementById("resCountPaused");
  const cCom = document.getElementById("resCountCompleted");
  if (cAll) cAll.textContent = all.length;
  if (cSch) cSch.textContent = countScheduled;
  if (cPau) cPau.textContent = countPaused;
  if (cCom) cCom.textContent = countCompleted;

  let filtered = all;
  if (reservationsState.activeFilter !== "all") {
    filtered = filtered.filter(r => r.status === reservationsState.activeFilter);
  }

  const query = reservationsState.searchQuery.toLowerCase().trim();
  if (query) {
    filtered = filtered.filter(r =>
      (r.phone || "").toLowerCase().includes(query) ||
      (r.name || "").toLowerCase().includes(query) ||
      (r.company || "").toLowerCase().includes(query) ||
      (r.quote || "").toLowerCase().includes(query) ||
      (r.notes || "").toLowerCase().includes(query)
    );
  }

  const resultCount = document.getElementById('reservationsResultCount');
  if (resultCount) resultCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'reserva' : 'reservas'}${filtered.length !== all.length ? ` de ${all.length}` : ''}`;
  const emptyTitle = document.getElementById('reservationsEmptyTitle');
  const emptyDescription = document.getElementById('reservationsEmptyDescription');
  const emptyAction = document.getElementById('reservationsEmptyAction');
  const hasFilters = Boolean(query || reservationsState.activeFilter !== 'all');
  if (emptyTitle) emptyTitle.textContent = hasFilters ? 'No encontramos reservas' : 'Tu próxima llamada empieza aquí';
  if (emptyDescription) emptyDescription.textContent = hasFilters ? 'Prueba con otro término o restablece los filtros para ver tu agenda.' : 'Crea una reserva para dar seguimiento a una cotización. También puedes agendarla desde tu celular durante una llamada.';
  if (emptyAction) {
    emptyAction.textContent = hasFilters ? 'Restablecer filtros' : '＋ Crear mi primera reserva';
    emptyAction.dataset.mode = hasFilters ? 'reset' : 'create';
  }

  if (!filtered.length) {
    container.innerHTML = "";
    if (emptyState) emptyState.style.display = "block";
    return;
  }

  if (emptyState) emptyState.style.display = "none";

  container.innerHTML = filtered.map(r => {
    const isPaused = r.status === "paused";
    const isCompleted = r.status === "completed";
    let statusBadge = '<span class="res-badge res-badge-scheduled">Programada</span>';
    if (isPaused) statusBadge = '<span class="res-badge res-badge-paused">Pausada</span>';
    if (isCompleted) statusBadge = '<span class="res-badge res-badge-completed">Completada</span>';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${r.date}T12:00:00`)) : r.date || 'Sin fecha';

    return `
      <article class="reservation-card ${isPaused ? 'is-paused' : ''} ${isCompleted ? 'is-completed' : ''}" data-id="${esc(r.id)}">
        <div class="res-card-head">
          <div class="res-phone-box">
            <span class="res-label">Nº:</span>
            <strong class="res-phone">${esc(r.phone)}</strong>
          </div>
          ${statusBadge}
        </div>

        <div class="res-card-body">
          <div class="res-row">
            <span class="res-label">Empresa o contacto</span>
            <span class="res-company">${esc(r.company || r.name || 'Sin especificar')}</span>
          </div>

          <div class="res-row res-quote-box">
            <span class="res-label">Cotización</span>
            <p class="res-quote-text">${esc(r.quote || 'Sin detalle')}</p>
          </div>

          <div class="res-row">
            <span class="res-label">Precio estimado</span>
            <strong class="res-price">${r.price ? `S/ ${esc(r.price)}` : 'Por cotizar'}</strong>
          </div>

          <div class="res-datetime-grid">
            <div class="res-datetime-item">
              <span class="res-label">Fecha de llamada</span>
              <strong class="res-datetime-val">${esc(date)}</strong>
            </div>
            <div class="res-datetime-item">
              <span class="res-label">Hora</span>
              <strong class="res-datetime-val">${esc(r.time || 'Sin hora')}</strong>
            </div>
          </div>

          ${r.notes ? `
          <div class="res-notes-box">
            <small class="muted">Nota: ${esc(r.notes)}</small>
          </div>` : ''}
        </div>

        <div class="res-card-actions">
          <button type="button" class="res-btn-call" data-action="call" data-id="${esc(r.id)}" ${isCompleted ? 'disabled' : ''}>
            Llamar
          </button>
          <button type="button" class="res-btn-pause" data-action="toggle-pause" data-id="${esc(r.id)}">
            ${isPaused ? 'Reanudar' : 'Pausar'}
          </button>
          <button type="button" class="res-btn-secondary" data-action="edit" data-id="${esc(r.id)}">
            Editar
          </button>
          <button type="button" class="res-btn-secondary" data-action="toggle-complete" data-id="${esc(r.id)}">
            ${isCompleted ? 'Reabrir' : 'Completar'}
          </button>
          <button type="button" class="res-btn-delete" data-action="delete" data-id="${esc(r.id)}" title="Eliminar reserva" aria-label="Eliminar reserva de ${esc(r.name || r.phone)}">
            ✕
          </button>
        </div>
      </article>
    `;
  }).join("");
}

export function initReservationsView() {
  if (reservationsState.initialized) {
    loadReservations();
    return;
  }
  reservationsState.initialized = true;

  document.getElementById('reservationsEmptyAction')?.addEventListener('click', (event) => {
    const mode = event.currentTarget.dataset.mode;
    if (mode === 'retry') return loadReservations();
    if (mode !== 'reset') return openQuoteModal();
    reservationsState.activeFilter = 'all';
    reservationsState.searchQuery = '';
    const search = document.getElementById('reservationsSearchInput');
    if (search) search.value = '';
    document.querySelectorAll('.res-filter-btn').forEach(button => {
      const active = button.dataset.status === 'all';
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    renderReservations();
  });

  const quoteModal = document.getElementById('quoteModal');
  quoteModal?.addEventListener('click', event => {
    if (event.target === quoteModal) closeQuoteModal();
  });
  quoteModal?.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeQuoteModal();
    if (event.key !== 'Tab') return;
    const fields = [...quoteModal.querySelectorAll('button, input:not([type="hidden"]), textarea, select')].filter(el => !el.disabled && el.getClientRects().length);
    const first = fields[0];
    const last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });

  // Botón volver a llamadas
  const backBtn = document.getElementById("reservationsBackBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => showPanelView("calls"));
  }

  // Botón nueva reserva
  const newBtn = document.getElementById("newReservationBtn");
  if (newBtn) {
    newBtn.addEventListener("click", () => openQuoteModal());
  }

  // Botón cotización en el modal de llamada activa
  const modalQuoteBtn = document.getElementById("modalQuoteBtn");
  if (modalQuoteBtn) {
    modalQuoteBtn.addEventListener("click", () => {
      const callNumber = document.getElementById("callNumber")?.textContent.trim();
      const callName = document.getElementById("callName")?.textContent.trim();
      openQuoteModal({
        phone: callNumber !== "-" ? callNumber : "",
        name: callName !== "Sin contacto" ? callName : ""
      });
    });
  }

  // Modal cerrar / cancelar
  const closeBtn = document.getElementById("quoteCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeQuoteModal);
  const cancelBtn = document.getElementById("quoteCancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeQuoteModal);

  // Modal guardar
  const form = document.getElementById("quoteForm");
  if (form) form.addEventListener("submit", handleSaveQuote);

  // Filtros de estado
  const filterBtns = document.querySelectorAll(".res-filter-btn");
  filterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      filterBtns.forEach(b => { b.classList.remove("active"); b.setAttribute('aria-pressed', 'false'); });
      btn.classList.add("active");
      btn.setAttribute('aria-pressed', 'true');
      reservationsState.activeFilter = btn.dataset.status || "all";
      renderReservations();
    });
  });

  // Búsqueda
  const searchInput = document.getElementById("reservationsSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      reservationsState.searchQuery = e.target.value;
      renderReservations();
    });
  }

  // Acciones en tarjetas (Delegación de eventos)
  const container = document.getElementById("reservationsCardsGrid");
  if (container) {
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (!id) return;

      if (action === "call") handleCallReservation(id);
      else if (action === "toggle-pause") handleTogglePause(id);
      else if (action === "toggle-complete") handleToggleComplete(id);
      else if (action === "edit") {
        const item = reservationsState.reservations.find(r => r.id === id);
        if (item) openQuoteModal(item);
      }
      else if (action === "delete") handleDeleteReservation(id);
    });
  }

  // Sockets en tiempo real
  if (socket) {
    socket.on("quote:open_modal", (data) => {
      console.info("[SOCKET] quote:open_modal recibido:", data);
      openQuoteModal(data);
    });

    socket.on("reservations:changed", (data) => {
      if (Array.isArray(data?.reservations)) {
        reservationsState.reservations = data.reservations;
        renderReservations();
      } else {
        loadReservations();
      }
    });
  }

  loadReservations();
}

// Auto-escuchar socket para abrir modal de cotización incluso si el usuario está en otra vista
if (socket) {
  socket.on("quote:open_modal", (data) => {
    console.info("[GLOBAL SOCKET] quote:open_modal recibido:", data);
    openQuoteModal(data);
  });
}
