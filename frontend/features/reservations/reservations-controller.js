import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { showPanelView } from '../../app/navigation/panel-navigation.js';
import { apiFetch, currentUser } from '../auth/auth-session.js';
import { dashboardSessionKeys } from '../workspace/dashboard-session.js';
import { limaToday, reservationMonth, reservationYear, reservationsInScope, shiftReservationMonth } from './reservation-calendar.js';
import { createReservationReminders } from './reservation-reminders.js';

let reservationsState = {
  reservations: [],
  activeFilter: 'all',
  searchQuery: '',
  initialized: false,
  month: limaToday().slice(0, 7),
  year: Number(limaToday().slice(0, 4)),
  yearVisible: true,
  returnToYear: true,
  selectedDay: '',
  listVisible: false,
  calendarMessage: 'Cargando reservas…'
};
let quoteReturnFocus = null;
let activeReservationType = "quote";
const reservationReminders = createReservationReminders({
  getIdentity: () => {
    const userId = (currentUser || window.VOIP_VC_AUTH_USER)?.id;
    const code = getSessionCode();
    return userId && code ? `${userId}.${code}` : '';
  },
  onOpen: async reservation => {
    if (window.navigatePanel) await window.navigatePanel('reservations');
    else { showPanelView('reservations'); initReservationsView(); }
    reservationsState.year = Number(reservation.date.slice(0, 4));
    reservationsState.month = reservation.date.slice(0, 7);
    reservationsState.yearVisible = true;
    openReservationScope(reservation.date);
    [...document.querySelectorAll('.reservation-card')].find(card => card.dataset.id === String(reservation.id))?.scrollIntoView({ block: 'center' });
  }
});

