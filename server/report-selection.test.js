import test from "node:test";
import assert from "node:assert/strict";
import { selectPendingReportContacts } from "./report-selection.js";
const report = { rows: [
  {id:"a",phone:"900000001",name:"A",pending:true},
  {id:"b",phone:"900000002",name:"B",pending:true},
  {id:"v",phone:"900000003",pending:false,technicalResult:"buzon_de_voz"}
]};
test("only the selected pending row is queued", () => {
  assert.deepEqual(selectPendingReportContacts(report, ["b"]).contacts.map(x=>x.id), ["b"]);
});
test("an absent or empty selection never defaults to all pending rows", () => {
  for (const ids of [undefined, null, [], "a", [null]]) {
    assert.equal(selectPendingReportContacts(report, ids).status, 400);
  }
});
test("foreign report ids and voicemail rows cannot be selected", () => {
  for (const ids of [["outside"], ["v"], ["a","outside"]]) {
    const result=selectPendingReportContacts(report,ids);
    assert.equal(result.status,409);
    assert.deepEqual(result.contacts,[]);
  }
});
test("duplicate ids and phone formats are queued only once", () => {
  const input={rows:[...report.rows,{id:"copy",phone:"+51 900 000 001",pending:true}]};
  const result=selectPendingReportContacts(input,["a","a","copy"]);
  assert.equal(result.contacts.length,1);
  assert.equal(result.contacts[0].phone,"900000001");
});
test("stale pending flags cannot select answered or mailbox rows", () => {
  for (const row of [{answered:true},{technicalResult:"buzon_de_voz"},{inoperable:true}]) {
    assert.equal(selectPendingReportContacts({rows:[{id:"a",phone:"900000001",pending:true,...row}]},["a"]).status,409);
  }
});
