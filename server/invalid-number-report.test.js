import test from "node:test";
import assert from "node:assert/strict";
import { isInoperableAttempt, attemptResultLabel, summarizeAttempts } from "../web/modules/report-metrics.js";
import { annualPhoneBlocks, uncalledContacts, excludeCalledPending } from "./contact-book.js";
import { selectPendingReportContacts } from "./report-selection.js";

for (const technicalResult of ["numero_inexistente", "numero_incorrecto"]) {
  test(technicalResult + " is inoperable and blocked permanently across lists", () => {
    const row = { phone:"900000001", technicalResult, startedAt:"2026-01-01T00:00:00Z",
      answeredAt:"2026-01-01T00:00:01Z", endedAt:"2026-01-01T00:00:03Z" };
    const later=new Date("2040-01-01");
    assert.equal(isInoperableAttempt(row),true);
    assert.equal(attemptResultLabel(row),"INOPERABLE");
    assert.equal(summarizeAttempts([row]).inoperable,1);
    assert.equal(summarizeAttempts([row]).answered,0);
    assert.equal(annualPhoneBlocks([row],later).get("900000001").permanent,true);
    assert.deepEqual(uncalledContacts([{phone:"+51 900 000 001",list:"Other"}],[row],later),[]);
    const campaign={contacts:[{id:"copy",phone:"+51900000001",status:"pending"}],assignments:{}};
    excludeCalledPending(campaign,[row],later);
    assert.equal(campaign.contacts[0].doNotCall,true);
    assert.equal(selectPendingReportContacts({rows:[{id:"bad",phone:"900000001",pending:true,technicalResult}]},["bad"]).status,409);
  });
}

test("temporary service failures expire rather than becoming permanent invalid numbers", () => {
  assert.equal(annualPhoneBlocks([{phone:"900000001",technicalResult:"sin_servicio",startedAt:"2026-01-01T00:00:00Z"}],new Date("2040-01-01")).size,0);
});
