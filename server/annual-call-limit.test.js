import test from "node:test";
import assert from "node:assert/strict";
import { annualPhoneBlocks, uncalledContacts, excludeCalledPending, withProgress, normalizeBook } from "./contact-book.js";

const attempt = {phone:"+51 900000001",startedAt:"2026-11-06T18:30:00Z",technicalResult:"buzon_de_voz"};
test("same phone in another list or session is blocked until its exact yearly anniversary", () => {
  const before = new Date("2027-11-06T18:29:59Z");
  const contacts = [{id:"other",list:"B",phone:"900000001"},{id:"fresh",list:"A",phone:"900000002"}];
  assert.deepEqual(uncalledContacts(contacts,[attempt],before).map(row=>row.id),["fresh"]);
  assert.equal(annualPhoneBlocks([attempt],before).get("900000001").nextAllowedAt,"2027-11-06T18:30:00.000Z");
  assert.equal(uncalledContacts(contacts,[attempt],new Date("2027-11-06T18:30:00Z")).length,2);
});

test("January does not reset the limit, and the most recent attempt extends it", () => {
  const rows = [attempt,{...attempt,startedAt:"2026-12-01T12:00:00Z"}];
  assert.equal(annualPhoneBlocks(rows,new Date("2027-01-01T00:00:00Z")).get("900000001").nextAllowedAt,"2027-12-01T12:00:00.000Z");
});

test("leap-day anniversary expires February 28 of the following year", () => {
  const rows = [{...attempt,startedAt:"2024-02-29T15:00:00Z"}];
  assert.ok(annualPhoneBlocks(rows,new Date("2025-02-28T14:59:59Z")).has("900000001"));
  assert.equal(annualPhoneBlocks(rows,new Date("2025-02-28T15:00:00Z")).size,0);
});

test("omitted duplicate remains visible with reason, while an ongoing call is preserved", () => {
  const campaign = {assignments:{w:{contactId:"active"}},contacts:[
    {id:"duplicate",phone:"900000001",status:"pending"},
    {id:"active",phone:"900000001",status:"dialing"}
  ]};
  excludeCalledPending(campaign,[attempt],new Date("2027-01-01"));
  assert.equal(campaign.contacts[0].result,"numero_llamado_anteriormente");
  assert.equal(campaign.contacts[1].status,"dialing");
  const book = normalizeBook({contacts:[{id:"new",phone:"900000001",list:"Otra"}]});
  const displayed = withProgress(book,[],[attempt],new Date("2027-01-01"));
  assert.equal(displayed.contacts[0].callBlockReason,"Número llamado anteriormente");
  assert.equal(book.contacts[0].callBlockReason,undefined);
  assert.equal(withProgress(book,[],[attempt],new Date("2028-01-01")).contacts[0].callBlockedUntil,null);
});
