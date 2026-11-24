import test from "node:test";
import assert from "node:assert/strict";
import { createDispatcher } from "../../services/calls/dispatcher.js";

function buildRuntime(session) {
  const emitted = [];
  const runtime = {
    sessions: new Map([["SESS01", session]]),
    shuttingDown: false,
    io: { to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) }
  };
  const services = {
    saveSoon() {},
    emitState() {},
    emitCampaignState() {},
    allCallAttempts: () => [],
    annualBlocks: () => new Set(),
    globalBlockedNumbers: () => new Set(),
    getConnectedPhoneWorkers: () => []
  };
  return { runtime, services, emitted };
}

function contact(id, status, attempt, extra = {}) {
  return {
    id, name: `Contacto ${id}`, phone: "999111222", status,
    attempts: 1, currentAttemptId: attempt.id, assignedWorkerId: "workerA",
    attemptHistory: [attempt], result: "", technicalResult: "", ...extra
  };
}

test("watchdog force-finalizes dialing and in_call attempts that never reported a terminal state", () => {
  const now = Date.now();
  const session = {
    campaign: {
      status: "running", maxAttempts: 2,
      assignments: {
        workerA: { workerId: "workerA", contactId: "c1", attemptId: "a1" },
        workerB: { workerId: "workerB", contactId: "c2", attemptId: "a2" },
        workerC: { workerId: "workerC", contactId: "c3", attemptId: "a3" },
        workerD: { workerId: "workerD", contactId: "c4", attemptId: "a4" }
      },
      contacts: [
        contact("c1", "in_call", { id: "a1", startedAt: new Date(now - 20 * 60000).toISOString(), answeredAt: new Date(now - 16 * 60000).toISOString() }),
        contact("c2", "dialing", { id: "a2", startedAt: new Date(now - 50000).toISOString() }),
        contact("c3", "in_call", { id: "a3", startedAt: new Date(now - 60000).toISOString(), answeredAt: new Date(now - 30000).toISOString() }, { assignedWorkerId: "workerC" }),
        contact("c4", "in_call", { id: "a4", startedAt: new Date(now - 20 * 60000).toISOString(), answeredAt: new Date(now - 18 * 60000).toISOString() }, { assignedWorkerId: "workerD" })
      ]
    },
    phoneWorkers: [{ id: "workerD", connected: true, socketId: "sockD", callState: "in_call", lastStatusAt: now - 5000 }]
  };
  session.campaign.contacts[0].assignedWorkerId = "workerA";
  session.campaign.contacts[1].assignedWorkerId = "workerB";

  const { runtime, services } = buildRuntime(session);
  const dispatcher = createDispatcher(runtime, services);
  dispatcher.scanStuckCalls();

  const campaign = session.campaign;
  assert.equal(campaign.assignments.workerA, undefined, "in_call timeout must release workerA");
  assert.equal(campaign.assignments.workerB, undefined, "dialing timeout must release workerB");
  assert.ok(campaign.assignments.workerC, "recent in_call must keep workerC assigned");
  assert.ok(campaign.assignments.workerD, "in_call with recent heartbeat must keep workerD assigned");
  assert.equal(campaign.contacts.find(c => c.id === "c3").status, "in_call");
  assert.equal(campaign.contacts.find(c => c.id === "c4").status, "in_call");

  const c1 = campaign.contacts.find(c => c.id === "c1");
  const c2 = campaign.contacts.find(c => c.id === "c2");
  assert.ok(["retry_pending", "failed"].includes(c1.status));
  assert.ok(["retry_pending", "failed"].includes(c2.status));
  assert.ok(c1.attemptHistory[0].endedAt, "stuck attempt must be closed");
});

test("watchdog ignores assignments when the campaign is not running", () => {
  const now = Date.now();
  const session = {
    campaign: {
      status: "paused", maxAttempts: 2,
      assignments: { workerA: { workerId: "workerA", contactId: "c1", attemptId: "a1" } },
      contacts: [contact("c1", "in_call", { id: "a1", startedAt: new Date(now - 20 * 60000).toISOString(), answeredAt: new Date(now - 16 * 60000).toISOString() })]
    }
  };
  const { runtime, services } = buildRuntime(session);
  createDispatcher(runtime, services).scanStuckCalls();
  assert.ok(session.campaign.assignments.workerA, "paused campaign must not be touched");
});