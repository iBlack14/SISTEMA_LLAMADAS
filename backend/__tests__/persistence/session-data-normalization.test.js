import test from "node:test";
import assert from "node:assert/strict";
import { hydrateSessionData, splitSessionData } from "../../shared/persistence.js";

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
