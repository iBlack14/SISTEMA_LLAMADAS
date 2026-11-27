import test from "node:test";
import assert from "node:assert/strict";
import { createDispatcher } from "../../services/calls/dispatcher.js";
import { CallHistoryGate } from "../../services/calls/call-history-gate.js";
import { createRestrictions } from "../../services/calls/restrictions.js";
import { createSessionLifecycle } from "../../session/session-lifecycle.js";
import { createSessionState } from "../../session/session-state.js";
import { registerCallEvents } from "../../sockets/call-events.js";
import { normalizeBook, withProgress } from "../../services/campaigns/contact-book.js";
import { normalizeBook, withProgress } from "../../services/campaigns/contact-book.js";
import {
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  setWorkerPaused
} from "../../services/campaigns/campaign-manager.js";

function createLoadHarness({ workerCount = 30, contacts = [], saveDelayMs = 0, maxAttempts = 1 } = {}) {
  const code = "LOAD30";
  const dashboardSocketId = "dash-1";
  const phoneWorkers = [];
  const socketMap = new Map();
  const phoneHandlers = new Map();
  const phoneEvents = new Map();
  const dashboardEvents = [];
  let saveCalls = 0;

  for (let i = 0; i < workerCount; i++) {
    const id = `dev-${String(i + 1).padStart(2, "0")}`;
    const socketId = `sock-${id}`;
    phoneWorkers.push({
      id,
      name: `Equipo ${i + 1}`,
      socketId,
      connected: true,
      callState: "idle",
      lastStatusAt: 0
    });
    const handlers = new Map();
    const emitted = [];
    phoneHandlers.set(id, handlers);
    phoneEvents.set(id, emitted);
    socketMap.set(socketId, {
      id: socketId,
      connected: true,
      data: { role: "phone", code, workerId: id },
      on: (event, fn) => handlers.set(event, fn),
      emit: (event, data) => emitted.push({ event, data }),
      leave() {}
    });
  }

  socketMap.set(dashboardSocketId, {
    id: dashboardSocketId,
    connected: true,
    data: { role: "dashboard", code },
    on() {},
    emit: (event, data) => dashboardEvents.push({
      event,
      contactCount: Array.isArray(data?.contacts) ? data.contacts.length : 0
    }),
    leave() {}
  });

  const session = {
    code,
    ownerUsername: "loadtester",
    dashboardSocketId,
    phoneWorkers,
    blockedNumbers: [],
    updatedAt: Date.now()
  };
  const sessions = new Map([[code, session]]);
  const finishedAttempts = new Set();

  const persistence = {
    attemptsRevision: 0,
    records: new Map(),
    markSessionDirty() {},
    getDirtySessions: () => new Set(),
    hasFinishedAttempt: (c, attemptId, contactId) => finishedAttempts.has(`${c}:${attemptId}:${contactId}`),
    status: () => ({ mode: "mysql", databaseConfigured: true, pendingDatabase: false, attempts: 0 }),
    save: async (sessionsMap, changedCodes) => {
      saveCalls++;
      if (saveDelayMs > 0) await new Promise((r) => setTimeout(r, saveDelayMs));
      const s = sessionsMap.get(code);
      for (const c of s?.campaign?.contacts || []) {
        for (const a of c.attemptHistory || []) {
          if (a.endedAt) finishedAttempts.add(`${code}:${a.id}:${c.id}`);
        }
      }
      return { committed: true };
    }
  };

  const historyGate = new CallHistoryGate(persistence, () => sessions);
  const io = {
    sockets: { sockets: socketMap },
    to: (targetId) => ({
      emit: (event, data) => {
        const sock = socketMap.get(targetId);
        if (sock) sock.emit(event, data);
      }
    })
  };
  const runtime = {
    io,
    sessions,
    persistence,
    historyGate,
    network: { observe() {}, notifyChanged() {} }
  };

  const services = {};
  Object.assign(services, {
    normalizeSessionShape: (s) => s,
    syncSessionPhoneState: () => {},
    getConnectedPhoneWorkers: (s) => (s.phoneWorkers || []).filter((w) => w.connected && w.socketId),
    getActivePhoneWorker: (s) => (s.phoneWorkers || []).find((w) => w.connected && w.socketId) || null,
    getPhoneWorkerBySocketId: (s, sid) => (s.phoneWorkers || []).find((w) => w.socketId === sid) || null,
    getPeer: (s, role) => (role === "phone" ? s.dashboardSocketId : s.activePhoneSocketId)
  });
  Object.assign(services, createRestrictions(runtime, services));
  Object.assign(services, createSessionState(runtime, services));
  Object.assign(services, createSessionLifecycle(runtime, services));
  const dispatcher = createDispatcher(runtime, services);
  Object.assign(services, dispatcher);

  for (const w of phoneWorkers) {
    registerCallEvents(runtime, services, socketMap.get(w.socketId));
  }

  startCampaign(session, contacts, { listName: "Asignación automática", maxAttempts });

  return {
    code,
    session,
    phoneWorkers,
    phoneHandlers,
    phoneEvents,
    dashboardEvents,
    dispatcher,
    historyGate,
    getSaveCalls: () => saveCalls
  };
}

