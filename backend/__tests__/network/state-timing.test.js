import assert from "node:assert/strict";
import { test } from "node:test";
import { NetworkMonitor } from "../../services/network/network-monitor.js";

function fixture() {
  let now = Date.parse("2026-11-19T12:00:00Z");
  const workers = [1, 2].map(n => ({ id: `phone-${n}`, socketId: `socket-${n}`, connected: true }));
  const session = {
    pairingSlots: workers.map((worker, i) => ({ id: `slot-${i}`, deviceId: worker.id,
      linkedAt: "2020-01-01T00:00:00Z" })),
    phoneWorkers: workers
  };
  const sessions = new Map([["SESSION", session]]);
  const monitor = new NetworkMonitor({
    pool: { query: async () => [[]] },
    persistence: { getCallAttemptsForSessions: async () => new Map([["SESSION", []]]) },
    getSessions: () => sessions,
    isSocketConnected: socketId => workers.some(w => w.socketId === socketId && w.connected),
    broadcast: () => {}, now: () => now
  });
  monitor.registry = workers.map((worker, i) => ({ position: i + 1, device_id: worker.id,
    session_code: "SESSION", name: `Equipo ${i + 1}` }));
  return {
    monitor, workers, session, sessions,
    advance: () => { now += 1000; return new Date(now).toISOString(); },
    at: () => new Date(now).toISOString(),
    observe: (callState, callId, worker = workers[0], code = "SESSION") =>
      monitor.observe(code, worker, { callState, callId }),
    equipment: async (number = 1) => (await monitor.snapshot()).equipment[number - 1]
  };
}

test("display timing groups dialing/ringing and terminal/available states without changing backend labels", async () => {
  const f = fixture();
  f.observe("idle");
  assert.equal((await f.equipment()).stateSince, null);
  const dialAt = f.advance();
  f.observe("dialing", "call-1");
  assert.equal((await f.equipment()).stateSince, dialAt);
  f.advance();
  f.observe("ringing", "call-1");
  assert.equal((await f.equipment()).state, "Marcando");
  assert.equal((await f.equipment()).stateSince, dialAt);
  const answerAt = f.advance();
  f.observe("in_call", "call-1");
  assert.equal((await f.equipment()).state, "En llamada");
  assert.equal((await f.equipment()).stateSince, answerAt);
  f.advance();
  f.observe("in_call", "call-1");
  assert.equal((await f.equipment()).stateSince, answerAt);
  const endedAt = f.advance();
  f.observe("ended", "call-1");
  f.advance();
  f.observe("available");
  assert.equal((await f.equipment()).state, "Disponible");
  assert.equal((await f.equipment()).stateSince, endedAt);
  f.advance();
  f.observe("idle");
  assert.equal((await f.equipment()).stateSince, endedAt);
});

test("new conversations reset in_call even without an intermediate state; missing IDs do not reset it", async () => {
  const f = fixture();
  f.observe("idle");
  const first = f.advance();
  f.observe("in_call", "first");
  assert.equal((await f.equipment()).stateSince, first);
  f.advance();
  f.observe("in_call");
  assert.equal((await f.equipment()).stateSince, first);
  const second = f.advance();
  f.observe("in_call", "second");
  assert.equal((await f.equipment()).stateSince, second);
});

for (const terminal of ["ended", "failed"]) {
  test(`${terminal} establishes idle timing even when the active event was missed`, async () => {
    const f = fixture();
    f.observe("idle");
    const endedAt = f.advance();
    f.observe(terminal, "missed-call");
    assert.equal((await f.equipment()).stateSince, endedAt);
    f.advance();
    f.observe(terminal, "missed-call");
    f.advance();
    f.observe("available");
    assert.equal((await f.equipment()).stateSince, endedAt);

    const initial = fixture();
    initial.observe(terminal);
    assert.equal((await initial.equipment()).stateSince, initial.at());
  });
}

test("snapshots/reloads and repeated reports do not reset independent phone timers", async () => {
  const f = fixture();
  f.observe("ended");
  const first = f.at();
  const second = f.advance();
  f.observe("ended", undefined, f.workers[1]);
  f.advance();
  f.observe("available");
  const original = await f.equipment();
  f.advance();
  const reload = await f.equipment();
  assert.equal(reload.stateSince, first);
  assert.equal((await f.equipment(2)).stateSince, second);
  assert.equal(reload.connectedAt, original.connectedAt);
  assert.equal(reload.connectedAt, new Date(f.session.pairingSlots[0].linkedAt).toISOString());
  assert.notEqual(reload.stateSince, reload.connectedAt);
});

