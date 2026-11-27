import { reservationDateKey } from './reservation-calendar.js';

export function reservationDueAt(reservation) {
  const day = reservationDateKey(reservation.date);
  const time = String(reservation.time || '');
  if (!day || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) return null;
  return Date.parse(`${day}T${time.length === 5 ? `${time}:00` : time}-05:00`);
}

export function reservationReminderKey(reservation) {
  return JSON.stringify([String(reservation.id), reservation.date, reservation.time]);
}

export function dueReservationReminders(reservations, now, preferences = {}) {
  return reservations.filter(reservation => {
    if (!reservation.id || (reservation.status || 'scheduled') !== 'scheduled') return false;
    const at = reservationDueAt(reservation);
    const saved = preferences[reservationReminderKey(reservation)];
    return at !== null && at <= now && !saved?.dismissed && !(saved?.snoozeUntil > now);
  }).sort((a, b) => reservationDueAt(a) - reservationDueAt(b));
}

// The browser must remain open. Native notifications are opt-in and never place calls.
export function createReservationReminders({ getIdentity, onOpen }) {
  let reservations = [], identity = '', timer = null, dock = null;
  const fallback = new Map();
  const storageKey = () => `viavox.reservation-reminders.${identity}`;
  function preferences() {
    try {
      const saved = localStorage.getItem(storageKey());
      return saved ? JSON.parse(saved) || {} : fallback.get(identity) || {};
    }
    catch { return fallback.get(identity) || {}; }
  }
  function save(value) {
    fallback.set(identity, value);
    try { localStorage.setItem(storageKey(), JSON.stringify(value)); } catch { /* Per-tab reminders still work. */ }
  }
  function notificationStatus() {
    const button = document.getElementById('enableReservationNotifications');
    const status = document.getElementById('reservationNotificationStatus');
    if (!button || !status) return;
    const supported = 'Notification' in window && window.isSecureContext;
    const permission = supported ? Notification.permission : 'unavailable';
    button.disabled = permission !== 'default';
    button.textContent = permission === 'granted' ? 'Notificaciones activadas' : permission === 'denied' ? 'Permiso bloqueado' : 'Activar notificaciones';
    status.textContent = permission === 'granted'
      ? 'Avisos en la fecha y hora de Lima. Mantén el panel abierto, incluso en otra pestaña.'
      : permission === 'denied' ? 'Los avisos del panel siguen activos. Para recibir notificaciones, habilita el permiso en tu navegador.'
      : permission === 'unavailable' ? 'Recordatorios visibles mientras el panel esté abierto. Este navegador no permite notificaciones del sistema aquí.'
      : 'Recibirás un aviso en el panel a la hora de llamar. Activa las notificaciones para ver el aviso en segundo plano. Mantén el panel abierto.';
    if (!button.dataset.reminderBound) {
      button.dataset.reminderBound = 'true';
      button.addEventListener('click', async () => {
        if (!('Notification' in window)) return;
        try { await Notification.requestPermission(); } catch { /* Keep the in-panel reminder. */ }
        notificationStatus();
        check();
      });
    }
  }
  function ensureDock() {
    if (dock) return dock;
    dock = document.createElement('aside');
    dock.id = 'reservationReminderDock';
    dock.setAttribute('aria-label', 'Recordatorios de reservas');
    dock.hidden = true;
    dock.innerHTML = '<header><strong>Reservas para llamar</strong><span class="reservation-reminder-count" role="status"></span></header><div class="reservation-reminder-items"></div>';
    dock.addEventListener('click', event => {
      const button = event.target.closest('[data-reservation-reminder]');
      if (!button) return;
      const reservation = reservations.find(item => reservationReminderKey(item) === button.dataset.reservationReminder);
      if (!reservation) return;
      const action = button.dataset.reminderAction;
      if (action === 'open') { onOpen(reservation); return; }
      const saved = preferences();
      saved[reservationReminderKey(reservation)] = action === 'snooze'
        ? { snoozeUntil: Date.now() + 10 * 60 * 1000, notifiedAt: 0 }
        : { dismissed: true };
      save(saved);
      check();
    });
    document.body.append(dock);
    return dock;
  }
  function check() {
    notificationStatus();
    if (!identity || identity !== getIdentity()) { if (dock) dock.hidden = true; return; }
    const saved = preferences();
    const now = Date.now();
    const due = dueReservationReminders(reservations, now, saved);
    const root = ensureDock();
    root.hidden = !due.length;
    root.querySelector('.reservation-reminder-count').textContent = `${due.length} ${due.length === 1 ? 'pendiente' : 'pendientes'}`;
    const list = root.querySelector('.reservation-reminder-items');
    const signature = JSON.stringify(due.map(r => [r.id, r.date, r.time, r.name, r.company, r.phone]));
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren();
      for (const reservation of due.slice(0, 10)) {
        const item = document.createElement('article');
        const name = document.createElement('strong');
        name.textContent = reservation.company || reservation.name || reservation.phone || 'Reserva';
        const time = document.createElement('p');
        const formatted = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(reservationDueAt(reservation)));
        time.textContent = `${formatted} · ${reservation.phone || ''}`;
        const actions = document.createElement('div');
        for (const [action, label] of [['open', 'Ver reserva'], ['snooze', 'Posponer 10 min'], ['dismiss', 'Ya visto']]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.dataset.reminderAction = action;
          button.dataset.reservationReminder = reservationReminderKey(reservation);
          actions.append(button);
        }
        item.append(name, time, actions);
        list.append(item);
      }
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const unnotified = due.filter(r => !saved[reservationReminderKey(r)]?.notifiedAt);
    if (!unnotified.length) return;
    try {
      const reservation = unnotified[0];
      const notification = new Notification(unnotified.length === 1 ? 'Es hora de llamar' : `${unnotified.length} reservas para llamar`, {
        body: `${reservation.company || reservation.name || reservation.phone} · ${reservation.date} ${reservation.time} (Lima)`,
        tag: `viavox-reservations-${identity}`, icon: '/shared/assets/images/favicon.webp'
      });
      for (const row of unnotified) saved[reservationReminderKey(row)] = { ...saved[reservationReminderKey(row)], notifiedAt: now };
      save(saved);
      notification.onclick = () => { window.focus(); onOpen(reservation); notification.close(); };
    } catch { /* The persistent panel reminder remains available. */ }
  }
  function update(rows) {
    reservations = rows;
    identity = getIdentity();
    if (!timer) {
      timer = setInterval(check, 15000);
      document.addEventListener('visibilitychange', check);
      window.addEventListener('focus', check);
      window.addEventListener('storage', event => { if (event.key === storageKey()) check(); });
    }
    check();
  }
  return { update, check, notificationStatus };
}
