import test from "node:test";
import assert from "node:assert/strict";
import { registerCallEvents } from "../../sockets/call-events.js";
import { CallHistoryGate } from "../../services/calls/call-history-gate.js";
import { startCampaign, assignNextContact } from "../../services/campaigns/campaign-manager.js";

function setup(save = async () => {}) {
  const worker = { id: "device-1", socketId: "socket-1", connected: true, callState: "idle" };
  const session = { phoneWorkers: [worker] };
  const sessions = new Map([["TEST", session]]);
  const handlers = new Map(), receipts = [], states = [];
  let writes = 0;
  const persistence = { markSessionDirty() {}, hasFinishedAttempt: () => false,
    save: async (...args) => { writes++; await save(...args); } };
  const historyGate = new CallHistoryGate(persistence, () => sessions);
  const runtime = { sessions, historyGate, persistence, network: { observe() {}, notifyChanged() {} } };
  const socket = { id: "socket-1", data: { role: "phone", code: "TEST" },
    on: (name, handler) => handlers.set(name, handler), emit: (event, data) => receipts.push({ event, data }) };
  const services = { getPhoneWorkerBySocketId: (session, socketId) => session.phoneWorkers.find(w => w.socketId === socketId), syncSessionPhoneState() {},
    emitState: () => states.push({ state: worker.callState, speakerOn: worker.speakerOn }),
    emitCampaignState() {}, dispatchCampaignCalls() {} };
  registerCallEvents(runtime, services, socket);
  const send = async payload => {
    handlers.get("phone:status")({ statusSessionId: "process-1", ...payload });
    await historyGate.queues.get("TEST");
  };
  return { worker, session, socket, receipts, states, send, handlers, historyGate, runtime, services, writes: () => writes };
}

test("two phones in the same account can both report idle without a call ID", async () => {
  const s = setup();
  const worker2 = { id: "device-2", socketId: "socket-2", connected: true, callState: "ringing" };
  s.session.phoneWorkers.push(worker2);
  const handlers2 = new Map();
  const socket2 = { id: "socket-2", data: { role: "phone", code: "TEST" }, on: (name, fn) => handlers2.set(name, fn), emit() {} };
  registerCallEvents(s.runtime, s.services, socket2);
  await s.send({ callState: "idle", statusSequence: 1 });
  handlers2.get("phone:status")({ callState: "idle", statusSessionId: "process-2", statusSequence: 1 });
  await s.historyGate.queues.get("TEST");
  assert.equal(worker2.callState, "idle");
  assert.equal(s.writes(), 2);
});

test("same physical state accepts new speaker and terminal information", async () => {
  const s = setup();
  await s.send({ callState: "idle", statusSequence: 1, speakerOn: false });
  await s.send({ callState: "idle", statusSequence: 2, speakerOn: true, terminalConfirmed: true });
  assert.equal(s.worker.speakerOn, true);
  assert.equal(s.worker.terminalConfirmed, true);
  assert.equal(s.writes(), 2);
});

test("legacy APK packets without a sequence are not discarded by call state", async () => {
  const s = setup();
  await s.send({ callState: "idle", speakerOn: false });
  await s.send({ callState: "idle", speakerOn: true });
  assert.equal(s.worker.speakerOn, true);
});

test("out-of-order sequence does not roll the phone back to an earlier state", async () => {
  const s = setup();
  await s.send({ callState: "in_call", statusSequence: 3 });
  await s.send({ callState: "idle", statusSequence: 2 });
  assert.equal(s.worker.callState, "in_call");
  assert.equal(s.writes(), 1);
  assert.equal(s.receipts.at(-1).data.reason, "stale_sequence");
});

test("a late packet for another attempt cannot overwrite the current worker", async () => {
  const s = setup();
  startCampaign(s.session, [{ id: "contact", phone: "900000001" }]);
  assignNextContact(s.session, s.worker);
  s.worker.callState = "in_call";
  await s.send({ callState: "ended", callId: "old-attempt", contactId: "contact", statusSequence: 1 });
  assert.equal(s.worker.callState, "in_call");
  assert.equal(s.writes(), 0);
  assert.equal(s.receipts.at(-1).data.reason, "stale_call");
});

test("terminal confirmation after idle is accepted and duplicate ACK keeps correlation", async () => {
  const s = setup();
  startCampaign(s.session, [{ id: "contact", phone: "900000001" }], { maxAttempts: 1 });
  const active = assignNextContact(s.session, s.worker);
  const payload = { callState: "idle", contactId: active.id, callId: active.currentAttemptId, commandId: "cmd" };
  await s.send({ ...payload, terminalConfirmed: false, statusSequence: 1 });
  assert.equal(s.receipts.at(-1).data.terminal, false);
  assert.equal(s.worker.callState, "dialing", "an unconfirmed transient idle must not show the assigned phone as available");
  await s.send({ ...payload, terminalConfirmed: true, statusSequence: 2 });
  const receipt = s.receipts.at(-1).data;
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.terminal, true);
  await s.send({ ...payload, terminalConfirmed: true, statusSequence: 2 });
  assert.deepEqual(s.receipts.at(-1).data, { ...receipt, duplicate: true });
  assert.equal(s.writes(), 2);
});

test("observed state is published before MySQL, successful receipt waits for commit", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const s = setup(() => pending);
  s.handlers.get("phone:status")({ callState: "in_call", statusSessionId: "p", statusSequence: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.states[0].state, "in_call");
  assert.equal(s.receipts.length, 0);
  finish();
  await s.historyGate.queues.get("TEST");
  assert.equal(s.receipts.at(-1).data.persisted, true);
});

test("failed save does not mark packet committed and its retry can persist", async () => {
  let fail = true;
  const s = setup(async () => { if (fail) throw new Error("mysql unavailable"); });
  const packet = { callState: "idle", statusSequence: 1 };
  s.handlers.get("phone:status")({ ...packet, statusSessionId: "process-1" });
  await assert.rejects(s.historyGate.queues.get("TEST"));
  assert.equal(s.socket.data.committedPhoneStatus, undefined);
  assert.equal(s.receipts.at(-1).data.persisted, false);
  fail = false;
  await s.send(packet);
  assert.equal(s.receipts.at(-1).data.persisted, true);
  assert.equal(s.writes(), 2);
});
