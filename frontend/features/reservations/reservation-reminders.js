import { reservationDateKey } from './reservation-calendar.js';
import { playSystemSound } from '../../shared/ui/sounds.js';

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

function to12h(time24) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(String(time24 || ''));
  if (!m) return { hour: '09', minute: '00', period: 'AM' };
  const h24 = Number(m[1]);
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { hour: String(h12).padStart(2, '0'), minute: m[2], period };
}

function to24h(hour12, minute, period) {
  const h = Number(hour12);
  const m = String(minute || '00').padStart(2, '0');
  const isPm = String(period || 'AM').toUpperCase() === 'PM';
  const h24 = isPm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
  return `${String(h24).padStart(2, '0')}:${m}`;
}

// The browser must remain open. Native notifications are opt-in and never place calls.
export function createReservationReminders({ getIdentity, onOpen, onEditTime }) {
  let reservations = [], identity = '', timer = null, dock = null;
  let minimized = false;
  let editingKey = '';
  const soundedDueKeys = new Set();
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
    dock.innerHTML = '<header><strong>Reservas para llamar</strong><span class="reservation-reminder-count" role="status"></span><button type="button" class="reservation-reminder-toggle" aria-expanded="true" aria-controls="reservationReminderItems" aria-label="Minimizar recordatorios">−</button></header><div id="reservationReminderItems" class="reservation-reminder-items"></div>';
    dock.addEventListener('click', async event => {
      const toggle = event.target.closest('.reservation-reminder-toggle');
      if (toggle) {
        minimized = !minimized;
        dock.querySelector('.reservation-reminder-items').hidden = minimized;
        toggle.setAttribute('aria-expanded', String(!minimized));
        toggle.setAttribute('aria-label', minimized ? 'Mostrar recordatorios' : 'Minimizar recordatorios');
        toggle.textContent = minimized ? '+' : '−';
        return;
      }
      const button = event.target.closest('[data-reminder-action]');
      if (!button || button.disabled) return;
      const key = button.dataset.reservationReminder;
      const reservation = reservations.find(item => reservationReminderKey(item) === key);
      if (!reservation) return;
      const action = button.dataset.reminderAction;
      if (action === 'edit') {
        editingKey = editingKey === key ? '' : key;
        const list = dock.querySelector('.reservation-reminder-items');
        if (list) list.dataset.signature = '';
        check();
        return;
      }
      if (action === 'cancel-edit') {
        editingKey = '';
        const list = dock.querySelector('.reservation-reminder-items');
        if (list) list.dataset.signature = '';
        check();
        return;
      }
      if (action === 'save-time') {
        const article = button.closest('article');
        const hour = article?.querySelector('[data-reminder-hour]')?.value;
        const minute = article?.querySelector('[data-reminder-minute]')?.value;
        const period = article?.querySelector('[data-reminder-period]')?.value;
        if (!hour || !minute || !period || typeof onEditTime !== 'function') return;
        const newTime = to24h(hour, minute, period);
        button.disabled = true;
        try {
          await onEditTime(reservation, newTime);
          editingKey = '';
        } finally {
          button.disabled = false;
        }
        return;
      }
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
    if (due.some(r => !soundedDueKeys.has(reservationReminderKey(r)))) {
      for (const r of due) soundedDueKeys.add(reservationReminderKey(r));
      playSystemSound('reservationDue');
    }
    root.querySelector('.reservation-reminder-count').textContent = `${due.length} ${due.length === 1 ? 'pendiente' : 'pendientes'}`;
    const list = root.querySelector('.reservation-reminder-items');
    const signature = JSON.stringify([editingKey, due.map(r => [r.id, r.date, r.time, r.name, r.company, r.phone])]);
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren();
      for (const reservation of due.slice(0, 10)) {
        const key = reservationReminderKey(reservation);
        const item = document.createElement('article');
        const name = document.createElement('strong');
        name.textContent = reservation.company || reservation.name || reservation.phone || 'Reserva';
        const time = document.createElement('p');
        const formatted = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(reservationDueAt(reservation)));
        time.textContent = `${formatted} · ${reservation.phone || ''}`;
        const actions = document.createElement('div');
        if (editingKey === key) {
          const parts = to12h(reservation.time);
          const editor = document.createElement('div');
          editor.className = 'reminder-time-editor';
          const hourSel = document.createElement('select');
          hourSel.dataset.reminderHour = '1';
          hourSel.setAttribute('aria-label', 'Hora');
          for (let h = 1; h <= 12; h++) {
            const v = String(h).padStart(2, '0');
            hourSel.add(new Option(v, v, false, v === parts.hour));
          }
          const minSel = document.createElement('select');
          minSel.dataset.reminderMinute = '1';
          minSel.setAttribute('aria-label', 'Minuto');
          for (let m = 0; m < 60; m++) {
            const v = String(m).padStart(2, '0');
            minSel.add(new Option(v, v, false, v === parts.minute));
          }
          const periodSel = document.createElement('select');
          periodSel.dataset.reminderPeriod = '1';
          periodSel.setAttribute('aria-label', 'AM o PM');
          for (const p of ['AM', 'PM']) {
            periodSel.add(new Option(p, p, false, p === parts.period));
          }
          const saveBtn = document.createElement('button');
          saveBtn.type = 'button';
          saveBtn.textContent = 'Guardar';
          saveBtn.dataset.reminderAction = 'save-time';
          saveBtn.dataset.reservationReminder = key;
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.textContent = 'Cancelar';
          cancelBtn.dataset.reminderAction = 'cancel-edit';
          cancelBtn.dataset.reservationReminder = key;
          editor.append(hourSel, minSel, periodSel, saveBtn, cancelBtn);
          item.append(name, time, editor);
        } else {
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.textContent = 'Editar';
          editBtn.dataset.reminderAction = 'edit';
          editBtn.dataset.reservationReminder = key;
          actions.append(editBtn);
          item.append(name, time, actions);
        }
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
