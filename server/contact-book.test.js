import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending } from "./contact-book.js";

test("import normalizes Peru prefixes, preserves empty lists and removes duplicates within a list", () => {
  const book = normalizeBook({lists:["Vacía"],contacts:[
    {id:"a",phone:"+51 924373977",list:"A",name:"Uno"},
    {id:"b",phone:"924373977",list:"A",name:"Repetido"},
    {id:"a",phone:"936613758",list:"B"}
  ]});
  assert.equal(book.contacts.length,2);
  assert.equal(new Set(book.contacts.map(x=>x.id)).size,2);
  assert.ok(book.lists.includes("Vacía"));
  assert.equal(book.contacts[0].phone,"924373977");
});

test("continuing a new turn skips any previously dialed phone across lists and new contact IDs", () => {
  const attempts = [{phone:"+51924373977",startedAt:"2026-11-06T12:00:00Z",technicalResult:"buzon_de_voz"}];
  const candidates = [
    {id:"new-id",phone:"924373977",list:"Otro rubro"},
    {id:"two",phone:"936613758",list:"A"},
    {id:"three",phone:"+51 936613758",list:"B"}
  ];
  assert.deepEqual(uncalledContacts(candidates,attempts,new Date("2026-11-07T00:00:00Z")).map(x=>x.id),["two"]);
});

test("resuming an old campaign skips called pending rows and preserves its ongoing call", () => {
  const campaign = {assignments:{worker:{contactId:"active"}},contacts:[
    {id:"old",phone:"900000001",status:"retry_pending"},
    {id:"active",phone:"900000002",status:"in_call"},
    {id:"new",phone:"900000003",status:"pending"}
  ]};
  excludeCalledPending(campaign,[
    {phone:"+51900000001",startedAt:"2026-11-06T12:00:00Z"},
    {phone:"900000002",startedAt:"2026-11-06T12:00:00Z"}
  ],new Date("2026-11-07T00:00:00Z"));
  assert.deepEqual(campaign.contacts.map(x=>x.status),["failed","in_call","pending"]);
});

test("progress comes from history even after deleting and reimporting a list", () => {
  const book = normalizeBook({contacts:[{id:"reimported",phone:"924373977"}],calledCounts:{}});
  const enriched = withProgress(book,[
    {phone:"924373977",durationSeconds:12,technicalResult:"contesto"},
    {phone:"+51924373977",durationSeconds:0,technicalResult:"buzon_de_voz"}
  ]);
  assert.equal(enriched.calledCounts.reimported,2);
  assert.equal(enriched.callDurations.reimported,12);
  assert.equal(enriched.contactRowStatus.reimported,"buzon_de_voz");
  assert.equal(book.calledCounts.reimported,undefined);
});
