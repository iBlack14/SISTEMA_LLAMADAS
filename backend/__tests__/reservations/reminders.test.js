import test from 'node:test';
import assert from 'node:assert/strict';
import { reservationDueAt, reservationReminderKey, dueReservationReminders } from '../../../frontend/features/reservations/reservation-reminders.js';
import { registerReservations } from '../../routes/reservations.js';

const reservation = { id: 'r1', date: '2026-11-27', time: '11:00', status: 'scheduled' };
const due = Date.parse('2026-11-27T16:00:00Z');

test('a reservation due at 11:00 Lima becomes due at 16:00 UTC', () => {
  assert.equal(reservationDueAt(reservation), due);
  assert.equal(dueReservationReminders([reservation], due - 1).length, 0);
  assert.equal(dueReservationReminders([reservation], due).length, 1);
});

test('overdue reservations are recovered when the panel opens later', () => {
  assert.equal(dueReservationReminders([reservation], due + 86400000).length, 1);
});

test('invalid dates and times never schedule an alert', () => {
  for (const fields of [{ date: '2026-11-31' }, { time: '25:00' }, { time: '' }, { date: '' }]) {
    assert.equal(reservationDueAt({ ...reservation, ...fields }), null);
  }
});

test('completed, paused, dismissed and snoozed reservations do not alert', () => {
  const key = reservationReminderKey(reservation);
  assert.equal(dueReservationReminders([{ ...reservation, status: 'completed' }, { ...reservation, status: 'paused' }], due).length, 0);
  assert.equal(dueReservationReminders([reservation], due, { [key]: { dismissed: true } }).length, 0);
  assert.equal(dueReservationReminders([reservation], due, { [key]: { snoozeUntil: due + 600000 } }).length, 0);
  assert.equal(dueReservationReminders([reservation], due + 600000, { [key]: { snoozeUntil: due + 600000 } }).length, 1);
});

test('changing the reservation time creates a new reminder', () => {
  const edited = { ...reservation, time: '12:00' };
  assert.notEqual(reservationReminderKey(reservation), reservationReminderKey(edited));
  assert.equal(dueReservationReminders([edited], due + 3600000, { [reservationReminderKey(reservation)]: { dismissed: true } }).length, 1);
});

test('reminders are sorted by due time and missing IDs are ignored', () => {
  const earlier = { ...reservation, id: 'r2', time: '10:00' };
  assert.deepEqual(dueReservationReminders([reservation, earlier, { ...reservation, id: '' }], due).map(r => r.id), ['r2', 'r1']);
});

test('reservation changes are broadcast to the account session room', () => {
  const handlers = new Map(), emitted = [];
  const session = { contactReservations: [] };
  const runtime = {
    sessions: new Map([['TEST', session]]),
    app: Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, handler) => handlers.set(method + path, handler)])),
    io: { to: room => ({ emit: (event, data) => emitted.push({ room, event, data }) }) }
  };
  registerReservations(runtime, { saveSoon() {} });
  handlers.get('post/api/session/:code/reservations')({ params: { code: 'TEST' }, body: { ...reservation, phone: '900000001' } }, { json() {} });
  assert.equal(emitted[0].room, 'TEST');
  assert.equal(emitted[0].event, 'reservations:changed');
  assert.equal(emitted[0].data.reservations.length, 1);
});