test("unobserved, unlinked, and initially active equipment have no invented start", async () => {
  const f = fixture();
  assert.equal((await f.equipment()).stateSince, null);
  assert.equal((await f.equipment(3)).stateSince, null);
  f.advance();
  f.observe("in_call", "already-active");
  assert.equal((await f.equipment()).stateSince, null);
  f.advance();
  f.observe("in_call", "already-active");
  assert.equal((await f.equipment()).stateSince, null);
  const end = f.advance();
  f.observe("ended", "already-active");
  assert.equal((await f.equipment()).stateSince, end);
  f.sessions.clear();
  assert.equal((await f.equipment()).state, "Sin vincular");
  assert.equal((await f.equipment()).stateSince, null);

  const restarted = fixture();
  assert.equal((await restarted.equipment()).stateSince, null);
});

test("socket replacement and stale code/socket reports cannot reuse or overwrite timing", async () => {
  const f = fixture();
  f.observe("idle");
  const oldWorker = { ...f.workers[0] };
  f.workers[0].socketId = "replacement";
  f.advance();
  assert.equal((await f.equipment()).stateSince, null);
  f.observe("in_call", "stale", oldWorker);
  f.observe("in_call", "wrong-session", f.workers[0], "OLD");
  assert.equal((await f.equipment()).stateSince, null);
  const current = f.advance();
  f.observe("ended");
  f.advance();
  f.observe("in_call", "stale", oldWorker);
  assert.equal((await f.equipment()).stateSince, current);
  assert.equal((await f.equipment()).state, "Disponible");
});

test("disconnect timing begins at detection, stays stable, and reconnect requires fresh observation", async () => {
  const f = fixture();
  f.observe("idle");
  f.advance();
  f.observe("in_call", "old");
  const disconnectedAt = f.advance();
  f.workers[0].connected = false;
  const disconnected = await f.equipment();
  assert.equal(disconnected.state, "Desconectado");
  assert.equal(disconnected.stateSince, disconnectedAt);
  f.advance();
  f.observe("idle");
  assert.equal((await f.equipment()).stateSince, disconnectedAt);
  f.workers[0].socketId = null;
  f.advance();
  assert.equal((await f.equipment()).stateSince, disconnectedAt);
  f.workers[0].socketId = "reconnected";
  f.workers[0].connected = true;
  f.advance();
  assert.equal((await f.equipment()).stateSince, null);
  assert.equal((await f.equipment()).calling, false);
  f.advance();
  f.observe("available");
  assert.equal((await f.equipment()).stateSince, null);
});

test("transitions between snapshots are retained and phones transition independently", async () => {
  const f = fixture();
  f.observe("idle");
  f.observe("idle", undefined, f.workers[1]);
  f.advance();
  f.observe("dialing", "fast");
  f.advance();
  f.observe("ringing", "fast");
  const answerAt = f.advance();
  f.observe("in_call", "other", f.workers[1]);
  f.advance();
  f.observe("in_call", "fast");
  const endAt = f.advance();
  f.observe("ended", "fast");
  f.advance();
  f.observe("available");
  assert.equal((await f.equipment()).stateSince, endAt);
  assert.equal((await f.equipment(2)).stateSince, answerAt);
});

test("first dialing/ringing reports stay unknown and replacement before a snapshot discards the old start", async () => {
  const f = fixture();
  f.observe("dialing", "unknown");
  f.advance();
  f.observe("ringing", "unknown");
  assert.equal((await f.equipment()).stateSince, null);
  f.advance();
  f.observe("in_call", "unknown");
  assert.equal((await f.equipment()).stateSince, f.at());
  f.workers[0].socketId = "new-socket";
  f.advance();
  f.observe("in_call", "unknown");
  assert.equal((await f.equipment()).stateSince, null);
});

test("first idle reports do not invent a start from receipt time or historical linkage", async () => {
  const f = fixture();
  f.observe("idle");
  assert.equal((await f.equipment()).stateSince, null);
  f.advance();
  f.observe("available");
  assert.equal((await f.equipment()).stateSince, null);
});

test("a new attempt resets grouped ringing timing even if a terminal report was missed", async () => {
  const f = fixture();
  f.observe("idle");
  f.advance();
  f.observe("dialing", "first");
  f.advance();
  f.observe("ringing", "first");
  const nextAttemptAt = f.advance();
  f.observe("dialing", "second");
  f.advance();
  f.observe("ringing", "second");
  assert.equal((await f.equipment()).stateSince, nextAttemptAt);
});
