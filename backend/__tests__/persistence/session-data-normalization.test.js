import test from "node:test";
import assert from "node:assert/strict";
import { hydrateSessionData, SessionPersistence, splitSessionData } from "../../shared/persistence.js";

test("commits changed session fields and the call ledger without touching the legacy table", async () => {
  const queries = [];
  let rejectCommit = true;
  const connection = {
    async query(sql, values) {
      queries.push({ sql, values });
      return [[]];
    },
    async beginTransaction() {},
    async commit() {
      if (rejectCommit) throw new Error("simulated commit failure");
    },
    async rollback() {},
    release() {}
  };
  const storage = new SessionPersistence(undefined, {
    env: { DB_HOST: "unused", DB_USER: "unused", DB_NAME: "unused" }
  });
  storage.pool = { getConnection: async () => connection };
  storage.schemaReady = true;
  storage.sessionDataStorageEnabled = true;
  storage.sessionRowsStorageEnabled = true;
  storage.contactBookStorageEnabled = true;
  const session = {
    callState: "dialing",
    optional: "null",
    campaign: {
      contacts: [{ id: "c1", attemptHistory: [{ id: "a1", startedAt: "2026-11-24T15:00:00.000Z" }] }],
      history: []
    }
  };
  const sessions = new Map([["TEST01", session]]);

  await assert.rejects(storage.save(sessions, ["TEST01"]), /simulated commit failure/);
  assert.equal(storage.sessionStateCache.size, 0);
  rejectCommit = false;
  queries.length = 0;
  await storage.save(sessions, ["TEST01"]);
  assert.ok(queries.some(({ sql, values }) => sql.startsWith("INSERT INTO vc_call_attempts") && values[1] === "a1"));
  assert.ok(queries.some(({ sql, values }) => sql.startsWith("INSERT INTO vc_session_state") && values.includes('"null"')));

  queries.length = 0;
  session.callState = "ringing";
  delete session.optional;
  await storage.save(sessions, ["TEST01"]);
  assert.deepEqual(queries.map(({ values }) => values), [
    ["TEST01", "callState", '"ringing"'],
    ["TEST01", "optional"]
  ]);
  assert.ok(queries.every(({ sql }) => /^(INSERT INTO|DELETE FROM) vc_session_state/.test(sql)));
});

test("reconciles stale assignments on load so a restart does not boot blocked", () => {
  const storage = new SessionPersistence(undefined, {
    env: { DB_HOST: "unused", DB_USER: "unused", DB_NAME: "unused" }
  });
  const session = {
    campaign: {
      status: "running",
      assignments: {
        workerA: { workerId: "workerA", contactId: "c1", attemptId: "a1" },
        workerB: { workerId: "workerB", contactId: "c2", attemptId: "a2" }
      },
      activeContactId: "c1",
      activeWorkerId: "workerA",
      activeWorkerSocketId: "sockA",
      contacts: [
        { id: "c1", status: "in_call", attempts: 1, currentAttemptId: "a1", assignedWorkerId: "workerA",
          attemptHistory: [{ id: "a1", startedAt: "2026-11-24T15:00:00.000Z", endedAt: null }] },
        { id: "c2", status: "dialing", attempts: 2, currentAttemptId: "a2", assignedWorkerId: "workerB",
          attemptHistory: [{ id: "a0", startedAt: "2026-11-24T14:00:00.000Z", endedAt: "2026-11-24T14:01:00.000Z" },
            { id: "a2", startedAt: "2026-11-24T15:00:00.000Z", endedAt: null }] },
        { id: "c3", status: "pending", attempts: 0, attemptHistory: [] }
      ]
    },
    phoneWorkers: [{ id: "workerA", socketId: "sockA", connected: true, callState: "in_call" }]
  };

  const cleaned = storage.cleanSessionOnLoad(session);
  assert.deepEqual(cleaned.campaign.assignments, {});
  assert.equal(cleaned.campaign.activeContactId, null);
  assert.equal(cleaned.campaign.activeWorkerId, null);
  assert.equal(cleaned.campaign.activeWorkerSocketId, null);

  const [c1, c2, c3] = cleaned.campaign.contacts;
  assert.equal(c1.status, "pending");
  assert.equal(c1.attempts, 0);
  assert.equal(c1.currentAttemptId, "");
  assert.equal(c1.attemptHistory.length, 0);
  assert.equal(c2.status, "retry_pending");
  assert.equal(c2.attempts, 1);
  assert.equal(c2.attemptHistory.length, 1);
  assert.equal(c3.status, "pending");

  assert.equal(cleaned.phoneWorkers[0].connected, false);
  assert.equal(cleaned.phoneWorkers[0].callState, "idle");
});

