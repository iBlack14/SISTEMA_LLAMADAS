import test from "node:test";
import assert from "node:assert/strict";
import { hydrateReportDetails } from "./report-details.js";
import { buildDetailedReport } from "../web/modules/detailed-report.js";

function fixture() {
 const contacts=Array.from({length:5},(_,i)=>({id:"c"+i,phone:"90000000"+i,pending:i>=3,
   technicalResult:i<3?"buzon_de_voz":"no_contactado"}));
 const history=contacts.map((c,i)=>({contactId:c.id,attemptId:"a"+i,phone:c.phone,workerId:"phone",
   workerName:"Xiaomi prueba",startedAt:"2026-11-11T23:30:00Z",endedAt:"2026-11-11T23:31:00Z",
   answeredAt:i<3?"2026-11-11T23:30:01Z":null,technicalResult:c.technicalResult,attemptNumber:1}));
 const known=new Map(history.map(c=>[c.attemptId,{...c,shiftLabel:"TURNO TARDE"}]));
 const hydrated=hydrateReportDetails({contacts,history},{phoneWorkers:[{id:"phone",name:"Nombre actual"}]},known);
 return { ...hydrated, rows:hydrated.contacts };
}
test("historical device and shift metadata reach rows and call history",()=>{
 const report=fixture();
 assert.equal(report.contacts[0].workerName,"Xiaomi prueba");
 assert.equal(report.contacts[0].attemptNumber,1);
 assert.equal(report.calls.length,5);
 assert.equal(report.teamShifts["Xiaomi prueba"],"TURNO TARDE");
});
test("five real attempts produce three mailboxes, two no answers and two pending contacts",()=>{
 const detailed=buildDetailedReport(fixture(),"Xiaomi prueba");
 assert.deepEqual(detailed.metrics,{calls:5,answered:0,noAnswer:2,voicemail:3,inoperable:0,pending:2});
 assert.equal(detailed.rows.length,1);
 assert.equal(detailed.rows[0].hour,"18:00–19:00");
 assert.equal(detailed.rows[0].designated,5);
 assert.equal(detailed.rows[0].pending,2);
});
test("pending-only mode retains the hour bucket of attempted pending contacts",()=>{
 const result=buildDetailedReport(fixture(),"Xiaomi prueba",true);
 assert.equal(result.rows.length,1);
 assert.equal(result.rows[0].pending,2);
});
test("repeated attempts count as calls without duplicating designated or pending contacts",()=>{
 const report=fixture();
 report.calls.push({...report.calls[4],attemptId:"retry",startedAt:"2026-11-12T00:30:00Z"});
 const result=buildDetailedReport(report,"Xiaomi prueba");
 assert.equal(result.metrics.calls,6);
 assert.equal(result.metrics.pending,2);
 assert.equal(result.rows.find(r=>r.hour==="19:00–20:00").pending,1);
 assert.ok(result.rows.every(r=>r.designated===5));
});
test("missing historical identity is never attributed to the currently connected device",()=>{
 const result=hydrateReportDetails({contacts:[{id:"a",phone:"900000001"}],history:[{contactId:"a",phone:"900000001",startedAt:"2026-11-11T23:30:00Z"}]},
  {phoneWorkers:[{id:"new",name:"Current phone"}]});
 assert.equal(result.calls[0].workerName,"");
 assert.equal(result.contacts[0].workerName,"");
});
