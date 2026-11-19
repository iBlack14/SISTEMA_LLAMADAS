import test from "node:test";
import assert from "node:assert/strict";
import { equipmentStatus, displayState } from "../../../frontend/features/admin/network/equipment-status.js";

test("equipment labels separate activity duration from connection duration", () => {
  const now = Date.parse("2026-11-19T09:12:00Z");
  const item = { deviceId: "phone-1", connectedAt: "2026-11-19T09:00:00Z", stateSince: "2026-11-19T09:08:00Z" };
  for (const [state, label, connection] of [["Disponible", "Conectado S/LL", "connected"], ["En llamada", "Llamando", "connected"], ["Marcando", "Timbrando", "connected"], ["Desconectado", "Desconectado", "disconnected"]]) {
    const status = equipmentStatus({ ...item, state }, true, now);
    assert.equal(status.label, label);
    assert.equal(status.connection, connection);
    assert.equal(status.seconds, 240);
  }
  assert.equal(equipmentStatus({ ...item, state: "Disponible" }, true, now + 10000).seconds, 250);
});

test("missing state timestamps and unavailable equipment never invent durations", () => {
  const now = Date.parse("2026-11-19T09:12:00Z");
  const item = { deviceId: "phone-1", state: "Disponible", connectedAt: "2026-11-19T09:00:00Z", connectedDurationSeconds: 720 };
  for (const stateSince of [undefined, null, "invalid", "2026-11-19T09:13:00Z"]) {
    assert.equal(equipmentStatus({ ...item, stateSince }, true, now).seconds, null);
  }
  assert.equal(equipmentStatus({ ...item, stateSince: "2026-11-19T09:08:00Z" }, true, NaN).seconds, null);
  for (const [equipment, live, expected] of [[item, false, "Sin se\u00f1al de estado"], [{ ...item, deviceId: null }, true, "Sin equipo"], [{ ...item, state: "Sin vincular" }, true, "Sin equipo"]]) {
    const status = equipmentStatus(equipment, live, now);
    assert.equal(status.label, expected);
    assert.equal(displayState(equipment, live), expected);
    assert.equal(status.connection, "unknown");
    assert.equal(status.seconds, null);
  }
});

test("unknown activity never implies a confirmed disconnection", () => {
  const item = { deviceId: "phone-1", state: "unrecognized" };
  const unknown = equipmentStatus(item, true, Date.now());
  assert.equal(unknown.label, "Sin se\u00f1al de estado");
  assert.equal(unknown.connectionLabel, "Sin confirmar");
  assert.equal(unknown.connection, "unknown");
  assert.equal(equipmentStatus({ state: "Sin datos" }, false, Date.now()).connectionLabel, "Sin vincular");
  assert.equal(displayState({ ...item, state: "Desconectado" }, true), "Desconectado");
  assert.equal(displayState({ ...item, state: "Desconectado" }, false), "Sin se\u00f1al de estado");
});
