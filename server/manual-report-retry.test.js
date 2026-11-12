import test from "node:test";
import assert from "node:assert/strict";
import { selectPendingReportContacts } from "./report-selection.js";
import { excludeCalledPending, excludeBlockedPending } from "./contact-book.js";
import { startCampaign, assignNextContact, updateActiveCallState } from "./campaign-manager.js";

test("explicit manual selection can retry a mailbox or previously answered row", () => {
  for(const technicalResult of ["buzon_de_voz","contesto"]) {
    const report={rows:[{id:"a",phone:"900000001",pending:false,technicalResult}]};
    assert.equal(selectPendingReportContacts(report,["a"]).status,409);
    assert.equal(selectPendingReportContacts(report,["a"],{allowManualRetry:true}).contacts[0].id,"a");
  }
});
test("manual selection rejects invalid, inoperable and manually blocked rows", () => {
  for(const fields of [{technicalResult:"numero_inexistente"},{technicalResult:"numero_incorrecto"},{inoperable:true},{doNotCall:true},{manualBlocked:true}]) {
    const result=selectPendingReportContacts({rows:[{id:"a",phone:"900000001",pending:true,...fields}]},["a"],{allowManualRetry:true});
    assert.equal(result.status,409);
  }
});
test("manual retry bypasses the annual window only for selected ids and only one attempt", () => {
  const session={};
  startCampaign(session,[{id:"a",phone:"900000001"},{id:"b",phone:"900000002"}],{maxAttempts:1});
  session.campaign.manualReportRetry={contactIds:["a"],reportId:"old",requestedBy:1};
  const history=["900000001","900000002"].map(phone=>({phone,technicalResult:"buzon_de_voz",startedAt:"2026-01-01T00:00:00Z"}));
  excludeCalledPending(session.campaign,history,new Date("2026-11-11"));
  assert.equal(session.campaign.contacts[0].status,"pending");
  assert.equal(session.campaign.contacts[1].status,"failed");
  const worker={id:"phone"};
  const active=assignNextContact(session,worker);
  assert.equal(active.id,"a");
  updateActiveCallState(session,"ended",worker,{contactId:"a",callId:active.currentAttemptId});
  assert.equal(session.campaign.contacts.find(c=>c.id==="a").status,"failed");
  assert.equal(assignNextContact(session,worker),null);
  startCampaign(session,[{id:"a",phone:"900000001"}]);
  assert.equal(session.campaign.manualReportRetry,null);
  excludeCalledPending(session.campaign,history,new Date("2026-11-11"));
  assert.equal(assignNextContact(session,worker),null);
});
test("manual retries never bypass permanent or manual blocks", () => {
  const campaign={contacts:[{id:"a",phone:"+51 900000001",status:"pending"}],assignments:{},manualReportRetry:{contactIds:["a"]}};
  excludeCalledPending(campaign,[{phone:"900000001",technicalResult:"numero_inexistente",startedAt:"2026-01-01T00:00:00Z"}],new Date("2040-01-01"));
  assert.equal(campaign.contacts[0].doNotCall,true);
  const manual={contacts:[{id:"a",phone:"900000001",status:"pending"}],assignments:{},manualReportRetry:{contactIds:["a"]}};
  excludeBlockedPending(manual,[{phone:"+51 900000001"}]);
  assert.equal(manual.contacts[0].result,"numero_bloqueado");
});
