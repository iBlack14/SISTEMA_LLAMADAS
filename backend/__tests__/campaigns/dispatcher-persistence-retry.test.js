import test from "node:test";
import assert from "node:assert/strict";
import { createDispatcher } from "../../services/calls/dispatcher.js";

function setup(save) {
  const code = "ABC123";
  const workerId = "device-1";
  const socketId = "socket-1";
  const payload = { action: "dial", commandId: "stable-command", callId: "attempt-1", contactId: "contact-1" };
  const sent = [];
  const errors = [];
  const workerSocket = { connected: true, emit: (event, data) => sent.push({ event, data }) };
  const session = {
    campaign: { assignments: { [workerId]: { workerId, attemptId: payload.callId, contactId: payload.contactId } } },
    phoneWorkers: [{ id: workerId, socketId, connected: true }]
  };
  const runtime = {
    sessions: new Map([[code, session]]),
    persistence: { save, hasFinishedAttempt: () => false },
    io: {
      sockets: { sockets: new Map([[socketId, workerSocket]]) },
      to: () => ({ emit: (event, data) => errors.push({ event, data }) })
    }
  };
  return { code, payload, runtime, sent, errors, session, dispatcher: createDispatcher(runtime, {}) };
}

test("a failed pre-dial save retries with backoff and emits only after a successful save", async () => {
  const pendingTimers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    pendingTimers.push({ callback, delay });
    return { unref() {} };
  };
  try {
    let saves = 0;
    const state = setup(async () => {
      saves += 1;
      if (saves < 3) throw new Error("temporary mysql failure");
      return { committed: true };
    });

    await state.dispatcher.sendPersistedDial(state.code, "socket-1", state.payload);
    assert.equal(state.sent.length, 0, "no call command is emitted before a durable save");
    assert.equal(state.errors.length, 1, "the UI receives one pending-save notice");
    assert.equal(pendingTimers[0].delay, 1000);

    await pendingTimers.shift().callback();
    assert.equal(state.sent.length, 0);
    assert.equal(pendingTimers[0].delay, 2000);

    await pendingTimers.shift().callback();
    assert.equal(saves, 3);
    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0].event, "call:action");
    assert.equal(state.sent[0].data.commandId, state.payload.commandId);
    assert.equal(state.sent[0].data.callId, state.payload.callId);
    assert.equal(pendingTimers.length, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("a persistence retry is cancelled if the assignment no longer belongs to the call", async () => {
  const pendingTimers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    pendingTimers.push({ callback, delay });
    return { unref() {} };
  };
  try {
    let saves = 0;
    const state = setup(async () => {
      saves += 1;
      throw new Error("temporary mysql failure");
    });
    await state.dispatcher.sendPersistedDial(state.code, "socket-1", state.payload);
    state.session.campaign.assignments = {};
    await pendingTimers.shift().callback();
    assert.equal(saves, 1);
    assert.equal(state.sent.length, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("a disconnected worker keeps the same reservation until it reconnects", async () => {
  const pendingTimers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    pendingTimers.push({ callback, delay });
    return { unref() {} };
  };
  try {
    const state = setup(async () => ({ committed: true }));
    state.session.phoneWorkers[0].connected = false;
    state.session.phoneWorkers[0].socketId = null;
    state.runtime.io.sockets.sockets.get("socket-1").connected = false;

    await state.dispatcher.sendPersistedDial(state.code, "socket-1", state.payload);
    assert.equal(state.sent.length, 0);
    assert.equal(pendingTimers[0].delay, 1000);

    pendingTimers.shift().callback();
    assert.equal(pendingTimers[0].delay, 2000);
    state.session.phoneWorkers[0].connected = true;
    state.session.phoneWorkers[0].socketId = "socket-1";
    state.runtime.io.sockets.sockets.get("socket-1").connected = true;
    pendingTimers.shift().callback();

    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0].event, "call:action");
    assert.equal(state.sent[0].data.commandId, state.payload.commandId);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
