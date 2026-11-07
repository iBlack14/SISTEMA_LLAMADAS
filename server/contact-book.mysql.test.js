import test from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { SessionPersistence } from "./persistence.js";
import { normalizeBook, withProgress, uncalledContacts } from "./contact-book.js";
import { randomUUID } from "node:crypto";

test("MySQL retains imported lists and call progress after restart and turn reset", {
  skip: process.env.TEST_MYSQL_HISTORY !== "1"
}, async () => {
  const code = "BOOKTEST" + randomUUID().replaceAll("-","").slice(0,12);
  const storage = new SessionPersistence();
  let reopened;
  try {
    await storage.load();
    const book = normalizeBook({lists:["Prueba aislada"],contacts:[
      {id:"sample",name:"Prueba",phone:"900000001",list:"Prueba aislada"}
    ],preferences:{pairingListAssignments:{slot:"Prueba aislada"}}});
    const attempt = {attemptId:"test-attempt",contactId:"sample",phone:"900000001",name:"Prueba",
      list:"Prueba aislada",startedAt:"2026-11-06T15:00:00Z",endedAt:"2026-11-06T15:00:10Z",
      durationSeconds:0,technicalResult:"buzon_de_voz"};
    const session = {contactBook:book,contactBookRevision:1,campaign:{history:[attempt]}};
    const sessions = new Map([[code,session]]);
    await storage.save(sessions);
    session.campaign = {contacts:[],history:[]};
    await storage.save(sessions);
    reopened = new SessionPersistence();
    const loaded = await reopened.load();
    assert.equal(loaded.get(code).contactBook.contacts.length,1);
    assert.equal(loaded.get(code).contactBook.preferences.pairingListAssignments.slot,"Prueba aislada");
    const history = await reopened.getCallAttempts(code);
    assert.equal(history.length,1);
    assert.equal(withProgress(loaded.get(code).contactBook,history).calledCounts.sample,1);
    const globalHistory = [...reopened.records.values()].map(entry=>entry.row);
    const anotherList = [{id:"another-session",list:"Otra lista",phone:"+51900000001"}];
    assert.equal(uncalledContacts(anotherList,globalHistory,new Date("2027-11-06T14:59:59Z")).length,0);
    const onlyTestHistory = [...reopened.records.values()].filter(entry=>entry.code===code).map(entry=>entry.row);
    assert.equal(uncalledContacts(anotherList,onlyTestHistory,new Date("2027-11-06T15:00:00Z")).length,1);
  } finally {
    if (reopened) await reopened.close();
    if (storage.pool) {
      // Only remove this test's random session and its synthetic rows.
      for (const table of ["vc_call_attempts","vc_call_contacts","vc_call_devices","vc_call_campaigns","vc_call_turns"]) {
        await storage.pool.query("DELETE FROM " + table + " WHERE session_code=?",[code]);
      }
      await storage.pool.query("DELETE FROM sessions WHERE id=?",[code]);
    }
    await storage.close();
  }
});
