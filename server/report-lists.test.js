import test from "node:test";
import assert from "node:assert/strict";
import { splitReportByList } from "./report-lists.js";

test("the real list name replaces a generic campaign title, including archived reports", () => {
  const record={id:"run",rubro:"Asignación automática",contacts:[{id:"a",list:"TEST1",phone:"900000001"}],history:[{contactId:"a",phone:"900000001"}]};
  const before=structuredClone(record);
  const [report]=splitReportByList(record);
  assert.equal(report.rubro,"TEST1");
  assert.equal(report.id,"run");
  assert.equal(report.history.length,1);
  assert.deepEqual(record,before);
});
test("a mixed campaign is split into actual list names with its own contacts and attempts", () => {
  const record={id:"run",rubro:"Asignación automática",contacts:[
    {id:"a",list:"TEST1",phone:"900000001"},{id:"b",list:"22",phone:"900000002"}
  ],history:[{contactId:"a",phone:"900000001"},{contactId:"b",phone:"900000002"},{contactId:"b",phone:"900000002"}]};
  const result=splitReportByList(record);
  assert.deepEqual(result.map(r=>r.rubro),["TEST1","22"]);
  assert.deepEqual(result.map(r=>r.contacts.map(c=>c.id)),[["a"],["b"]]);
  assert.deepEqual(result.map(r=>r.history.length),[1,2]);
  assert.notEqual(result[0].id,result[1].id);
  assert.deepEqual(result.map(r=>r.id),splitReportByList(record).map(r=>r.id));
});
test("duplicate phone numbers in separate lists do not duplicate call history", () => {
  const result=splitReportByList({id:"run",contacts:[
    {id:"a",list:"A",phone:"900000001"},{id:"b",list:"B",phone:"+51 900000001"}
  ],history:[{contactId:"b",phone:"900000001"},{phone:"900000001"}]});
  assert.equal(result.find(r=>r.rubro==="A").history.length,0);
  assert.equal(result.find(r=>r.rubro==="B").history.length,1);
  assert.equal(result.find(r=>r.rubro==="Sin lista identificada").history.length,1);
  assert.equal(result.reduce((n,r)=>n+r.history.length,0),2);
});
test("legacy records without list metadata retain their original name", () => {
  assert.equal(splitReportByList({id:"old",rubro:"Comercios",contacts:[{id:"a"}],history:[]})[0].rubro,"Comercios");
});
