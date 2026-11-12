import test from "node:test";
import assert from "node:assert/strict";
import { annualPhoneBlocks, uncalledContacts, withProgress, normalizeBook, excludeBlockedPending } from "./contact-book.js";
import { startCampaign, assignNextContact, updateActiveCallState } from "./campaign-manager.js";

test("invalid number classification survives physical call end and remains blocked beyond one year", () => {
 const session = {};
 startCampaign(session,[{id:"one",phone:"900000001",list:"A"}],{});
 const worker = {id:"phone",name:"Test"};
 const contact = assignNextContact(session,worker);
 const attempt = contact.currentAttemptId;
 updateActiveCallState(session,"in_call",worker,{contactId:contact.id,callId:attempt,detectedAnnouncement:"numero_inexistente"});
 assert.equal(Object.keys(session.campaign.assignments).length,1);
 updateActiveCallState(session,"ended",worker,{contactId:contact.id,callId:attempt});
 const row = session.campaign.history[0];
 assert.equal(row.technicalResult,"numero_inexistente");
 const later = new Date("2040-01-01");
 assert.equal(annualPhoneBlocks([row],later).get("900000001").permanent,true);
 assert.equal(uncalledContacts([{phone:"+51900000001",list:"B"}],[row],later).length,0);
 const book = withProgress(normalizeBook({contacts:[{phone:"900000001"}]}),[],[row],later);
 assert.equal(book.contacts[0].doNotCall,true);
});

test("temporary service failures do not become permanent blocks", () => {
 const rows = [{phone:"900000001",startedAt:"2020-01-01T00:00:00Z",technicalResult:"sin_servicio"}];
 assert.equal(annualPhoneBlocks(rows,new Date("2040-01-01")).size,0);
});

test("manual blocks skip duplicates across lists without creating call attempts", () => {
 const session = {};
 startCampaign(session, [
  {id:"a", phone:"900000001", list:"A"},
  {id:"b", phone:"+51 900000001", list:"B"},
  {id:"c", phone:"900000002", list:"B"}
 ]);
 excludeBlockedPending(session.campaign, [{phone:"+51 900 000 001"}]);
 const next = assignNextContact(session, {id:"phone"});
 assert.equal(next.id, "c");
 for (const contact of session.campaign.contacts.slice(0,2)) {
  assert.equal(contact.result, "numero_bloqueado");
  assert.equal(contact.attempts, 0);
 }
});

test("blocking an active number preserves its assignment until Android confirms hangup", () => {
 const session = {};
 startCampaign(session, [{id:"a",phone:"900000001"},{id:"b",phone:"900000002"}]);
 const worker = {id:"phone"};
 const active = assignNextContact(session, worker);
 const callId = active.currentAttemptId;
 const blocked = [{phone:"900000001"}];
 excludeBlockedPending(session.campaign, blocked);
 assert.equal(active.status, "dialing");
 assert.equal(session.campaign.assignments.phone.contactId, "a");
 updateActiveCallState(session,"ended",worker,{contactId:"a",callId});
 excludeBlockedPending(session.campaign, blocked);
 assert.equal(assignNextContact(session, worker).id, "b");
 assert.equal(active.result, "numero_bloqueado");
});