test("normalizes large session collections into rows and rebuilds the original API shape", () => {
  const session = {
    dashboardSocketId: "socket-secret",
    workerCursor: 4,
    contactBook: { lists: [{ name: "Principal" }], contacts: [{ id: "book-1" }] },
    campaign: {
      status: "running", listName: "Principal", assignments: { worker: { contactId: "contact-1" } },
      contacts: [{ id: "contact-1", name: "Cliente", phone: "999111222", status: "ringing", attemptHistory: [
        { id: "attempt-1", startedAt: "2026-11-20T10:00:00.000Z" }
      ] }],
      history: [{ attemptId: "attempt-1", contactId: "contact-1", phone: "999111222" }]
    },
    shiftManagement: {
      current: { id: "shift-current", label: "MAÑANA" }, pendingContacts: [{ id: "pending-1", phone: "999111222" }],
      currentReport: [{ attemptId: "attempt-1" }], closedContacts: [], sessionHistory: [{ id: "session-1" }],
      history: [{ id: "shift-1", report: [{ attemptId: "attempt-1" }], unfinishedContacts: [{ id: "contact-1" }] }]
    },
    reportArchive: [{
      id: "archive-1", date: "2026-11-20", rubro: "Principal",
      contacts: [{ id: "contact-1", phone: "999111222" }],
      history: [{ attemptId: "attempt-1", phone: "999111222" }]
    }]
  };

  const { data, rows } = splitSessionData(session);
  assert.equal(data.campaign.contacts, undefined);
  assert.equal(data.shiftManagement.history, undefined);
  assert.deepEqual(data.reportArchive, []);
  assert.equal(data.contactBook, undefined);
  assert.equal(rows.some(row => row.type === "archive_attempt"), true);

  const databaseRows = rows.map(row => ({
    entity_type: row.type, entity_id: row.id, position: row.position, row_data: row.value
  }));
  const hydrated = hydrateSessionData(data, databaseRows);
  const expected = structuredClone(session);
  delete expected.dashboardSocketId;
  delete expected.workerCursor;
  delete expected.contactBook;
  assert.deepEqual(hydrated, expected);
});

test("reuses immutable shift-history rows when preparing ordinary session saves", () => {
  const session = {
    shiftManagement: {
      current: { id: "current" }, pendingContacts: [], currentReport: [], closedContacts: [], sessionHistory: [],
      history: [
        { id: "shift-1", report: [{ attemptId: "a1" }], unfinishedContacts: [{ id: "c1" }, { id: "c2" }] },
        { id: "shift-2", report: [{ attemptId: "a2" }], unfinishedContacts: [{ id: "c3" }] }
      ]
    },
    campaign: { status: "running", contacts: [{ id: "c1", name: "Updated in memory", attemptHistory: [] }], history: [] },
    reportArchive: []
  };
  const savedHistoryRows = splitSessionData(session).rows.filter(row => ["shift_history", "shift_report", "shift_unfinished"].includes(row.type));
  const nextSave = splitSessionData(session, { preserveShiftHistory: true });
  const rows = [
    ...nextSave.rows.map(row => ({ entity_type: row.type, entity_id: row.id, position: row.position, row_data: row.value })),
    ...savedHistoryRows.map(row => ({ entity_type: row.type, entity_id: row.id, position: row.position, row_data: row.value }))
  ];
  assert.equal(nextSave.rows.some(row => row.type === "shift_unfinished"), false);
  assert.deepEqual(hydrateSessionData(nextSave.data, rows), session);
});

test("lazy shift hydration keeps summary counts while moving unfinished contacts to on-demand rows", () => {
  const session = {
    shiftManagement: {
      current: null, pendingContacts: [], currentReport: [], closedContacts: [], sessionHistory: [],
      history: [{
        id: "turn-a", report: [{ attemptId: "attempt-a" }],
        unfinishedContacts: [{ id: "contact-a", name: "A" }, { id: "contact-b", name: "B" }]
      }]
    }
  };
  const split = splitSessionData(session, { lazyShiftDetails: true });
  const storedRows = split.rows.map(row => ({
    entity_type: row.type, entity_id: row.id, position: row.position, row_data: row.value
  }));
  const lazy = hydrateSessionData(split.data, storedRows, { lazyShiftDetails: true });

  assert.equal(split.shiftUnfinishedRows.length, 2);
  assert.equal(storedRows.some(row => row.entity_type === "shift_unfinished"), false);
  assert.equal(lazy.shiftManagement.history[0].unfinishedContactCount, 2);
  assert.deepEqual(lazy.shiftManagement.history[0].unfinishedContacts, []);
  assert.equal(lazy.shiftManagement.history[0]._unfinishedContactsLoaded, false);
  assert.deepEqual(lazy.shiftManagement.history[0].report, [{ attemptId: "attempt-a" }]);
  assert.equal(split.rows.find(row => row.type === "shift_history").value.unfinishedContactCount, 2);
});

test("does not rewrite unchanged shift-unfinished rows on repeated saves", async () => {
  const shiftInserts = [];
  const connection = {
    async query(sql, values) {
      if (sql.startsWith("INSERT INTO vc_shift_unfinished_contacts")) shiftInserts.push(values);
      return [[]];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {}
  };
  const storage = new SessionPersistence(undefined, {
    env: { DB_HOST: "unused", DB_USER: "unused", DB_NAME: "unused" }
  });
  storage.pool = { getConnection: async () => connection };
  storage.schemaReady = true;
  storage.sessionDataStorageEnabled = false;
  storage.sessionRowsStorageEnabled = false;
  storage.shiftDetailsStorageEnabled = true;

  const row = {
    shiftId: "shift-1", detailId: "c1", contactId: "c1", listName: "Principal",
    name: "Cliente", phone: "999111222", status: "pending", position: 0,
    contact: { id: "c1", name: "Cliente", phone: "999111222" }
  };
  const metrics = {
    shiftHistoryChanged: { S1: true },
    shiftUnfinishedContacts: { S1: [row] },
    shiftHistoryIds: { S1: ["shift-1"] }
  };
  const snapshot = { S1: { campaign: { contacts: [], history: [] } } };

  await storage.saveNow(snapshot, ["S1"], metrics);
  assert.equal(shiftInserts.length, 1);

  await storage.saveNow(snapshot, ["S1"], metrics);
  assert.equal(shiftInserts.length, 1);

  const changed = { ...row, status: "completed" };
  await storage.saveNow(snapshot, ["S1"], {
    shiftHistoryChanged: { S1: true },
    shiftUnfinishedContacts: { S1: [changed] },
    shiftHistoryIds: { S1: ["shift-1"] }
  });
  assert.equal(shiftInserts.length, 2);
});