function getSessionCode() {
  const input = document.getElementById("sessionCode");
  if (input && input.value) return input.value.trim().toUpperCase();
  const keys = dashboardSessionKeys((currentUser || window.VOIP_VC_AUTH_USER)?.id);
  return keys ? String(localStorage.getItem(keys.session) || "").trim().toUpperCase() : "";
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

function getDashboardToken(code) {
  const userId = (currentUser || window.VOIP_VC_AUTH_USER)?.id;
  const keys = dashboardSessionKeys(userId);
  if (!keys || !code) return "";
  try {
    return String(localStorage.getItem(`${keys.tokenPrefix}${code}`) || "").trim();
  } catch {
    return "";
  }
}

function reservationFetch(code, suffix = "", options = {}) {
  const headers = new Headers(options.headers);
  const token = getDashboardToken(code);
  if (token) headers.set("x-dashboard-token", token);
  return apiFetch(`${API_BASE}/api/session/${encodeURIComponent(code)}/reservations${suffix}`, {
    ...options,
    headers
  });
}

export async function loadReservations() {
  const code = getSessionCode();
  if (!code || !getDashboardToken(code)) {
    reservationsState.calendarMessage = 'Conectando con tu espacio de trabajo…';
    renderReservationCalendar();
    const count = document.getElementById('reservationsResultCount');
    if (count) count.textContent = 'Conectando con tu espacio de trabajo…';
    return;
  }

  reservationsState.calendarMessage = 'Cargando reservas…';
  renderReservationCalendar();
  try {
    const res = await reservationFetch(code, "", {
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (code !== getSessionCode()) return;
    reservationsState.reservations = Array.isArray(data.reservations) ? data.reservations : [];
    reservationsState.calendarMessage = '';
    renderReservations();
  } catch (err) {
    reservationsState.calendarMessage = 'No pudimos actualizar las reservas. Pulsa «Actualizar» para volver a intentarlo.';
    renderReservationCalendar();
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
  const today = limaToday(now);
  const inAgenda = document.getElementById('reservationsView')?.hidden === false;
  const todayStr = inAgenda && /^\d{4}-\d{2}-\d{2}$/.test(reservationsState.selectedDay) ? reservationsState.selectedDay
    : inAgenda && reservationsState.month !== today.slice(0, 7) ? `${reservationsState.month}-01` : today;
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
      res = await reservationFetch(code, `/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      res = await reservationFetch(code, "", {
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
    const res = await reservationFetch(code, `/${encodeURIComponent(id)}/call`, {
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
    await reservationFetch(code, `/${encodeURIComponent(id)}`, {
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
    await reservationFetch(code, `/${encodeURIComponent(id)}`, {
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
    await reservationFetch(code, `/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
    await loadReservations();
  } catch (err) {
    console.error("[RESERVATIONS] Error al eliminar:", err);
  }
}

function renderReservationCalendar() {
  const calendar = document.getElementById('reservationsCalendar');
  if (!calendar) return;
  const month = reservationMonth(reservationsState.month, reservationsState.reservations);
  calendar.hidden = reservationsState.yearVisible || reservationsState.listVisible;
  const yearView = document.getElementById('reservationsYearCalendar');
  if (yearView) {
    yearView.hidden = !reservationsState.yearVisible || reservationsState.listVisible;
    const year = reservationYear(reservationsState.year, reservationsState.reservations);
    const thisMonth = limaToday().slice(0, 7);
    document.getElementById('reservationsYearTitle').textContent = `Reservas de ${reservationsState.year}`;
    const today = limaToday();
    document.getElementById('reservationsYearMonths').innerHTML = year.months.map(month => {
      const calendar = reservationMonth(month.key, reservationsState.reservations, { weekStartsOn: 0 });
      return `<article class="res-year-month${month.key === thisMonth ? ' is-current-month' : ''}" data-calendar-month="${month.key}" aria-label="${esc(month.label)} de ${reservationsState.year}">
        <header class="res-mini-header"><span class="res-mini-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v5M16 3v5M4 11h16"/></svg></span><strong>${esc(month.label)}</strong><span class="res-mini-total" aria-label="${month.count} reservas en el mes">${month.count}</span></header>
        <div class="res-mini-weekdays" aria-hidden="true"><span>D</span><span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span></div>
        <div class="res-mini-days" role="group" aria-label="Días de ${esc(month.label)}">${calendar.cells.map(day => {
          if (!day) return '<span aria-hidden="true"></span>';
          const label = new Intl.DateTimeFormat('es-PE', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`));
          return `<button type="button" class="res-mini-day${day.count ? ' has-reservations' : ''}${day.date === today ? ' is-today' : ''}" data-reservation-year-day="${day.date}" aria-pressed="${day.date === reservationsState.selectedDay}" aria-label="${esc(label)}, ${day.count} reservas. Doble clic para abrir"${day.date === today ? ' aria-current="date"' : ''}><span>${day.number}</span>${day.count ? `<small class="res-mini-count" aria-hidden="true">${day.count}</small>` : ''}</button>`;
        }).join('')}</div>
      </article>`;
    }).join('');
    document.getElementById('reservationsYearCount').textContent = `${year.total} ${year.total === 1 ? 'reserva' : 'reservas'} en ${reservationsState.year}`;
    const yearMessage = document.getElementById('reservationsYearStatus');
    yearMessage.textContent = reservationsState.calendarMessage;
    yearMessage.hidden = !reservationsState.calendarMessage;
    const undatedButton = document.getElementById('reservationsYearUndated');
    undatedButton.hidden = !year.undated;
    undatedButton.textContent = `Sin fecha (${year.undated})`;
  }
  const list = document.getElementById('reservationsListView');
  if (list) list.hidden = !reservationsState.listVisible;
  document.getElementById('reservationsMonthTitle').textContent = month.label;
  const message = document.getElementById('reservationsCalendarStatus');
  message.textContent = reservationsState.calendarMessage;
  message.hidden = !reservationsState.calendarMessage;
  document.getElementById('reservationsMonthCount').textContent = `${month.total} ${month.total === 1 ? 'reserva en este mes' : 'reservas en este mes'}`;
  const undated = document.getElementById('reservationsUndated');
  undated.hidden = !month.undated;
  undated.textContent = `Sin fecha (${month.undated})`;
  const today = limaToday();
  document.getElementById('reservationsCalendarDays').innerHTML = month.cells.map(day => {
    if (!day) return '<span class="res-calendar-blank" aria-hidden="true"></span>';
    const label = new Intl.DateTimeFormat('es-PE', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`));
    return `<button type="button" class="res-calendar-day${day.count ? ' has-reservations' : ''}${day.date === today ? ' is-today' : ''}" data-reservation-day="${day.date}" aria-label="${esc(label)}, ${day.count} reservas" aria-pressed="${day.date === reservationsState.selectedDay}"${day.date === today ? ' aria-current="date"' : ''}><span class="res-calendar-number">${day.number}</span>${day.count ? `<span class="res-calendar-count">${day.count}<span class="res-calendar-count-word"> ${day.count === 1 ? 'reserva' : 'reservas'}</span></span>` : '<span class="res-calendar-no-events" aria-hidden="true">—</span>'}</button>`;
  }).join('');
  const title = document.getElementById('reservationsScopeTitle');
  title.textContent = reservationsState.selectedDay === 'undated' ? 'Reservas sin fecha'
    : reservationsState.selectedDay ? new Intl.DateTimeFormat('es-PE', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${reservationsState.selectedDay}T12:00:00Z`))
    : `Reservas de ${month.label}`;
}

function openReservationScope(day = '') {
  reservationsState.returnToYear = reservationsState.yearVisible;
  reservationsState.yearVisible = false;
  reservationsState.selectedDay = day;
  reservationsState.listVisible = true;
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
  document.getElementById('reservationsScopeTitle')?.focus({ preventScroll: true });
}

export function renderReservations() {
  reservationReminders.update(reservationsState.reservations);
  renderReservationCalendar();
  const container = document.getElementById("reservationsCardsGrid");
  const emptyState = document.getElementById("reservationsEmptyState");
  if (!container) return;

  const all = reservationsInScope(reservationsState.reservations, reservationsState.month, reservationsState.selectedDay);
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
  filtered = [...filtered].sort((a, b) => `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`));

  const resultCount = document.getElementById('reservationsResultCount');
  if (resultCount) resultCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'reserva' : 'reservas'}${filtered.length !== all.length ? ` de ${all.length}` : ''}`;
  const emptyTitle = document.getElementById('reservationsEmptyTitle');
  const emptyDescription = document.getElementById('reservationsEmptyDescription');
  const emptyAction = document.getElementById('reservationsEmptyAction');
  const hasFilters = Boolean(query || reservationsState.activeFilter !== 'all');
  if (emptyTitle) emptyTitle.textContent = hasFilters ? 'No encontramos reservas' : 'No tienes reservas en esta fecha';
  if (emptyDescription) emptyDescription.textContent = hasFilters ? 'Prueba con otro término o restablece los filtros para ver tu agenda.' : 'Puedes crear una reserva aquí o volver al calendario para elegir otra fecha.';
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
  reservationReminders.notificationStatus();
  reservationsState.yearVisible = true;
  reservationsState.listVisible = false;
  renderReservations();
  if (reservationsState.initialized) {
    loadReservations();
    return;
  }
  reservationsState.initialized = true;
  const yearMonths = document.getElementById('reservationsYearMonths');
  let lastTouchDay = '', lastTouchAt = 0;
  const openYearDay = button => {
    if (!button || reservationsState.listVisible) return;
    const day = button.dataset.reservationYearDay;
    reservationsState.month = day.slice(0, 7);
    openReservationScope(day);
  };
  yearMonths?.addEventListener('click', event => {
    const button = event.target.closest('[data-reservation-year-day]');
    if (!button) return;
    reservationsState.selectedDay = button.dataset.reservationYearDay;
    reservationsState.month = reservationsState.selectedDay.slice(0, 7);
    yearMonths.querySelectorAll('[aria-pressed="true"]').forEach(day => day.setAttribute('aria-pressed', 'false'));
    button.setAttribute('aria-pressed', 'true');
    if (event.detail === 0) return openYearDay(button); // Activación por teclado o lector de pantalla.
    if (event.pointerType === 'touch') {
      const now = Date.now();
      if (lastTouchDay === reservationsState.selectedDay && now - lastTouchAt < 500) {
        lastTouchDay = '';
        return openYearDay(button);
      }
      lastTouchDay = reservationsState.selectedDay;
      lastTouchAt = now;
    }
  });
  yearMonths?.addEventListener('dblclick', event => openYearDay(event.target.closest('[data-reservation-year-day]')));
  const moveYear = offset => {
    reservationsState.year += offset;
    reservationsState.month = `${reservationsState.year}-${reservationsState.month.slice(5)}`;
    reservationsState.selectedDay = '';
    renderReservationCalendar();
  };
  document.getElementById('reservationsPrevYear')?.addEventListener('click', () => moveYear(-1));
  document.getElementById('reservationsNextYear')?.addEventListener('click', () => moveYear(1));
  document.getElementById('reservationsCurrentYear')?.addEventListener('click', () => {
    reservationsState.year = Number(limaToday().slice(0, 4));
    reservationsState.month = limaToday().slice(0, 7);
    reservationsState.selectedDay = '';
    renderReservationCalendar();
  });
  document.getElementById('reservationsYearRefresh')?.addEventListener('click', loadReservations);
  document.getElementById('reservationsYearUndated')?.addEventListener('click', () => openReservationScope('undated'));
  document.getElementById('reservationsYearBack')?.addEventListener('click', () => {
    reservationsState.yearVisible = true;
    renderReservationCalendar();
    document.getElementById('reservationsCurrentYear')?.focus();
  });
  document.getElementById('reservationsCalendarDays')?.addEventListener('click', event => {
    const button = event.target.closest('[data-reservation-day]');
    if (button) openReservationScope(button.dataset.reservationDay);
  });
  const moveMonth = offset => {
    reservationsState.month = shiftReservationMonth(reservationsState.month, offset);
    reservationsState.year = Number(reservationsState.month.slice(0, 4));
    reservationsState.selectedDay = '';
    renderReservationCalendar();
  };
  document.getElementById('reservationsPrevMonth')?.addEventListener('click', () => moveMonth(-1));
  document.getElementById('reservationsNextMonth')?.addEventListener('click', () => moveMonth(1));
  document.getElementById('reservationsToday')?.addEventListener('click', () => {
    reservationsState.month = limaToday().slice(0, 7);
    reservationsState.year = Number(limaToday().slice(0, 4));
    reservationsState.selectedDay = limaToday();
    renderReservationCalendar();
    document.querySelector('[data-reservation-day][aria-current="date"]')?.focus();
  });
  document.getElementById('reservationsViewMonth')?.addEventListener('click', () => openReservationScope());
  document.getElementById('reservationsUndated')?.addEventListener('click', () => openReservationScope('undated'));
  document.getElementById('reservationsRefresh')?.addEventListener('click', loadReservations);
  document.getElementById('reservationsCalendarBack')?.addEventListener('click', () => {
    reservationsState.listVisible = false;
    reservationsState.yearVisible = reservationsState.returnToYear;
    renderReservationCalendar();
    if (reservationsState.yearVisible) {
      [...yearMonths.querySelectorAll('[data-reservation-year-day]')].find(day => day.dataset.reservationYearDay === reservationsState.selectedDay)?.focus();
    } else document.getElementById('reservationsViewMonth')?.focus();
  });

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

  loadReservations();
}

// Auto-escuchar socket para abrir modal de cotización incluso si el usuario está en otra vista
if (socket) {
  // Los recordatorios funcionan también en Llamadas y en las demás secciones.
  socket.on('reservations:changed', data => {
    if (Array.isArray(data?.reservations)) {
      reservationsState.reservations = data.reservations;
      reservationsState.calendarMessage = '';
      renderReservations();
    } else loadReservations();
  });
  // El dashboard guarda la sesión y su credencial en sus propios listeners.
  const refreshAfterJoin = () => {
    setTimeout(() => loadReservations(), 0);
  };
  socket.on("session:created", refreshAfterJoin);
  socket.on("session:joined", ({ role }) => {
    if (role === "dashboard") refreshAfterJoin();
  });
  socket.on("quote:open_modal", (data) => {
    console.info("[GLOBAL SOCKET] quote:open_modal recibido:", data);
    openQuoteModal(data);
  });
}
