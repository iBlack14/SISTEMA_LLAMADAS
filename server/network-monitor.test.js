import test from "node:test";
import assert from "node:assert/strict";
import { NetworkMonitor } from "./network-monitor.js";
import { summarizeAttempts } from "../web/modules/report-metrics.js";

function fixture() {
  let now = Date.parse("2026-11-09T14:00:00Z");
  const session = { pairingSlots: [{ id: "slot", deviceId: "TEST-phone", deviceName: "[PRUEBA] Celular" }],
    phoneWorkers: [{ id: "TEST-phone", socketId: "phone-1", connected: true, callState: "dialing" }],
    shiftManagement: { current: { id: "turn", type: "morning", date: "2026-11-09", label: "Turno mañana", schedule: "07:00-14:00", status: "active", startedAt: "2026-11-09T12:00:00Z" } },
    contactBook: { preferences: { pairingListAssignments: { slot: "Prueba" } } },
    campaign: { status: "running", contacts: [{ id: "pending", list: "Prueba", status: "pending" }] } };
  const sessions = new Map([["TEST01", session]]);
  const connected = new Set(["phone-1"]);
  let rows = [];
  let unavailable = false;
  let reads = 0;
  const monitor = new NetworkMonitor({ pool: { query: async () => [[], []] },
    persistence: { getCallAttemptsForSessions: async codes => {
      reads++;
      if (unavailable) throw new Error("pending");
      return new Map(codes.map(code => [code, rows]));
    } },
    getSessions: () => sessions, isSocketConnected: id => connected.has(id), broadcast: () => {}, now: () => now });
  return { monitor, sessions, session, connected, get reads() { return reads; }, advance: () => { now += 1000; }, setRows: value => { rows = value; }, fail: () => { unavailable = true; } };
}

test("only device observations activate indicators; commands, campaign and pairing never do", async () => {
  const f = fixture();
  let data = await f.monitor.snapshot();
  assert.equal(data.equipment.length, 10);
  assert.equal(data.callingCount, 0);
  assert.equal(data.equipment[0].state, "Disponible");
  assert.equal(data.equipment[1].state, "Sin vincular");
  for (const [state, expected, count] of [["dialing", "Marcando", 1], ["ringing", "Marcando", 1], ["in_call", "En llamada", 1], ["ended", "Disponible", 0], ["idle", "Disponible", 0], ["failed", "Disponible", 0]]) {
    f.advance(); f.monitor.observe("TEST01", f.session.phoneWorkers[0], { callState: state });
    data = await f.monitor.snapshot();
    assert.equal(data.equipment[0].state, expected);
    assert.equal(data.callingCount, count);
  }
  f.monitor.observe("TEST01", f.session.phoneWorkers[0], { callState: "in_call" });
  assert.equal((await f.monitor.snapshot()).callingCount, 1);
  f.connected.clear();
  data = await f.monitor.snapshot();
  assert.equal(data.callingCount, 0);
  assert.equal(data.equipment[0].state, "Desconectado");
  f.connected.add("phone-2"); f.session.phoneWorkers[0].socketId = "phone-2";
  assert.equal((await f.monitor.snapshot()).callingCount, 0, "old connection evidence must not survive reconnect");
  f.session.pairingSlots = [];
  assert.equal((await f.monitor.snapshot()).equipment[0].state, "Sin vincular");
});

test("metrics distinguish known zero, unknown scope, operator announcements and pending contacts", async () => {
  const f = fixture();
  let data = await f.monitor.snapshot();
  assert.equal(data.equipment[0].metrics.total, 0);
  assert.equal(data.equipment[0].pending, 1);
  assert.equal(data.equipment[1].metrics, null);
  const common = { workerId: "TEST-phone", shiftId: "turn", startedAt: "2026-11-09T13:00:00Z", endedAt: "2026-11-09T13:01:00Z" };
  f.setRows([
    { ...common, technicalResult: "contesto", durationSeconds: 2 },
    { ...common, technicalResult: "buzon_de_voz", answeredAt: common.startedAt },
    { ...common, technicalResult: "sin_servicio", answeredAt: common.startedAt },
    { ...common, technicalResult: "sin_respuesta" },
    { ...common, technicalResult: "unknown" },
    { ...common, endedAt: null },
    { ...common, shiftId: "another-turn", technicalResult: "contesto" }
  ]);
  data = await f.monitor.snapshot();
  assert.deepEqual(data.equipment[0].metrics, { total: 6, answered: 1, unanswered: 2, inoperable: 1, inProgress: 1, unclassified: 1 });
  assert.deepEqual(data.summary.metrics, data.equipment[0].metrics);
  f.fail();
  assert.equal((await f.monitor.snapshot()).equipment[0].metrics, null);
  f.session.shiftManagement.current = null;
  assert.equal((await f.monitor.snapshot()).summary.metrics, null);
  assert.deepEqual(summarizeAttempts([]), { total: 0, answered: 0, unanswered: 0, inoperable: 0, inProgress: 0, unclassified: 0 });
});

test("numbering is physical-device based, capped at ten, and mixed turns are not consolidated", async () => {
  const f = fixture();
  await f.monitor.snapshot();
  const other = structuredClone(f.session);
  other.pairingSlots = Array.from({ length: 11 }, (_, i) => ({ id: `slot-${i}`, deviceId: `TEST-other-${i}` }));
  other.phoneWorkers = [];
  other.shiftManagement.current.type = "afternoon";
  f.sessions.set("TEST02", other);
  const data = await f.monitor.snapshot();
  assert.equal(data.equipment[0].deviceId, "TEST-phone");
  assert.equal(data.equipment.length, 10);
  assert.equal(data.overflow, 2);
  assert.equal(data.summary.metrics, null);
});

test("one batch supplies ten summaries; histories are lazy, isolated and limited to 30", async () => {
  const f = fixture();
  f.session.pairingSlots = Array.from({ length: 10 }, (_, i) => ({ id: `slot-${i}`, deviceId: `TEST-${i + 1}` }));
  const rows = [];
  for (let n = 1; n <= 10; n++) for (let i = 0; i < 35; i++) rows.push({
    attemptId: `phone-${n}-${i}`, workerId: `TEST-${n}`, shiftId: "turn", name: `Only equipment ${n}`,
    startedAt: new Date(Date.parse("2026-11-09T13:00:00Z") + i * 1000).toISOString(),
    endedAt: "2026-11-09T13:01:00Z", technicalResult: "contesto"
  });
  rows.push({ ...rows[0], attemptId: "wrong-turn", shiftId: "old-turn" });
  f.setRows(rows);
  const data = await f.monitor.snapshot();
  assert.equal(f.reads, 1);
  assert.equal(data.equipment.length, 10);
  assert.ok(data.equipment.every(e => e.metrics.total === 35 && !("activity" in e)));
  const details = await f.monitor.snapshot({ detailNumbers: [2, 7] });
  assert.equal(f.reads, 2);
  assert.equal(details.equipment[0].activity, undefined);
  for (const number of [2, 7]) {
    const item = details.equipment[number - 1];
    assert.equal(item.activity.length, 30);
    assert.ok(item.activity.every(row => row.name === `Only equipment ${number}`));
    assert.equal(item.activity[0].attemptId, `phone-${number}-34`);
  }
  assert.equal(data.equipment[1].historyVersion, details.equipment[1].historyVersion);
});