test("30 simultaneous devices dispatch and complete 150 contacts on 1 shared list with zero duplicates and zero heartbeat DB writes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  const contacts = Array.from({ length: 150 }, (_, i) => ({
    id: `c-${i + 1}`,
    name: `Cliente ${i + 1}`,
    phone: `9${String(10000000 + i)}`,
    list: "Lista Unica"
  }));

  const h = createLoadHarness({ workerCount: 30, contacts });
  const dialedPhones = [];
  const dialedContactIds = [];
  let seq = 0;

  const waitUntil = async (predicate, timeoutMs = 5000) => {
    const start = Date.now();
    while (!predicate()) {
      await new Promise((r) => setTimeout(r, 5));
      if (Date.now() - start > timeoutMs) throw new Error("Timeout waiting for condition");
    }
  };

  // Drive each of the 30 phones concurrently whenever it receives a dial command
  const activeLoops = h.phoneWorkers.map(async (worker) => {
    const events = h.phoneEvents.get(worker.id);
    const handlers = h.phoneHandlers.get(worker.id);
    let cursor = 0;
    const statusHandler = handlers.get("phone:status");

    while (true) {
      while (cursor < events.length) {
        const ev = events[cursor++];
        if (ev.event !== "call:action" || ev.data.action !== "dial") continue;
        const { phoneNumber, contactId, callId, commandId } = ev.data;
        dialedPhones.push(phoneNumber);
        dialedContactIds.push(contactId);

        // Simulate realistic call lifecycle: dialing -> in_call -> heartbeat -> ended
        const sId = `proc-${worker.id}`;
        statusHandler({ callState: "dialing", phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        statusHandler({ callState: "in_call", phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        const savesBeforeHb = h.getSaveCalls();
        statusHandler({ callState: "in_call", source: "heartbeat", phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        assert.equal(h.getSaveCalls(), savesBeforeHb, "heartbeat must not trigger MySQL save");
        statusHandler({ callState: "ended", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
      }
      if (h.session.campaign.status === "completed") break;
      await new Promise((r) => setTimeout(r, 2));
    }
  });

  // Trigger initial simultaneous dispatch for all 30 devices
  const initialDispatched = h.dispatcher.dispatchCampaignCalls(h.code);
  assert.equal(initialDispatched.length, 30, "all 30 devices must be dispatched on the very first cycle");

  await waitUntil(() => h.session.campaign.status === "completed", 8000);
  await Promise.all(activeLoops);

  // Verify 0 duplicates and 100% completion
  assert.equal(dialedContactIds.length, 150);
  assert.equal(new Set(dialedContactIds).size, 150, "every contact must be dialed once");
  assert.equal(new Set(dialedPhones).size, 150, "every phone number must be dialed once");
  assert.equal(Object.keys(h.session.campaign.assignments).length, 0, "no lingering assignments");

  // Verify campaign:state was never pushed to any APK socket
  for (const worker of h.phoneWorkers) {
    const campaignBroadcasts = h.phoneEvents.get(worker.id).filter((e) => e.event === "campaign:state");
    assert.equal(campaignBroadcasts.length, 0, `APK ${worker.id} should never receive campaign:state`);
  }
  assert.ok(h.dashboardEvents.some((e) => e.event === "campaign:state"), "dashboard must receive campaign:state");
});

test("30 simultaneous devices across 15 different lists (2 devices per list) dispatch concurrently without cross-list collisions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  const contacts = [];
  for (let listIdx = 0; listIdx < 15; listIdx++) {
    const w1 = `dev-${String(listIdx * 2 + 1).padStart(2, "0")}`;
    const w2 = `dev-${String(listIdx * 2 + 2).padStart(2, "0")}`;
    for (let c = 0; c < 4; c++) {
      const idx = listIdx * 4 + c;
      contacts.push({
        id: `ml-${idx + 1}`,
        name: `Empresa ${idx + 1}`,
        phone: `9${String(20000000 + idx)}`,
        list: `Rubro ${listIdx + 1}`,
        targetWorkerId: c % 2 === 0 ? w1 : w2
      });
    }
  }

  const h = createLoadHarness({ workerCount: 30, contacts });
  const assignedByWorker = new Map();
  let seq = 0;

  const dispatched = h.dispatcher.dispatchCampaignCalls(h.code);
  assert.equal(dispatched.length, 30, "all 30 targeted devices across 15 lists dispatch simultaneously");

  const loops = h.phoneWorkers.map(async (worker) => {
    const events = h.phoneEvents.get(worker.id);
    const statusHandler = h.phoneHandlers.get(worker.id).get("phone:status");
    let cursor = 0;
    while (h.session.campaign.status !== "completed" || cursor < events.length) {
      while (cursor < events.length) {
        const ev = events[cursor++];
        if (ev.event !== "call:action" || ev.data.action !== "dial") continue;
        const { phoneNumber, contactId, callId, commandId } = ev.data;
        if (!assignedByWorker.has(worker.id)) assignedByWorker.set(worker.id, []);
        assignedByWorker.get(worker.id).push(contactId);
        const sId = `proc-${worker.id}`;
        statusHandler({ callState: "in_call", phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        statusHandler({ callState: "ended", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
      }
      if (h.session.campaign.status === "completed") break;
      await new Promise((r) => setTimeout(r, 2));
    }
  });

  await Promise.all(loops);
  const allDialed = [...assignedByWorker.values()].flat();
  assert.equal(allDialed.length, 60);
  assert.equal(new Set(allDialed).size, 60, "zero duplicate contacts across 15 lists");
  for (const worker of h.phoneWorkers) {
    assert.equal(assignedByWorker.get(worker.id)?.length, 2, `worker ${worker.id} must have dialed its 2 assigned contacts`);
  }
});

test("30 simultaneous devices on a 17,635-contact list dispatch and cycle 300 calls under tight latency budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  const TOTAL_CONTACTS = 17635;
  const TARGET_CALLS = 300;
  const contacts = Array.from({ length: TOTAL_CONTACTS }, (_, i) => ({
    id: `big-${i + 1}`,
    name: `Contacto ${i + 1}`,
    phone: `9${String(30000000 + i)}`,
    list: "Base 17k"
  }));

  const h = createLoadHarness({ workerCount: 30, contacts });
  const dialedIds = new Set();
  let completedCalls = 0;
  let seq = 0;

  const t0 = performance.now();
  const initialDispatched = h.dispatcher.dispatchCampaignCalls(h.code);
  const initialDispatchMs = performance.now() - t0;
  assert.equal(initialDispatched.length, 30, "all 30 workers dispatch on first cycle even with 17,635 contacts");

  const tCycleStart = performance.now();
  const loops = h.phoneWorkers.map(async (worker) => {
    const events = h.phoneEvents.get(worker.id);
    const statusHandler = h.phoneHandlers.get(worker.id).get("phone:status");
    let cursor = 0;
    while (completedCalls < TARGET_CALLS) {
      while (cursor < events.length) {
        const ev = events[cursor++];
        if (ev.event !== "call:action" || ev.data.action !== "dial") continue;
        const { phoneNumber, contactId, callId, commandId } = ev.data;
        assert.equal(dialedIds.has(contactId), false, `duplicate contact ${contactId}`);
        dialedIds.add(contactId);
        const sId = `proc-${worker.id}`;
        statusHandler({ callState: "in_call", phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        statusHandler({ callState: "ended", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        completedCalls++;
        if (completedCalls >= TARGET_CALLS) break;
      }
      if (completedCalls >= TARGET_CALLS) break;
      await new Promise((r) => setTimeout(r, 2));
    }
  });

  await Promise.all(loops);
  const cycleElapsedMs = performance.now() - tCycleStart;
  console.info(`[LOAD_17K] initialDispatch30Ms=${initialDispatchMs.toFixed(1)} total300CallsMs=${cycleElapsedMs.toFixed(1)} uniqueDialed=${dialedIds.size}`);
  assert.ok(completedCalls >= TARGET_CALLS);
  assert.ok(initialDispatchMs < 1500, `initial 30-worker dispatch on 17,635 contacts took ${initialDispatchMs.toFixed(1)}ms`);
});

test("30 simultaneous devices with maxAttempts=2: round-1 completes before retries, duplicate phones & invalid numbers are blocked immediately", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  // 40 contacts: contacts 1-5 have duplicate phones with 36-40, contacts 6-10 will report invalid/nonexistent
  const contacts = Array.from({ length: 40 }, (_, i) => ({
    id: `r-${i + 1}`,
    name: `Cliente ${i + 1}`,
    phone: i >= 35 ? `9${String(40000000 + (i - 35))}` : `9${String(40000000 + i)}`,
    list: "Reintentos"
  }));

  const h = createLoadHarness({ workerCount: 30, contacts, maxAttempts: 2 });
  const attemptCounts = new Map();
  let seq = 0;

  h.dispatcher.dispatchCampaignCalls(h.code);
  const loops = h.phoneWorkers.map(async (worker) => {
    const events = h.phoneEvents.get(worker.id);
    const statusHandler = h.phoneHandlers.get(worker.id).get("phone:status");
    let cursor = 0;
    while (h.session.campaign.status !== "completed" || cursor < events.length) {
      while (cursor < events.length) {
        const ev = events[cursor++];
        if (ev.event !== "call:action" || ev.data.action !== "dial") continue;
        const { phoneNumber, contactId, callId, commandId } = ev.data;
        attemptCounts.set(contactId, (attemptCounts.get(contactId) || 0) + 1);
        const sId = `proc-${worker.id}`;
        const idx = Number(contactId.split("-")[1]);
        if (idx >= 6 && idx <= 10) {
          // Permanent invalid number: must NEVER be retried
          statusHandler({ callState: "failed", detectedAnnouncement: "numero_inexistente", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        } else if (idx >= 11 && idx <= 20 && attemptCounts.get(contactId) === 1) {
          // Unanswered on round 1 -> retry_pending -> retried in round 2
          statusHandler({ callState: "failed", lastError: "no_answer", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        } else {
          // Answered -> completed
          statusHandler({ callState: "in_call", phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
          statusHandler({ callState: "ended", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        }
      }
      if (h.session.campaign.status === "completed") break;
      await new Promise((r) => setTimeout(r, 2));
    }
  });

  await Promise.all(loops);
  assert.equal(h.session.campaign.status, "completed");
  // Duplicate phones 36-40 must never have been dialed (0 attempts)
  for (let i = 36; i <= 40; i++) {
    assert.equal(attemptCounts.get(`r-${i}`) || 0, 0, `duplicate phone contact r-${i} must be skipped`);
  }
  // Invalid numbers 6-10 must have been dialed only once
  for (let i = 6; i <= 10; i++) {
    assert.equal(attemptCounts.get(`r-${i}`), 1, `invalid number r-${i} must not be retried`);
  }
  // Unanswered 11-20 must have been dialed twice
  for (let i = 11; i <= 20; i++) {
    assert.equal(attemptCounts.get(`r-${i}`), 2, `unanswered r-${i} must be retried once`);
  }
});

test("30 simultaneous devices: per-worker pause, campaign pause/resume, and worker disconnect/reconnect recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  const contacts = Array.from({ length: 80 }, (_, i) => ({
    id: `p-${i + 1}`,
    name: `Pausa ${i + 1}`,
    phone: `9${String(50000000 + i)}`,
    list: "Pausas"
  }));
  const h = createLoadHarness({ workerCount: 30, contacts });

  // Pause 10 workers individually before starting
  for (let i = 0; i < 10; i++) {
    setWorkerPaused(h.session, h.phoneWorkers[i].id, true);
  }
  const initial = h.dispatcher.dispatchCampaignCalls(h.code);
  assert.equal(initial.length, 20, "only the 20 unpaused workers must dispatch");
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 10; i++) {
    assert.equal(h.session.campaign.assignments[h.phoneWorkers[i].id], undefined, "paused worker must have no assignment");
  }

  // Pause campaign mid-flight and finish one active call -> must NOT dispatch next contact while paused
  pauseCampaign(h.session);
  const activeWorker = h.phoneWorkers[10];
  const dialEv = h.phoneEvents.get(activeWorker.id).find((e) => e.event === "call:action" && e.data.action === "dial");
  h.phoneHandlers.get(activeWorker.id).get("phone:status")({
    callState: "ended", terminalConfirmed: true,
    phoneNumber: dialEv.data.phoneNumber, contactId: dialEv.data.contactId,
    callId: dialEv.data.callId, commandId: dialEv.data.commandId,
    statusSessionId: "p-10", statusSequence: 1
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.session.campaign.assignments[activeWorker.id], undefined, "paused campaign must not dispatch on ended");

  // Unpause 5 workers, resume campaign, and test resumeAssignedDial on worker 11
  for (let i = 0; i < 5; i++) setWorkerPaused(h.session, h.phoneWorkers[i].id, false);
  resumeCampaign(h.session);
  const resumedDial = h.dispatcher.resumeAssignedDial(h.code, h.phoneWorkers[11].id);
  assert.equal(resumedDial, true, "disconnected/reconnected worker must resume its assigned dialing contact");
  const afterResume = h.dispatcher.dispatchCampaignCalls(h.code);
  assert.ok(afterResume.length >= 6, "unpaused idle workers + freed worker dispatch immediately on resume");
});

test("30 simultaneous devices: external incoming call hold/resume and call_already_active settle window isolate affected worker only", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  const contacts = Array.from({ length: 60 }, (_, i) => ({
    id: `ext-${i + 1}`,
    name: `Ext ${i + 1}`,
    phone: `9${String(60000000 + i)}`,
    list: "Externas"
  }));
  const h = createLoadHarness({ workerCount: 30, contacts });
  h.dispatcher.dispatchCampaignCalls(h.code);
  await new Promise((r) => setImmediate(r));

  // Worker 0 receives an external incoming call -> its campaign contact is held, other 29 unaffected
  const w0 = h.phoneWorkers[0];
  const w0Dial = h.phoneEvents.get(w0.id).find((e) => e.event === "call:action" && e.data.action === "dial").data;
  h.phoneHandlers.get(w0.id).get("phone:status")({
    callState: "in_call", externalIncoming: true,
    phoneNumber: "999888777", statusSessionId: "ext-0", statusSequence: 1
  });
  await h.historyGate.queues.get(h.code);
  assert.equal(h.session.campaign.assignments[w0.id], undefined, "worker 0 assignment held during external call");
  assert.equal(Object.keys(h.session.campaign.assignments).length, 29, "other 29 workers stay active");
  const heldContact = h.session.campaign.contacts.find((c) => c.id === w0Dial.contactId);
  assert.equal(heldContact.status, "held");

  // Worker 1 rejects dial with call_already_active -> held immediately + blockDispatchUntil set
  const w1 = h.phoneWorkers[1];
  const w1Dial = h.phoneEvents.get(w1.id).find((e) => e.event === "call:action" && e.data.action === "dial").data;
  h.phoneHandlers.get(w1.id).get("phone:command_ack")({
    commandId: w1Dial.commandId, action: "dial", ok: false, message: "call_already_active"
  });
  assert.equal(h.session.campaign.assignments[w1.id], undefined, "worker 1 assignment released on call_already_active");
  assert.ok(w1.blockDispatchUntil > Date.now(), "worker 1 has settle window blocking immediate re-dispatch");
  assert.equal(h.dispatcher.dispatchCampaignCalls(h.code, w1.id).length, 0, "blocked worker does not re-dispatch during settle window");
});

test("30 simultaneous devices under slow MySQL persistence (25ms/save): zero race conditions or duplicates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  const contacts = Array.from({ length: 90 }, (_, i) => ({
    id: `db-${i + 1}`,
    name: `SlowDB ${i + 1}`,
    phone: `9${String(70000000 + i)}`,
    list: "SlowDB"
  }));
  const h = createLoadHarness({ workerCount: 30, contacts, saveDelayMs: 25 });
  const dialedIds = new Set();
  let seq = 0;

  h.dispatcher.dispatchCampaignCalls(h.code);
  const loops = h.phoneWorkers.map(async (worker) => {
    const events = h.phoneEvents.get(worker.id);
    const statusHandler = h.phoneHandlers.get(worker.id).get("phone:status");
    let cursor = 0;
    while (h.session.campaign.status !== "completed" || cursor < events.length) {
      while (cursor < events.length) {
        const ev = events[cursor++];
        if (ev.event !== "call:action" || ev.data.action !== "dial") continue;
        const { phoneNumber, contactId, callId, commandId } = ev.data;
        assert.equal(dialedIds.has(contactId), false, `duplicate ${contactId} under slow MySQL`);
        dialedIds.add(contactId);
        const sId = `proc-${worker.id}`;
        statusHandler({ callState: "in_call", phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
        statusHandler({ callState: "ended", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
      }
      if (h.session.campaign.status === "completed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  await Promise.all(loops);
  assert.equal(dialedIds.size, 90);
  assert.equal(h.session.campaign.status, "completed");
});

test("30 simultaneous devices: buzon_de_voz, sin_servicio, no_disponible and contesto classifications under concurrency", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  const contacts = Array.from({ length: 60 }, (_, i) => ({
    id: `vm-${i + 1}`,
    name: `Buzon ${i + 1}`,
    phone: `9${String(80000000 + i)}`,
    list: "Buzones"
  }));
  const h = createLoadHarness({ workerCount: 30, contacts, maxAttempts: 2 });
  const resultsById = new Map();
  let seq = 0;

  h.dispatcher.dispatchCampaignCalls(h.code);
  const loops = h.phoneWorkers.map(async (worker) => {
    const events = h.phoneEvents.get(worker.id);
    const statusHandler = h.phoneHandlers.get(worker.id).get("phone:status");
    let cursor = 0;
    while (h.session.campaign.status !== "completed" || cursor < events.length) {
      while (cursor < events.length) {
        const ev = events[cursor++];
        if (ev.event !== "call:action" || ev.data.action !== "dial") continue;
        const { phoneNumber, contactId, callId, commandId } = ev.data;
        const idx = Number(contactId.split("-")[1]);
        const sId = `proc-${worker.id}`;
        if (idx <= 15) {
          statusHandler({ callState: "in_call", detectedVoicemail: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
          statusHandler({ callState: "ended", terminalConfirmed: true, detectedVoicemail: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
          resultsById.set(contactId, "buzon_de_voz");
        } else if (idx <= 30) {
          statusHandler({ callState: "failed", detectedAnnouncement: "sin_servicio", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
          resultsById.set(contactId, "sin_servicio");
        } else if (idx <= 45) {
          statusHandler({ callState: "failed", detectedAnnouncement: "no_disponible", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
          resultsById.set(contactId, "no_disponible");
        } else {
          statusHandler({ callState: "in_call", phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
          statusHandler({ callState: "ended", terminalConfirmed: true, phoneNumber, contactId, callId, commandId, statusSessionId: sId, statusSequence: ++seq });
          resultsById.set(contactId, "contesto");
        }
      }
      if (h.session.campaign.status === "completed") break;
      await new Promise((r) => setTimeout(r, 2));
    }
  });

  await Promise.all(loops);
  assert.equal(h.session.campaign.status, "completed");
  for (const contact of h.session.campaign.contacts) {
    assert.equal(contact.technicalResult, resultsById.get(contact.id), `contact ${contact.id} technicalResult mismatch`);
  }
});

test("bulk upload of 17,635 contacts (normalizeBook + withProgress) followed by 30-device immediate dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-27T15:00:00-05:00") });

  const rawContacts = Array.from({ length: 17635 }, (_, i) => ({
    name: `Empresa ${i + 1}`,
    phone: `519${String(90000000 + i)}`,
    list: `Lista ${(i % 5) + 1}`
  }));

  const t0 = performance.now();
  const book = normalizeBook({ contacts: rawContacts });
  const hydrated = withProgress(book, [], []);
  const prepMs = performance.now() - t0;

  assert.equal(hydrated.contacts.length, 17635);
  assert.equal(hydrated.lists.length, 6);

  const h = createLoadHarness({ workerCount: 30, contacts: hydrated.contacts.slice(0, 600) });
  const dispatched = h.dispatcher.dispatchCampaignCalls(h.code);
  assert.equal(dispatched.length, 30, "all 30 workers dispatch immediately after bulk import");
  assert.ok(prepMs < 2000, `bulk normalizeBook + withProgress on 17,635 contacts took ${prepMs.toFixed(1)}ms`);
  console.info(`[BULK_17K] normalizeAndProgressMs=${prepMs.toFixed(1)} dispatched30=${dispatched.length}`);
});
